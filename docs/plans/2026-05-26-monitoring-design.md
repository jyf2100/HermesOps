# 服务和集群监控设计文档

> 日期：2026-05-26
> 状态：设计评审（已整合三方评审意见）
> 范围：Admin 面板扩展，不引入新服务
> 评审人：后端架构师、前端架构师、安全+运维专家

## 背景与目标

### 核心痛点
1. **及时发现问题** — agent 挂了、资源打满、OOM 等异常无法第一时间感知
2. **日常运维效率** — 批量巡检、资源调整、日志分析操作不够便捷

### 现有能力

已有 API（可复用，无需重写）：
- `GET /agents/{id}/health` — 代理 gateway /health 端点
- `GET /agents/{id}/resources` — CPU/内存规格
- `GET /agents/{id}/events` — K8s events
- `GET /agents/{id}/logs` — SSE 实时日志流
- `GET /cluster/status` — 节点 CPU/内存/磁盘使用率

已有前端：
- Dashboard 每日 10s 刷新 agent 列表 + ClusterStatusBar
- Agent Detail 页面有 Health/Logs/Events/Config/Terminal tabs
- `ResourceDataPoint` 类型已定义但未使用
- `GaugeChart` 组件已存在但未使用

### 缺失
- 无时序数据存储（所有资源数据是即时的）
- 无主动巡检（health 仅按需手动触发）
- 无异常检测和告警
- 无批量操作入口

---

## 架构决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 存储 | PostgreSQL（现有） | 不引入新依赖；已有 asyncpg + SQLAlchemy |
| 后台任务 | asyncio.create_task（现有模式） | main.py 已有 3 个后台任务用此模式 |
| 巡检模块 | 独立 inspection.py | agent_manager.py 已 1165 行，不继续膨胀 |
| 路由模块 | 独立 monitor_routes.py | 与 dispatch_routes.py、profile_routes.py 模式一致 |
| 数据库迁移 | `_MIGRATION_SQL` 幂等 SQL | 复用现有模式，无需引入 Alembic |
| 前端图表 | 纯 CSS 进度条 | 不引入图表库依赖，与现有 ClusterStatusBar 一致 |
| 巡检间隔 | 可配置（默认 60s） | 环境变量 `INSPECTION_INTERVAL_SECONDS`，适应不同规模 |
| 批量 metrics | 一次获取所有 pod 指标 | 用 `GET /apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods` 替代逐个查询 |
| 认证 | 所有 `/monitor/*` 端点 `admin_only` | 集群级数据不应对 user-mode 暴露 |
| 前端轮询 | 30s + `visibilityState` 暂停 | 与 60s 巡检周期对齐，tab 不可见时暂停 |

---

## 分期计划

### 第一期：批量巡检 + 异常面板
- 后台 60s 定时巡检所有 agent（health + pod 状态 + 资源用量）
- 异常自动检测和持久化
- 前端监控页面（/monitoring）
- Dashboard 异常 badge

### 第二期：自动修复 + 告警规则
- 可配置告警规则（阈值 + 动作）
- 自动重启 / 扩容 / 仅告警
- 告警确认/忽略操作

### 第三期：高级日志分析
- 跨 agent 日志搜索
- 时间范围 + 关键词过滤
- 结果导出

---

## 第一期详细设计

### 1. 后端 — 数据模型

#### inspection_snapshots 表（每次巡检的全量快照，7 天保留）

```sql
CREATE TABLE IF NOT EXISTS inspection_snapshots (
    id BIGSERIAL PRIMARY KEY,
    batch_id UUID NOT NULL DEFAULT gen_random_uuid(),
    agent_number INTEGER NOT NULL,
    health_ok BOOLEAN,
    health_latency_ms FLOAT,
    pod_phase VARCHAR(20),
    pod_restart_count INTEGER DEFAULT 0,
    cpu_cores FLOAT,
    cpu_limit_cores FLOAT,
    memory_bytes BIGINT,
    memory_limit_bytes BIGINT,
    cpu_usage_pct FLOAT,
    memory_usage_pct FLOAT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_snapshot_agent_batch ON inspection_snapshots (agent_number, batch_id);
CREATE INDEX IF NOT EXISTS ix_snapshot_created ON inspection_snapshots (created_at);
CREATE INDEX IF NOT EXISTS ix_snapshot_agent_created ON inspection_snapshots (agent_number, created_at DESC);
```

#### inspection_anomalies 表（异常记录，90 天保留）

```sql
CREATE TABLE IF NOT EXISTS inspection_anomalies (
    id BIGSERIAL PRIMARY KEY,
    agent_number INTEGER NOT NULL,
    anomaly_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    title VARCHAR(200) NOT NULL,
    detail JSONB DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'active',
    snapshot_id BIGINT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT ck_anomaly_severity CHECK (severity IN ('critical', 'warning', 'info')),
    CONSTRAINT ck_anomaly_status CHECK (status IN ('active', 'acknowledged', 'ignored', 'resolved'))
);
CREATE INDEX IF NOT EXISTS ix_anomaly_status_created ON inspection_anomalies (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_anomaly_agent ON inspection_anomalies (agent_number);
-- 部分唯一索引：防止同一 agent 同一类型存在多条 active 异常
CREATE UNIQUE INDEX IF NOT EXISTS ix_anomaly_active_unique
    ON inspection_anomalies (agent_number, anomaly_type) WHERE status = 'active';
```

> **设计注**：`snapshot_id` 不设外键，因为 snapshot 保留 7 天而 anomaly 保留 90 天，FK 会阻止快照删除。`detail` JSONB 字段必须通过 SQLAlchemy ORM 写入，严禁字符串拼接。`batch_id` 使用 PostgreSQL 原生 UUID 类型（16 字节），而非 VARCHAR(36)。

### 2. 后端 — 文件组织

#### 新建文件

| 文件 | 用途 |
|------|------|
| `admin/backend/inspection.py` | 巡检引擎：InspectionRunner 类 |
| `admin/backend/monitor_routes.py` | 监控 API 路由（prefix=/monitor） |

#### 修改文件

| 文件 | 变更 |
|------|------|
| `db_models.py` | 新增 InspectionSnapshot + InspectionAnomaly ORM 模型 |
| `models.py` | 新增 Pydantic schema |
| `database.py` | _MIGRATION_SQL 追加建表；_CLEANUP_SQL 追加过期清理 |
| `main.py` | include_router + startup 注册巡检后台任务 |

### 3. 后端 — API 端点

前缀：`/monitor`，所有端点依赖 `[auth, admin_only]`。

| 方法 | 路径 | 功能 | 认证 |
|------|------|------|------|
| POST | `/monitor/inspections` | 手动触发全量巡检（有并发锁，运行中返回 409） | admin_only |
| GET | `/monitor/inspections/latest` | 最近一次巡检结果 | admin_only |
| GET | `/monitor/inspections` | 历史巡检批次列表（分页） | admin_only |
| GET | `/monitor/inspections/{agent_number}/trend` | 单 agent 24h 趋势（按小时聚合） | admin_only |
| GET | `/monitor/anomalies` | 异常列表（支持 status/severity 过滤） | admin_only |
| PATCH | `/monitor/anomalies/{id}` | 确认/忽略异常（body: `{"status": "acknowledged"}`） | admin_only |
| GET | `/monitor/summary` | 监控仪表盘聚合数据（含巡检健康状态） | admin_only |

### 4. 后端 — InspectionRunner 架构

```
InspectionRunner
├── run_periodic()          # 循环检查 _shutdown_event，每 60s 调用 run_batch()
│   └── jitter: 首次延迟 random(0, 10)s，避免与其他定时任务对齐
├── run_batch()             # 编排一次全量巡检（asyncio.Lock 保证单实例）
│   ├── _discover_agents()  # 复用 AgentManager.list_agents
│   ├── _batch_metrics()    # 批量获取所有 pod metrics（单次 K8s API 调用）
│   ├── _check_one(agent)   # 并行检查单个 agent
│   │   ├── check_health()          # 复用 AgentManager
│   │   ├── get_pods_for_deployment()  # K8s API
│   │   ├── 查找 batch_metrics 中的资源数据  # 无额外 K8s 调用
│   │   └── _detect_anomalies()     # 阈值判定
│   ├── asyncio.gather(*checks)     # Semaphore(5) 并发控制
│   ├── _persist_batch()            # 批量 INSERT（bulk_insert_mappings）
│   ├── _resolve_old_anomalies()    # 连续 2 次不触发才标记 resolved（flapping 抑制）
│   └── _maybe_cleanup()            # 每 6h 清理过期 snapshot/anomaly
├── shutdown()              # 设置 _shutdown_event，等待当前 batch 完成
```

**安全与健壮性机制：**

1. **并发控制**：`asyncio.Lock` 保证 `run_batch` 同时只有一个实例，手动 trigger 时已运行则返回 409
2. **优雅关闭**：`asyncio.Event` 作为 shutdown signal，`run_periodic` 循环检查而非 `while True`
3. **异常隔离**：`run_periodic` 外层 `try/except`，异常时 sleep 60s 重试，连续失败升级日志级别
4. **批量写入**：`_persist_batch` 使用 `bulk_insert_mappings` 批量插入，避免逐条 session.add
5. **数据清理**：每 6h 在巡检循环内执行清理，而非仅 startup 时
6. **metrics 降级**：metrics-server 不可用时生成 `inspection_degraded` info 异常，`/monitor/summary` 返回 `last_inspection_at` 和 `inspection_healthy` 标志
7. **敏感信息净化**：`error_message` 写入前移除内部 IP、service 域名、token 片段
8. **K8s API 速率**：`Semaphore(5)` + 批量 metrics 接口，单轮 ~1+N 次 K8s 调用（N=agent 数）

**异常检测规则（第一期内建，阈值使用命名常量）：**

| 异常类型 | 条件 | 严重性 |
|----------|------|--------|
| health_down | health_ok == False | critical |
| pod_not_running | phase != "Running" | critical |
| high_memory | memory_usage_pct > 90 | warning |
| high_cpu | cpu_usage_pct > 90 | warning |
| high_restarts | restart_count > 5 | warning |
| inspection_degraded | metrics-server 连续 2 轮不可用 | info |

**异常去重**：数据库层 partial unique index `(agent_number, anomaly_type) WHERE status='active'` 防重复插入，应用层 `INSERT ... ON CONFLICT DO UPDATE SET updated_at=NOW()`。恢复判定需连续 2 次巡检（120s）不触发才标记 resolved，防止 flapping。

### 5. 前端 — 页面结构

#### 新建文件

| 文件 | 用途 |
|------|------|
| `pages/MonitoringPage.tsx` | 监控主页面（4 个 tab），共享数据通过 props 下发 |
| `components/monitoring/AnomalyAgentList.tsx` | 异常 agent 列表（含 ack/ignore 快捷按钮） |
| `components/monitoring/ResourceBars.tsx` | 资源水位条形图（纯 CSS） |
| `components/monitoring/InspectionResults.tsx` | 巡检结果表格（client-side 分页，每页 20 条） |
| `components/monitoring/AnomalyBadge.tsx` | Dashboard 异常计数 badge（纯展示组件，接收 count prop） |

> **设计注**：不新建 ClusterHealthOverview，直接复用现有 ClusterStatusBar 组件。Overview Tab 通过 ClusterStatusBar + AnomalyAgentList + ResourceBars 组合。

#### 修改文件

| 文件 | 变更 |
|------|------|
| `App.tsx` | 添加 `/monitoring` 路由（仅在 admin 路由组内） |
| `AdminLayout.tsx` | 侧边栏添加监控导航项；user mode 重定向守卫覆盖 `/monitoring` |
| `DashboardPage.tsx` | `loadData` 中统一请求异常计数，AnomalyBadge 作为纯展示组件接收 count prop |
| `admin-api.ts` | 新增类型和 API 方法 |
| `i18n/en.ts` + `i18n/zh.ts` | 新增翻译 key（`monitor*` 前缀） |

### 6. 前端 — 页面布局

#### MonitoringPage — Overview Tab
```
┌──────────────────────────────────────────────────────────┐
│ 监控中心          [Overview] [Anomaly] [Resources] [Inspect] │
├──────────────────────────────────────────────────────────┤
│ ┌─ 集群健康（复用 ClusterStatusBar）────────────────┐   │
│ │  CPU [====75%====]    Memory [==45%==]              │   │
│ │  Disk [=30%=]        3 agents / 2 running           │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ ┌─ 异常速览 ─────────────────────────────────────────┐   │
│ │  [!] 2 agents need attention                       │   │
│ │  [failed] hermes-gateway-3   health_fail            │   │
│ │  [stopped] hermes-gateway-5  high_restart           │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ ┌─ 资源水位 ─────────────────────────────────────────┐   │
│ │  gateway-1  CPU [====60%====]    MEM [==40%==]      │   │
│ │  gateway-2  CPU [======85%====!]  MEM [====70%====] │   │
│ │  gateway-3  CPU [--]            MEM [--]     stopped│   │
│ └────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

#### MonitoringPage — Anomaly Tab
```
┌──────────────────────────────────────────────────────────┐
│ 异常 Agent 列表 (2)                                       │
├──────────────────────────────────────────────────────────┤
│ ┌─ 异常卡片 ────────────────────────────────────────┐    │
│ │ [red dot] hermes-gateway-3                        │    │
│ │ Status: Failed    Last check: 2m ago              │    │
│ │ Reasons: [health_fail] [high_restart]              │    │
│ │ CPU: 0.1 cores  Memory: 0B  Restarts: 12          │    │
│ │ Last event: Back-off restarting container          │    │
│ │ [Acknowledge] [Ignore]     [View Details →]        │    │
│ └───────────────────────────────────────────────────┘    │
│                                                          │
│ ── 空状态 ──────────────────────────────────────────     │
│ ✓ All agents healthy                                    │
└──────────────────────────────────────────────────────────┘
```

#### MonitoringPage — Inspection Tab
```
┌──────────────────────────────────────────────────────────┐
│ 最近巡检结果                           [Run Inspection]   │
├──────────────────────────────────────────────────────────┤
│ Agent       | Check     | Status  | Detail              │
│-------------|-----------|---------|---------------------│
│ gateway-1   | Health    | Passed  | latency 23ms       │
│ gateway-1   | Resources | Passed  | CPU 35% MEM 40%    │
│ gateway-2   | Health    | Passed  | latency 45ms       │
│ gateway-2   | Resources | Warning | CPU 85%            │
│ gateway-3   | Health    | Failed  | Connection refused │
└──────────────────────────────────────────────────────────┘
```

### 7. 数据流

```
main.py startup
  └── InspectionRunner.run_periodic()  ─── 每 60s ──┐
                                                      │
        ┌─────────────────────────────────────────────┘
        │
        ▼
  run_batch()  ← asyncio.Lock 保证单实例
    ├── _discover_agents()        ← AgentManager.list_agents
    ├── _batch_metrics()          ← 单次 K8s API 获取全部 pod metrics
    ├── asyncio.gather(           ← Semaphore(5) 并发
    │     _check_one(agent) × N
    │       ├── check_health()        → K8s service /health
    │       ├── 查找 batch_metrics    → 无额外 K8s 调用
    │       └── _detect_anomalies()   → 阈值判定
    │   )
    ├── _persist_batch()          → PostgreSQL（bulk_insert_mappings）
    ├── _resolve_old_anomalies()  → 连续 2 次不触发才 resolved
    └── _maybe_cleanup()          → 每 6h 清理过期数据

main.py shutdown
  └── runner.shutdown()  → 设置 _shutdown_event，等待当前 batch 完成

前端（30s 轮询，visibilityState 暂停）
  ├── GET /monitor/summary          → 仪表盘聚合（集群健康 + 异常 + 资源）
  ├── GET /monitor/anomalies        → 异常列表
  ├── GET /monitor/inspections/latest → 最新巡检
  └── GET /monitor/inspections/{id}/trend → 24h 趋势（按需，非初始化）
```

---

## 第二期骨架

### 新增数据表
- `alert_rules` — 告警规则（条件类型、阈值、动作、是否需要确认）
- `alert_records` — 告警触发记录

### 新增后端
- `alert_engine.py` — 规则评估引擎 + 修复动作执行器（restart/scale）
- monitor_routes.py 追加：alert-rules CRUD、alerts 查询、action 执行

### 新增前端
- AlertRulesPage.tsx — 规则配置
- AlertListPage.tsx — 告警列表 + 确认/忽略
- RemediationPanel.tsx — 自动修复策略开关

---

## 第三期骨架

### 新增后端
- `log_analyzer.py` — 跨 agent 日志收集（并行 K8s pod log）、全文搜索
- monitor_routes.py 追加：`POST /monitor/logs/search`、`GET /monitor/logs/{id}/export`

### 新增前端
- LogSearchPage.tsx — 搜索界面
- TimeRangePicker.tsx — 时间选择器
- LogSearchResults.tsx — 结果高亮 + 分页 + 导出

---

## 构建序列（第一期）

### 后端（按顺序）
1. `db_models.py` — 新增两张 ORM 模型
2. `models.py` — 新增 Pydantic schema
3. `database.py` — migration SQL + cleanup SQL
4. `inspection.py` — 巡检引擎
5. `monitor_routes.py` — API 路由
6. `main.py` — 注册路由 + 启动后台任务

### 前端（按顺序）
1. `i18n/en.ts` + `i18n/zh.ts` — 翻译 key
2. `admin-api.ts` — 类型定义 + API 方法
3. `components/monitoring/*.tsx` — 子组件
4. `pages/MonitoringPage.tsx` — 页面组装
5. `App.tsx` + `AdminLayout.tsx` — 路由和导航
6. `DashboardPage.tsx` — 异常 badge 集成

---

## 评审记录

### 2026-05-26 三方评审

**评审人**：后端架构师、前端架构师、安全+运维专家

#### 已修复的 CRITICAL 问题（5 项）

| # | 问题 | 修复方式 |
|---|------|----------|
| 1 | K8s API 无速率限制，逐个查询 pod metrics | 新增 `_batch_metrics()` 批量接口，Semaphore(5) 并发控制 |
| 2 | snapshot 清理仅在启动时执行 | 新增 `_maybe_cleanup()` 每 6h 在巡检循环内清理 |
| 3 | 监控端点未声明 admin_only | 所有 `/monitor/*` 端点标注 `admin_only` 依赖 |
| 4 | 手动 trigger 无速率限制 | `asyncio.Lock` 防并发，运行中返回 409 |
| 5 | user mode 可通过 URL 访问 /monitoring | AdminLayout 重定向守卫覆盖，路由仅注册在 admin 组 |

#### 已修复的 HIGH 问题（8 项）

| # | 问题 | 修复方式 |
|---|------|----------|
| 6 | `run_periodic()` 无优雅关闭 | `asyncio.Event` shutdown signal，`shutdown()` 方法等待当前 batch |
| 7 | 手动 trigger 和定时巡检可并发 | `asyncio.Lock` 保证单实例 |
| 8 | trend 查询缺组合索引 | 新增 `(agent_number, created_at DESC)` 索引 |
| 9 | 异常恢复无 flapping 抑制 | 连续 2 次不触发才 resolved |
| 10 | 前端 N+1 请求 | `/monitor/summary` 返回聚合数据；trend 按需请求 |
| 11 | 10s 轮询与 60s 巡检不对齐 | 改为 30s + visibilityState 暂停 |
| 12 | ClusterHealthOverview 与 ClusterStatusBar 重叠 | 复用 ClusterStatusBar，不新建平行组件 |
| 13 | metrics-server 不可用时静默失败 | 新增 `inspection_degraded` 异常类型 + summary 返回巡检健康状态 |

#### 已修复的 MEDIUM 问题（关键项）

| # | 问题 | 修复方式 |
|---|------|----------|
| 14 | `batch_id` VARCHAR(36) 效率低 | 改用 PostgreSQL UUID 类型 |
| 15 | 异常去重无数据库层保障 | 新增 partial unique index + ON CONFLICT |
| 16 | `error_message` 含敏感信息 | 写入前净化内部 IP/域名/token |
| 17 | 异常卡片缺 ack/ignore 操作 | 布局中添加快捷操作按钮 |
| 18 | 缺少空状态/loading/error 设计 | 补充空状态示例，组件必须处理三态 |
