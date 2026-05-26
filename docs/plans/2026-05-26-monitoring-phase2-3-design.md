# 监控功能第二三期详细设计

> 日期：2026-05-26
> 状态：设计完成，待实现
> 前置：第一期已部署（批量巡检 + 异常面板 + 资源水位 + Dashboard badge）
> 设计决策依据：brainstorming 对话确认

## 第二期：可配置告警规则 + 自动修复

### 1. 数据模型

#### alert_rules 表（告警规则）

```sql
CREATE TABLE alert_rules (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    enabled BOOLEAN DEFAULT true,
    -- 触发条件
    anomaly_type VARCHAR(50) NOT NULL,        -- 匹配 inspection_anomalies.anomaly_type
    severity_filter VARCHAR(20)[] DEFAULT '{}', -- 空=匹配所有级别
    agent_numbers INTEGER[] DEFAULT '{}',       -- 空=所有 agent
    -- 动作
    action VARCHAR(20) NOT NULL,              -- 'alert' | 'restart_pod' | 'scale_resources'
    cooldown_seconds INTEGER DEFAULT 600,     -- 同一规则同一 agent 冷却期
    -- 扩容专用
    scale_cpu_millicores INTEGER,             -- 扩容后 CPU limit
    scale_memory_mb INTEGER,                  -- 扩容后 MEM limit
    -- 审计
    created_by VARCHAR(100) DEFAULT 'admin',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### alert_records 表（告警触发记录，90 天保留）

```sql
CREATE TABLE alert_records (
    id BIGSERIAL PRIMARY KEY,
    rule_id INTEGER REFERENCES alert_rules(id),
    anomaly_id INTEGER REFERENCES inspection_anomalies(id),
    agent_number INTEGER NOT NULL,
    action_taken VARCHAR(20) NOT NULL,         -- 'alert' | 'restart_pod' | 'scale_resources' | 'skipped_cooldown' | 'skipped_disabled'
    action_result JSONB DEFAULT '{}',          -- 执行结果（success/error/detail）
    triggered_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ix_alert_records_rule ON alert_records (rule_id);
CREATE INDEX ix_alert_records_triggered ON alert_records (triggered_at DESC);
CREATE INDEX ix_alert_records_agent ON alert_records (agent_number, triggered_at DESC);
```

### 2. 后端架构

#### 新建文件

| 文件 | 用途 |
|------|------|
| `admin/backend/alert_engine.py` | 规则评估引擎 + 修复动作执行器 |

#### 修改文件

| 文件 | 变更 |
|------|------|
| `db_models.py` | 新增 AlertRule + AlertRecord ORM 模型 |
| `models.py` | 新增 Pydantic schema（AlertRuleCreate/Update/Response, AlertRecordResponse） |
| `database.py` | _MIGRATION_SQL 追加建表；_CLEANUP_SQL 追加 90 天 alert_records 清理 |
| `inspection.py` | run_batch() 末尾调用 AlertEngine.evaluate_rules() |
| `monitor_routes.py` | 新增 5 个端点：alert-rules CRUD + alert-records 查询 |
| `main.py` | 无需修改（alert_engine 被 inspection.py 调用） |

#### AlertEngine 类设计

```
AlertEngine
├── evaluate_rules(anomalies)    # 在 run_batch() 末尾调用
│   ├── 加载所有 enabled 的 alert_rules
│   ├── 对每条 active anomaly 匹配规则
│   │   ├── 匹配 anomaly_type
│   │   ├── 匹配 severity_filter（空=全部）
│   │   └── 匹配 agent_numbers（空=全部）
│   ├── 检查 cooldown（查 alert_records 最近记录）
│   └── 执行动作
│       ├── alert: 仅写 alert_records
│       ├── restart_pod: k8s_client.delete_pod() + 写 alert_records
│       └── scale_resources: k8s_client.patch_deployment() + 写 alert_records
├── execute_restart(agent_number)   # 删 pod 触发 deployment 重建
├── execute_scale(agent_number, cpu, mem)  # patch deployment spec
└── check_cooldown(rule_id, agent_number)  # 查最近 alert_records
```

#### API 端点

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/monitor/alert-rules` | 列出所有规则 |
| POST | `/monitor/alert-rules` | 创建规则 |
| PUT | `/monitor/alert-rules/{id}` | 更新规则 |
| DELETE | `/monitor/alert-rules/{id}` | 删除规则 |
| GET | `/monitor/alert-records` | 告警记录列表（分页，支持 agent/rule/time 过滤） |

#### 审计机制

- 每次规则触发都写 `alert_records`，包括被 cooldown 跳过的（`action_taken='skipped_cooldown'`）
- `restart_pod` 和 `scale_resources` 执行前先写 `alert_records(action_taken='executing')`，执行后更新 `action_result`
- 执行失败不重试，但 `action_result` 记录完整错误信息

#### 调用链路

```
inspection.py run_batch()
  └── _resolve_old_anomalies()  → 返回新产生的 active anomalies
  └── AlertEngine.evaluate_rules(new_anomalies)
  └── _maybe_cleanup()          → 顺带清理 90 天 alert_records
```

### 3. 前端设计

#### 新建文件

| 文件 | 用途 |
|------|------|
| `components/monitoring/AlertRulesTab.tsx` | 告警规则管理（CRUD 表格 + 启用/禁用开关） |
| `components/monitoring/AlertRecordsTab.tsx` | 告警记录列表（分页 + 过滤） |

#### 修改文件

| 文件 | 变更 |
|------|------|
| `pages/MonitoringPage.tsx` | 新增 2 个 tab：Alert Rules / Alert Records，共 6 个 tab |
| `admin-api.ts` | 新增 AlertRule、AlertRecord 类型 + 5 个 API 方法 |
| `i18n/en.ts` + `zh.ts` | 新增 `alert*` 翻译 key |

#### AlertRulesTab 布局

```
┌──────────────────────────────────────────────────────────┐
│ 告警规则管理                              [+ 新建规则]     │
├──────────────────────────────────────────────────────────┤
│ 名称       | 异常类型     | 动作       | 冷却期 | 启用   │
│------------|-------------|------------|--------|--------│
│ 高CPU重启  | high_cpu    | 重启Pod    | 10min  | [ON]   │
│ 内存扩容   | high_memory | 扩容资源   | 30min  | [ON]   │
│ 下线告警   | health_down | 仅告警     | 5min   | [OFF]  │
└──────────────────────────────────────────────────────────┘

新建/编辑对话框:
┌──────────────────────────────────────┐
│ 规则名称: [___________________]      │
│ 匹配异常类型: [high_cpu ▼]           │
│ 严重级别: ☐ critical ☐ warning ☐ info│
│ 目标 Agent: ☐ 全部 ☐ 指定 [1,2,3]   │
│ 动作: [重启Pod ▼]                    │
│ 冷却期: [600] 秒                     │
│ ── 扩容专用 ──                       │
│ CPU limit (millicores): [2000]       │
│ Memory limit (MB): [2048]            │
│               [取消] [保存]           │
└──────────────────────────────────────┘
```

#### AlertRecordsTab 布局

```
┌──────────────────────────────────────────────────────────┐
│ 告警记录                                                  │
│ 过滤: [全部Agent ▼] [全部规则 ▼] [最近24h ▼]              │
├──────────────────────────────────────────────────────────┤
│ 时间       | Agent  | 规则       | 动作      | 结果       │
│------------|--------|-----------|-----------|------------│
│ 10:23:15   | #3     | 高CPU重启  | 重启Pod   | ✅ 成功     │
│ 10:13:02   | #3     | 高CPU重启  | 冷却跳过  | ⏭ 跳过     │
│ 09:45:11   | #5     | 内存扩容   | 扩容资源  | ✅ 成功     │
│ 09:40:08   | #1     | 下线告警   | 仅告警    | 🔔 已记录   │
├──────────────────────────────────────────────────────────┤
│              < 上一页  第 1/3 页  下一页 >                 │
└──────────────────────────────────────────────────────────┘
```

---

## 第三期：跨 Agent 日志搜索 + 导出

### 4. 数据模型

#### log_entries 表（结构化日志，可配置保留天数，默认 7 天）

```sql
CREATE TABLE log_entries (
    id BIGSERIAL PRIMARY KEY,
    batch_id UUID NOT NULL DEFAULT gen_random_uuid(),
    agent_number INTEGER NOT NULL,
    pod_name VARCHAR(200) NOT NULL,
    line_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    level VARCHAR(10),                     -- INFO/WARN/ERROR/DEBUG（启发式提取）
    is_error BOOLEAN DEFAULT false,        -- 是否错误行
    collected_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ix_logs_agent_collected ON log_entries (agent_number, collected_at DESC);
CREATE INDEX ix_logs_batch ON log_entries (batch_id);
CREATE INDEX ix_logs_error ON log_entries (is_error, collected_at DESC) WHERE is_error = true;
-- 全文搜索索引
CREATE INDEX ix_logs_content_fts ON log_entries USING gin(to_tsvector('simple', content));
```

### 5. 后端架构

#### 新建文件

| 文件 | 用途 |
|------|------|
| `admin/backend/log_collector.py` | 日志收集 + 搜索引擎 |

#### 修改文件

| 文件 | 变更 |
|------|------|
| `db_models.py` | 新增 LogEntry ORM 模型 |
| `models.py` | 新增 Pydantic schema（LogSearchRequest, LogEntryResponse, LogStats） |
| `database.py` | _MIGRATION_SQL 追加建表；_CLEANUP_SQL 追加日志清理 |
| `monitor_routes.py` | 新增 3 个端点：logs/search、logs/export、logs/stats |
| `main.py` | startup 注册 LogCollector 后台任务 |

#### LogCollector 类设计

```
LogCollector
├── run_periodic()                # 每 30s 收集一次（可配置 LOG_COLLECT_INTERVAL_SECONDS）
│   ├── _discover_running_agents()
│   ├── asyncio.gather(           # Semaphore(3)
│   │     _collect_one(agent)     # 并行收集
│   │       ├── k8s.read_namespaced_pod_log(tail_lines=500)
│   │       ├── _parse_lines()    # 提取 level、去重
│   │       └── _persist_lines()  # 批量 INSERT
│   │   )
│   └── _maybe_cleanup()          # 清理过期日志（可配置 LOG_RETENTION_DAYS）
├── search(params)                # 搜索接口
│   ├── SQL: agent_number + 时间范围 + 关键词 + level
│   ├── PostgreSQL to_tsvector 全文搜索
│   └── 返回分页结果
└── export(params)                # 导出接口
    └── 生成 CSV/JSON 文件到 /tmp，返回下载路径
```

**设计要点：**
- **增量收集**：每次只取 pod 日志最新 500 行，与上次 batch 对比去重（按行号+内容 hash）
- **level 提取**：启发式匹配 `ERROR`/`WARN`/`INFO`/`DEBUG` 等常见日志前缀，无匹配则为 null
- **is_error 标记**：包含 `Error`/`Exception`/`Traceback`/`CRITICAL` 关键词的行自动标记
- **全文搜索**：PostgreSQL `to_tsvector('simple', content)` + GIN 索引，支持中英文
- **保留策略**：可配置 `LOG_RETENTION_DAYS`（默认 7 天），在 `_maybe_cleanup` 中清理

#### API 端点

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/monitor/logs/search` | 搜索日志（body: agents, keywords, level, time_range, page, page_size） |
| GET | `/monitor/logs/export/{batch_id}` | 下载导出文件 |
| GET | `/monitor/logs/stats` | 日志统计（各 agent 错误数、最新收集时间） |

### 6. 前端设计

#### 新建文件

| 文件 | 用途 |
|------|------|
| `components/monitoring/LogSearchTab.tsx` | 搜索界面（过滤 + 结果 + 分页） |
| `components/monitoring/LogExportButton.tsx` | 导出按钮（下载 CSV/JSON） |

#### 修改文件

| 文件 | 变更 |
|------|------|
| `pages/MonitoringPage.tsx` | 新增 Logs tab，共 7 个 tab |
| `admin-api.ts` | 新增 LogSearchRequest、LogEntry、LogStats 类型 + 3 个 API 方法 |
| `i18n/en.ts` + `zh.ts` | 新增 `log*` 翻译 key |

#### LogSearchTab 布局

```
┌──────────────────────────────────────────────────────────┐
│ 日志搜索                                                  │
├──────────────────────────────────────────────────────────┤
│ ┌─ 搜索条件 ─────────────────────────────────────────┐   │
│ │ 关键词: [___________________]                       │   │
│ │ Agent: [全部 ▼]  级别: [全部 ▼]  时间: [最近1h ▼]  │   │
│ │                                     [搜索] [导出]  │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ ┌─ 搜索结果 (328 条，耗时 23ms) ──────────────────────┐  │
│ │ Agent #3 · hermes-gateway-3 · 10:23:15            │   │
│ │ [ERROR] ConnectionRefusedError: upstream timeout   │   │
│ │   at HttpClient.request (http_client.py:142)       │   │
│ │                                                    │   │
│ │ Agent #3 · hermes-gateway-3 · 10:23:14            │   │
│ │ [WARN] Retry attempt 3/5 for gateway-7             │   │
│ │                                                    │   │
│ │ Agent #5 · hermes-gateway-5 · 10:22:58            │   │
│ │ [ERROR] OOMKilled — container exceeded memory      │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│              < 上一页  第 1/17 页  下一页 >                │
└──────────────────────────────────────────────────────────┘
```

**交互细节：**
- 搜索按钮触发 `POST /monitor/logs/search`，结果高亮关键词（黄色背景）
- ERROR 行红色背景，WARN 行黄色背景，INFO 行默认
- 导出按钮触发搜索 → 生成文件 → 自动下载
- 时间范围快捷选项：最近 1h / 6h / 24h / 7d / 自定义
- Agent 过滤：多选下拉，默认全部
- 级别过滤：ERROR / WARN / INFO / ALL
- 空结果：显示"未找到匹配的日志条目"

---

## 数据流总览

### 第二期数据流

```
inspection.py run_batch()
  └── 产生 anomalies
  └── AlertEngine.evaluate_rules(anomalies)
        ├── 匹配 alert_rules
        ├── check_cooldown (查 alert_records)
        ├── execute_restart / execute_scale
        └── 写 alert_records

前端（30s 轮询）
  ├── GET /monitor/alert-rules     → 规则 CRUD
  ├── GET /monitor/alert-records   → 告警记录 + 过滤
  └── PUT /monitor/alert-rules/{id} → 启用/禁用/编辑
```

### 第三期数据流

```
log_collector.py run_periodic()
  └── 每 30s 收集所有 agent 的 pod 日志
  └── 增量去重 + 批量写入 log_entries
  └── _maybe_cleanup 清理过期日志

前端（按需搜索）
  ├── POST /monitor/logs/search    → 全文搜索 + 分页
  ├── GET /monitor/logs/export     → 下载导出
  └── GET /monitor/logs/stats      → 错误统计概览
```

---

## MonitoringPage 最终 Tab 结构（7 tabs）

```
[Overview] [Anomaly] [Resources] [Inspection] [Alert Rules] [Alert Records] [Logs]
```

## 构建序列

### 第二期（按顺序）

#### 后端
1. `db_models.py` — 新增 AlertRule + AlertRecord ORM 模型
2. `models.py` — 新增 Pydantic schema
3. `database.py` — migration SQL + cleanup SQL
4. `alert_engine.py` — 规则评估 + 修复执行
5. `monitor_routes.py` — 新增 5 个端点
6. `inspection.py` — run_batch() 末尾调用 AlertEngine

#### 前端
1. `i18n/en.ts` + `zh.ts` — alert* 翻译 key
2. `admin-api.ts` — 类型 + API 方法
3. `components/monitoring/AlertRulesTab.tsx`
4. `components/monitoring/AlertRecordsTab.tsx`
5. `pages/MonitoringPage.tsx` — 新增 2 个 tab

### 第三期（按顺序）

#### 后端
1. `db_models.py` — 新增 LogEntry ORM 模型
2. `models.py` — 新增 Pydantic schema
3. `database.py` — migration SQL + cleanup SQL
4. `log_collector.py` — 日志收集 + 搜索
5. `monitor_routes.py` — 新增 3 个端点
6. `main.py` — startup 注册 LogCollector

#### 前端
1. `i18n/en.ts` + `zh.ts` — log* 翻译 key
2. `admin-api.ts` — 类型 + API 方法
3. `components/monitoring/LogSearchTab.tsx`
4. `components/monitoring/LogExportButton.tsx`
5. `pages/MonitoringPage.tsx` — 新增 Logs tab
