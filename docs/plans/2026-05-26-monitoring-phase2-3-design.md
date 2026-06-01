# 监控功能第二三期详细设计

> 日期：2026-05-26
> 状态：设计完成（已整合专家评审），待实现
> 前置：第一期已部署（批量巡检 + 异常面板 + 资源水位 + Dashboard badge）
> 设计决策依据：brainstorming 对话确认 + 三方专家评审（后端架构/前端架构/安全+K8s）
> 评审修订记录：见文末附录

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
    -- 扩容专用（有 ceiling 限制，见后端约束）
    scale_cpu_millicores INTEGER,             -- 扩容后 CPU limit（上限 4000 = 4 cores）
    scale_memory_mb INTEGER,                  -- 扩容后 MEM limit（上限 8192 = 8 GB）
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
├── evaluate_rules(anomalies)    # 在 run_batch() 末尾调用（try/except 包裹，失败不影响巡检）
│   ├── 加载所有 enabled 的 alert_rules
│   ├── 对每条 active anomaly 匹配规则
│   │   ├── 匹配 anomaly_type
│   │   ├── 匹配 severity_filter（空=全部）
│   │   └── 匹配 agent_numbers（空=全部）
│   ├── Per-agent dedup：同一 agent 多条规则命中时，只执行优先级最高的动作
│   │   优先级：restart_pod > scale_resources > alert
│   ├── 全局限流：MAX_CONCURRENT_AUTO_ACTIONS=2（同时只执行 2 个自动动作）
│   ├── 检查 cooldown（查 alert_records 最近记录）
│   ├── 检查 restart 速率限制：per-agent 最近 30min 内最多 3 次重启
│   └── 执行动作
│       ├── alert: 仅写 alert_records
│       ├── restart_pod: annotation patch（不删 pod）+ 写 alert_records
│       └── scale_resources: patch deployment spec + 写 alert_records
├── execute_restart(agent_number)   # annotation patch 触发 pod 重建（与 agent_manager 一致）
├── execute_scale(agent_number, cpu, mem)  # patch deployment spec（ceiling ≤ 4 cores / 8 GB）
├── check_cooldown(rule_id, agent_number)  # 查最近 alert_records
└── _sanitize_log(text)             # 脱敏：过滤 API key、token 等敏感模式再写入记录
```

**关键设计约束：**
- `evaluate_rules()` 整体用 try/except 包裹，异常只记日志，不中断 `run_batch()`
- `execute_restart` 使用 annotation patch（`kubectl.kubernetes.io/restartedAt`），而非 `delete_pod`，与现有 `agent_manager.update_resources()` 模式一致，无需额外 RBAC delete 权限
- 扩容参数验证 ceiling：CPU ≤ 4000 millicores（4 cores），MEM ≤ 8192 MB（8 GB）
- 全局并发限制 `MAX_CONCURRENT_AUTO_ACTIONS=2`，防止爆炸性连锁重启
- Per-agent 速率限制：30 分钟内同一 agent 最多执行 3 次重启动作，防止 crash loop + auto-restart 无限循环

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
  └── try: AlertEngine.evaluate_rules(new_anomalies)
      except: logger.warning("alert engine failed", exc_info=True)
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
| `pages/MonitoringPage.tsx` | 新增 Alerts 子 tab 组（Rules + Records），共 6 个 tab（4 主 + 2 子） |
| `admin-api.ts` | 新增 AlertRule、AlertRecord 类型 + 5 个 API 方法 |
| `i18n/en.ts` + `zh.ts` | 新增 `alert*` 翻译 key |

#### AlertRulesTab 布局

> **评审修改**：Agent 选择改为 Checkbox Group（☐ 全部 / ☐ 指定 agents），指定时用 Tag Input 模式而非自由文本。扩容参数增加上限提示。

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
│ CPU limit (millicores): [2000] max 4000│
│ Memory limit (MB): [2048] max 8192    │
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
    content_hash VARCHAR(64) NOT NULL,     -- 内容 SHA256 前 16 字符，用于增量去重
    content TEXT NOT NULL,
    level VARCHAR(10),                     -- INFO/WARN/ERROR/DEBUG（启发式提取）
    is_error BOOLEAN DEFAULT false,        -- 是否错误行
    collected_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ix_logs_agent_collected ON log_entries (agent_number, collected_at DESC);
CREATE INDEX ix_logs_batch ON log_entries (batch_id);
CREATE INDEX ix_logs_error ON log_entries (is_error, collected_at DESC) WHERE is_error = true;
-- 模糊搜索索引（支持中英文）
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX ix_logs_content_trgm ON log_entries USING gin(content gin_trgm_ops);
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
│   │       ├── k8s.read_namespaced_pod_log(since_seconds=last_collected_timestamp)
│   │       ├── _parse_lines()    # 提取 level、计算 content_hash
│   │       ├── _dedup_lines()    # 按 content_hash 去重（对比最近 batch）
│   │       └── _persist_lines()  # 批量 INSERT（仅新行）
│   │   )
│   └── _maybe_cleanup()          # 清理过期日志（可配置 LOG_RETENTION_DAYS）
├── search(params)                # 搜索接口
│   ├── SQL: agent_number + 时间范围 + 关键词 + level
│   ├── pg_trgm + ILIKE 模糊搜索（支持中英文）
│   └── 返回分页结果
├── export(params)                # 导出接口
│   └── 生成 CSV/JSON 文件到 /tmp，返回下载路径
└── _sanitize_content(text)       # 日志脱敏：过滤 API key、token 等敏感模式再入库
```

**设计要点：**
- **增量收集**：使用 `since_seconds` 参数只取上次收集之后的新日志，按 `content_hash`（SHA256 前 16 字符）去重，不依赖 `line_number`（pod 重启后行号重置）
- **level 提取**：启发式匹配 `ERROR`/`WARN`/`INFO`/`DEBUG` 等常见日志前缀，无匹配则为 null
- **is_error 标记**：包含 `Error`/`Exception`/`Traceback`/`CRITICAL` 关键词的行自动标记
- **模糊搜索**：PostgreSQL `pg_trgm` + GIN 索引 + `ILIKE`，支持中英文模糊匹配（比 `to_tsvector('simple')` 中文支持更好）
- **保留策略**：可配置 `LOG_RETENTION_DAYS`（默认 7 天），在 `_maybe_cleanup` 中清理；清理独立于 inspection schedule
- **日志脱敏**：`_sanitize_content()` 过滤常见敏感模式（`sk-`、`key=`、`token=`、`Bearer `）再入库

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
| `pages/MonitoringPage.tsx` | 新增 Logs tab + Alerts 子 tab 组，共 5 主 + 2 子 tab |
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
- 搜索按钮触发 `POST /monitor/logs/search`，结果高亮关键词用 React JSX `<mark>` 组件实现（禁止 `dangerouslySetInnerHTML`，防 XSS）
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

## MonitoringPage 最终 Tab 结构（5 主 tab + 2 子 tab）

```
[Overview] [Anomaly] [Resources] [Inspection] [Alerts ▾] [Logs]
                                              ├─ Rules
                                              └─ Records
```

> **评审修改**：7 个 tab 在窄屏溢出，Alert Rules + Alert Records 合并为 Alerts 子 tab 组，主 tab bar 加 `overflow-x-auto` 兜底。

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
5. `pages/MonitoringPage.tsx` — 新增 Alerts 子 tab 组（Rules + Records）

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

---

## 附录：专家评审修订记录

> 三方评审：后端架构专家、前端架构专家、安全+K8s 专家
> 以下问题已整合到正文设计中

### CRITICAL 修复

| # | 问题 | 修复方案 | 影响章节 |
|---|------|---------|---------|
| C1 | `restart_pod` 用 `delete_pod()` 但 RBAC 无 delete 权限 | 改用 annotation patch 模式，与 `agent_manager` 一致 | §2 AlertEngine |

### HIGH 修复

| # | 问题 | 修复方案 | 影响章节 |
|---|------|---------|---------|
| H1 | `evaluate_rules()` 异常中断 `run_batch()` | try/except 包裹，失败只记日志 | §2 调用链路 |
| H2 | 多规则匹配同一 agent 触发重复重启 | Per-agent dedup，只执行最高优先级动作 | §2 AlertEngine |
| H3 | `line_number` 去重不可靠（pod 重启行号重置） | 改用 `since_seconds` + `content_hash` 去重 | §4 log_entries |
| H4 | `to_tsvector('simple')` 不支持中文 | 改用 `pg_trgm` + `ILIKE` | §4 log_entries, §5 LogCollector |
| H5 | 7 个 tab 窄屏溢出 | Alert Rules+Records 合为 Alerts 子 tab 组，tab bar 加 `overflow-x-auto` | §3, §6, Tab 结构 |
| H6 | 关键词高亮用 `dangerouslySetInnerHTML` 有 XSS 风险 | 改用 React JSX `<mark>` 组件 | §6 交互细节 |
| H7 | 无爆炸半径限制 | `MAX_CONCURRENT_AUTO_ACTIONS=2` 全局限流 | §2 AlertEngine |
| H8 | 扩容无上限 | CPU ≤ 4 cores, MEM ≤ 8GB ceiling | §1 alert_rules, §2 AlertEngine |

### MEDIUM 修复

| # | 问题 | 修复方案 | 影响章节 |
|---|------|---------|---------|
| M1 | crash loop + auto-restart 无限循环 | Per-agent 30min 内最多 3 次重启 | §2 AlertEngine |
| M2 | 日志含 secrets（API key 等） | `_sanitize_content()` 过滤敏感模式 | §5 LogCollector |
| M3 | `alert_records` 清理依赖 inspection schedule | 独立定时清理（备注） | §2 调用链路 |
| M4 | Agent 选择交互不明确 | Checkbox Group + Tag Input 模式 | §3 AlertRulesTab |
