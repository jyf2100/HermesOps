# Admin 任务派发系统设计 v4.1

> v4.1 = v4 + 专家审核修补项。修复：callback_token 安全（hash+原子失效）、微信 context_token 过期兜底、DB 补全约束/索引/导入、响应式 UX、编号菜单上限。

## 概述

在现有 orchestrator 基础上扩展频道订阅和定向派发能力。Admin 派发任务后，agent 通过专用工具推送用户确认（编号菜单），用户选择 profile 后执行，结果回传 Admin。

**完整流转**：
```
Admin 发布任务
  → 频道 fan-out 或 直接指定 agent
    → Orchestrator 推送 (confirm_required=true)
      → Agent 调用 dispatch_confirm 工具
        → 推送编号菜单到用户（微信/Telegram）
          → 用户回复编号（1=确认自动, 2=确认+profile, 3=拒绝）
            → Agent 使用选定 profile 执行
              → 结果回传 Admin + 通知
```

## 架构

```
                    ┌──────────────┐
                    │ Admin 前端    │
                    └──────┬───────┘
                           │ /dispatch/*
                    ┌──────▼───────┐
                    │ Admin 后端    │
                    │ ┌──────────┐ │
                    │ │频道/订阅  │ │ ← PostgreSQL (dispatch DB)
                    │ │dispatch  │ │
                    │ └────┬─────┘ │
                    └──────┼───────┘
                           │ proxy (target_agent_id + confirm_required)
                    ┌──────▼───────┐
                    │ Orchestrator │ ← Redis Streams
                    │ ┌──────────┐ │
                    │ │TaskExec  │ │
                    │ └────┬─────┘ │
                    └──────┼───────┘
                           │ POST /v1/runs (with metadata)
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Agent    │ │ Agent    │ │ Agent    │
        │ 调用     │ │ 调用     │ │ 调用     │
        │dispatch  │ │dispatch  │ │dispatch  │
        │_confirm  │ │_confirm  │ │_confirm  │
        │工具      │ │工具      │ │工具      │
        │→ 编号菜单│ │→ 编号菜单│ │→ 编号菜单│
        │→ 用户选 │ │→ 用户选 │ │→ 用户选 │
        │→ 执行   │ │→ 执行   │ │→ 执行   │
        └──────────┘ └──────────┘ └──────────┘
```

## 核心设计决策

### 1. dispatch_confirm 工具（替代 prompt 注入）

v3 通过 prompt 注入确认指令，LLM 可能跳过。v4 注册一个专用工具：

```python
# tools/dispatch_confirm_tool.py
class DispatchConfirmTool:
    """Agent 必须调用此工具确认 dispatch 任务，不能跳过。"""
    
    name = "dispatch_confirm"
    description = "确认或拒绝系统派发的任务，等待用户选择"
    
    parameters = {
        "task_id": "string, required — 派发任务 ID",
        "task_title": "string, required — 任务标题",
        "task_prompt": "string, required — 任务内容",
        "profiles": "array — 可选 profile 列表",
        "suggested_profile": "string — Admin 建议 profile",
        "admin_operator": "string — Admin 操作人",
        "callback_url": "string — Admin 回调地址",
        "callback_token": "string — 回调认证令牌",
        "confirm_timeout_hours": "number — 确认超时小时数"
    }
```

**工作原理**：
1. Orchestrator 提交 `/v1/runs` 时，prompt 中包含"这是一个 dispatch 任务，请调用 dispatch_confirm 工具处理"
2. Agent LLM 调用 `dispatch_confirm` 工具
3. 工具实现：通过消息平台推送编号菜单给用户，**阻塞等待**用户回复
4. 用户回复后，工具返回确认结果 + profile 选择
5. Agent 使用选定 profile 继续执行

**为什么用工具而不是 prompt**：
- 工具注册机制 (`tools/registry.py`) 是确定性的 — LLM 不调用工具就无法执行实际任务
- 工具实现可以精确控制消息格式和回复解析
- 工具内部可以处理超时、重试、模糊匹配

### 2. 编号菜单（替代自由文本）

```
📋 新任务：【审查 PR #1234】
来源：Admin - 张三 | 频道：开发组
超时：10分钟

请审查 PR #1234 的代码变更，关注安全性和性能

请回复编号：
1 ✅ 确认执行（自动匹配 profile）
2 ✅ 确认执行（code-review profile）
3 ✅ 确认执行（data-analysis profile）
4 ❌ 拒绝此任务
```

**回复解析**：
- `"1"` 或 `"一"` 或 `"确认"` → 确认，自动选 profile
- `"2"` → 确认，使用 code-review profile
- `"4"` 或 `"拒绝"` → 拒绝
- 无效回复 → 提示"请回复编号 1-N"

**编号菜单上限**：最多 8 个选项（1=自动确认, 2-N=profile 列表, 最后一项=拒绝）。超过 5 个 profile 时折叠为两步：先确认/拒绝，确认后再选 profile。

**跨平台支持**：
- Telegram：使用 InlineKeyboardButton（结构化回调）
- 微信：纯文本编号（最可靠）
- 其他平台：统一用编号

### 3. Orchestrator 确认等待状态

现有 task 状态机：`submitted → queued → assigned → executing → done/failed`

扩展为：`submitted → queued → assigned → confirming → executing → done/failed`

新增状态 `confirming`：
- TaskExecutor 提交 `/v1/runs` 后，将 task 标记为 `confirming`
- timeout 暂停计时（确认等待时间不计入执行超时）
- Agent 调用 dispatch_confirm 工具时，通过 callback 通知 orchestrator 转为 `executing`
- 确认超时（默认 24h）后转为 `failed`（reason: confirm_timeout）

### 4. Agent 回调机制

工具通过 task metadata 获取回调信息（不注入 prompt）：

```python
# orchestrator 提交 /v1/runs 时的请求
{
    "input": "[dispatch] 调用 dispatch_confirm 工具处理派发任务",
    "instructions": "...",
    "metadata": {
        "dispatch_task_id": 42,
        "callback_url": "http://hermes-admin:48082/dispatch/callback",
        "callback_token": "dispatch-xxx-yyy",  # 一次性令牌
        "confirm_timeout_hours": 24
    }
}
```

`dispatch_confirm` 工具从 metadata 中读取 `callback_url` 和 `callback_token`，用户确认后 POST 回 Admin。

### 4.1 callback_token 安全机制

- **生成**：`secrets.token_urlsafe(32)`，Admin 创建 assignment 时生成
- **存储**：DB 存 SHA-256 hash（`hashlib.sha256(token).hexdigest()`），明文只在 metadata 中传递一次
- **验证**：`hmac.compare_digest(stored_hash, sha256(received_token).hexdigest())`
- **原子失效**：callback 处理在同事务中 `SET callback_token_hash = NULL WHERE callback_token_hash = :hash`
- **一次性**：hash 置 NULL 后重放无效，`WHERE callback_token_hash IS NOT NULL` 跳过已消费的 assignment

### 4.2 微信 context_token 过期兜底

dispatch_confirm 工具不依赖微信 context_token 的阻塞等待，改为**轮询 Admin**：

```
1. 工具推送编号菜单给用户（fire-and-forget，不等 context_token）
2. 工具启动轮询：每 30s 调 Admin GET /dispatch/callback/poll?assignment_id=X
3. Admin 端记录用户回复（通过独立 webhook 接收微信消息）
4. 轮询到结果后工具返回，agent 继续执行
```

独立 webhook：Admin 新增 `POST /dispatch/callback/weixin-reply` 接收微信回调，
匹配 `assignment_id`（消息中嵌入），写入临时回复记录。轮询端点读取该记录。

### 5. Profile 选择记录

| 来源 | profile_source | 说明 |
|------|---------------|------|
| 用户选了编号 2（指定 profile） | `"user"` | 用户主动选择 |
| 用户选了编号 1（自动） | `"auto"` | Agent 根据任务内容自动判断 |
| 用户选了编号 1，agent 使用了 admin 建议 | `"admin_hint"` | Agent 采用了建议 |

## 数据模型

### Admin PostgreSQL（db_models.py）

```python
from sqlalchemy import text, desc  # 补充导入

class TaskChannel(Base):
    __tablename__ = "task_channels"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(64), unique=True, nullable=False)
    display_name = Column(String(100), nullable=False)
    description = Column(Text, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class TaskChannelSubscription(Base):
    __tablename__ = "task_channel_subscriptions"
    __table_args__ = (
        UniqueConstraint("channel_id", "agent_number", name="uq_channel_agent"),
        Index("ix_subscriptions_agent", "agent_number"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    channel_id = Column(BigInteger, ForeignKey("task_channels.id", ondelete="CASCADE"), nullable=False)
    agent_number = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class DispatchTask(Base):
    __tablename__ = "dispatch_tasks"
    __table_args__ = (
        CheckConstraint("dispatch_type IN ('channel', 'direct')", name="ck_dispatch_type"),
        CheckConstraint("priority BETWEEN 1 AND 10", name="ck_priority_range"),
        CheckConstraint("timeout_seconds > 0", name="ck_timeout_positive"),
        CheckConstraint("confirm_timeout_hours BETWEEN 1 AND 168", name="ck_confirm_timeout"),
        CheckConstraint(
            "status IN ('pending','dispatched','partial','completed','failed','cancelled')",
            name="ck_task_status",
        ),
        Index("ix_dispatch_status_created", "status", desc("created_at")),
        Index("ix_dispatch_channel", "channel_id"),
        Index("ix_dispatch_created_by", "created_by"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    title = Column(String(200), nullable=False)
    prompt = Column(Text, nullable=False)
    instructions = Column(Text, default="")
    dispatch_type = Column(String(20), nullable=False)
    channel_id = Column(BigInteger, ForeignKey("task_channels.id", ondelete="SET NULL"), nullable=True)
    priority = Column(Integer, default=5)
    timeout_seconds = Column(Integer, default=600)
    confirm_timeout_hours = Column(Integer, default=24)
    profile_hint = Column(String(64), nullable=True)
    status = Column(String(20), default="pending", server_default="pending")
    created_by = Column(String(100), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    result_summary = Column(Text, nullable=True)


class DispatchAssignment(Base):
    __tablename__ = "dispatch_assignments"
    __table_args__ = (
        UniqueConstraint("task_id", "agent_number", name="uq_task_agent"),
        Index("ix_assignment_agent_status", "agent_number", "status"),
        Index("ix_assignment_task_id", "task_id"),
        Index("ix_assignment_deadline", "confirm_deadline",
              postgresql_where=text("status IN ('pending','notified')")),
        CheckConstraint(
            "status IN ('pending','notified','confirmed','rejected','executing','completed','failed','expired')",
            name="ck_assignment_status",
        ),
        CheckConstraint(
            "profile_source IS NULL OR profile_source IN ('user','auto','admin_hint')",
            name="ck_profile_source",
        ),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    task_id = Column(BigInteger, ForeignKey("dispatch_tasks.id", ondelete="CASCADE"), nullable=False)
    agent_number = Column(Integer, nullable=False)
    status = Column(String(20), default="pending", server_default="pending")
    user_confirmed_at = Column(DateTime(timezone=True), nullable=True)
    profile_name = Column(String(64), nullable=True)
    profile_source = Column(String(20), nullable=True)       # 'user' | 'auto' | 'admin_hint'
    orchestrator_task_id = Column(String(128), nullable=True)
    callback_token_hash = Column(String(128), nullable=True)  # SHA-256 hash（非明文）
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    result_summary = Column(Text, nullable=True)
    result_data = Column(JSONB, default=dict, server_default="{}")
    error_message = Column(Text, nullable=True)
    confirm_deadline = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
```

### 状态机

```
DispatchTask:
  pending → dispatched → partial → completed
                    ↘ failed
                    ↘ cancelled

DispatchAssignment (两个独立生命周期):
  确认阶段: pending → notified → confirmed / rejected / expired
  执行阶段: confirmed → executing → completed / failed
```

### Background Tasks

Admin 后端启动两个定时任务：

1. **确认超时扫描**（每 5 分钟）
   - `SELECT ... FOR UPDATE SKIP LOCKED` 防止多实例并发扫描同一行
   - 查 `status IN ('pending','notified') AND confirm_deadline < now()`
   - 更新为 `expired`
   - 汇总更新 DispatchTask 状态

2. **执行状态对账**（每 5 分钟）
   - `SELECT ... FOR UPDATE SKIP LOCKED` 同理
   - 查 `status = 'executing' AND started_at + timeout_seconds < now()`
   - 调 orchestrator `GET /api/v1/tasks/{id}` 获取真实状态
   - 更新为 `completed` / `failed`

## API 设计

### Admin 端点

```
# 频道管理
POST   /dispatch/channels
GET    /dispatch/channels
PUT    /dispatch/channels/{id}
DELETE /dispatch/channels/{id}

# 频道订阅
POST   /dispatch/channels/{id}/subscribers
GET    /dispatch/channels/{id}/subscribers

# 任务派发
POST   /dispatch/tasks
GET    /dispatch/tasks                        ?status=&agent_number=&limit=&offset=
GET    /dispatch/tasks/{id}
POST   /dispatch/tasks/{id}/cancel

# Agent 回调（dispatch_confirm 工具调用）
POST   /dispatch/callback/confirm             确认（含 profile 选择）
POST   /dispatch/callback/reject              拒绝
POST   /dispatch/callback/result              结果回传
```

### 请求体

```python
class DispatchTaskRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    prompt: str = Field(..., min_length=1, max_length=50000)
    instructions: str = Field("", max_length=10000)
    dispatch_type: Literal["channel", "direct"]
    channel_id: int | None = None
    target_agents: list[int] | None = None
    profile_hint: str | None = None
    confirm_timeout_hours: int = Field(24, ge=1, le=168)
    priority: int = Field(5, ge=1, le=10)
    timeout_seconds: int = Field(600, ge=10, le=3600)

class DispatchTaskListParams(BaseModel):
    status: str | None = None
    agent_number: int | None = None       # 按目标 agent 筛选
    limit: int = Field(50, ge=1, le=200)  # 上限 200，匹配 orchestrator 模式
    offset: int = Field(0, ge=0)

class CallbackConfirmRequest(BaseModel):
    assignment_id: int
    callback_token: str
    profile_name: str | None = None
    profile_source: Literal["user", "auto", "admin_hint"] = "auto"

class CallbackResultRequest(BaseModel):
    assignment_id: int
    callback_token: str
    profile_name: str
    profile_source: Literal["user", "auto", "admin_hint"]
    result_summary: str
    result_data: dict = Field(default_factory=dict)
    error: str | None = None
```

### 错误响应

| 场景 | HTTP | body.error | 说明 |
|------|------|-----------|------|
| Orchestrator 不可达 | 502 | `"orchestrator_unavailable"` | Admin→Orchestrator 连接失败 |
| Agent 离线或状态不符 | 409 | `"agent_not_available"` | agent_number 对应的 Pod 不健康或 assignment 状态不允许此操作 |
| callback_token 无效/已消费 | 401 | `"invalid_token"` | token 不匹配或 hash 已为 NULL |
| 频道不存在 | 404 | `"channel_not_found"` | channel_id 无效 |
| 参数校验失败 | 422 | Pydantic 默认 | FastAPI 自动处理 |

## 前端 UX

### 任务管理页 — 拆分面板（lg+ 横排，<lg 纵向堆叠）

```
┌─────────────────────────────────────────────────────┐
│ [任务管理]                                           │
├──────────────┬──────────────────────────────────────┤
│ 任务列表      │ 任务详情                              │
│              │                                      │
│ 🔍 状态筛选  │ #42 审查 PR #1234                    │
│              │ 类型: 频道广播 | 开发组               │
│ ┌──────────┐│ Admin: 张三 | 2026-05-20 14:30       │
│ │#42 审查..││                                      │
│ │频道 已完成││ Agent 状态                            │
│ └──────────┘│ ┌─────────────────────────────────┐  │
│ ┌──────────┐│ │Agent1  ✅ 已确认(code-review)   │  │
│ │#41 部署..││ │        ✅ 执行完成 (3.2s)        │  │
│ │直发 执行中││ │Agent5  ⏳ 等待用户确认          │  │
│ └──────────┘│ │        📋 已推送微信             │  │
│ ┌──────────┐│ │Agent12 ❌ 用户拒绝               │  │
│ │#40 数据..││ └─────────────────────────────────┘  │
│ │频道 待确认││                                      │
│ └──────────┘│ 进度: ████████░░░░ 2/3 完成          │
│              │                                      │
│ [+ 发布任务] │ 汇总结果: ...                        │
├──────────────┴──────────────────────────────────────┤
│ [任务] [频道管理]                                     │
└─────────────────────────────────────────────────────┘

<lg 断点（手机/平板）：
┌─────────────────────┐
│ [任务管理]  [+发布]  │
│ 🔍 状态筛选         │
│ ┌─────────────────┐ │
│ │#42 审查.. 已完成 │ │
│ └─────────────────┘ │
│ ┌─────────────────┐ │
│ │#41 部署.. 执行中 │ │
│ └─────────────────┘ │
│                     │
│ （点击进入详情页）   │
└─────────────────────┘
```

### 发布任务对话框

```
┌─────────────────────────────────────┐
│ 发布任务                        [×] │
├─────────────────────────────────────┤
│ 任务标题 *                           │
│ ┌─────────────────────────────────┐ │
│ │ 审查 PR #1234                   │ │
│ └─────────────────────────────────┘ │
│                                     │
│ 任务内容 *（发送给 Agent）           │
│ ┌─────────────────────────────────┐ │
│ │ 请审查 PR #1234 的代码变更，    │ │
│ │ 关注安全性和性能                │ │
│ └─────────────────────────────────┘ │
│                                     │
│ 派发方式  [频道广播 ▼]              │
│ 频道      [开发组 ▼]               │
│                                     │
│ ▸ 高级选项                          │
│   建议 Profile  [code-review ▼]    │
│   优先级        [5 ▼]              │
│   执行超时      600 秒              │
│   确认超时      24 小时             │
│                                     │
│            [取消]  [发布任务]        │
└─────────────────────────────────────┘
```

## 分阶段实施（缩减 MVP）

### Phase 1：定向派发（无确认，最快可用）
- [ ] db_models.py 4 个新 model
- [ ] database.py migration
- [ ] 频道 CRUD API
- [ ] 定向派发 API（direct mode，跳过确认直接执行）
- [ ] orchestrator TaskSubmitRequest +target_agent_id
- [ ] 任务列表/详情 API
- [ ] 基础前端：任务列表 + 发布对话框
- [ ] 单元测试

### Phase 2：频道广播 + 结果汇总
- [ ] 频道订阅管理
- [ ] fan-out 逻辑
- [ ] 结果收集（轮询 orchestrator）
- [ ] 执行状态对账 background task
- [ ] 前端：频道管理 tab + 进度展示

### Phase 3：用户确认（dispatch_confirm 工具）
- [ ] tools/dispatch_confirm_tool.py（注册为 agent 工具）
- [ ] 编号菜单推送 + 回复解析
- [ ] orchestrator confirming 状态
- [ ] Agent 回调端点（confirm/reject）
- [ ] 确认超时扫描 background task
- [ ] 前端：确认状态展示

### Phase 4：Profile 选择 + 通知
- [ ] Profile 列表查询（agent 可用 profiles）
- [ ] 用户编号选择解析
- [ ] Agent 自动 profile 选择逻辑
- [ ] Admin 操作人通知（面板 + 微信）
- [ ] 结果详情展示

## 文件变更清单

| 文件 | 变更 |
|------|------|
| `admin/backend/db_models.py` | +4 models |
| `admin/backend/database.py` | +migration SQL + background tasks |
| `admin/backend/models.py` | +Pydantic models |
| `admin/backend/dispatch_routes.py` | 新文件：频道 + 派发 + 回调 |
| `admin/backend/main.py` | include dispatch_router |
| `hermes_orchestrator/models/api.py` | +target_agent_id, +confirm_required |
| `hermes_orchestrator/models/task.py` | +confirming status |
| `hermes_orchestrator/main.py` | task worker: target_agent_id + confirming state |
| `tools/dispatch_confirm_tool.py` | 新文件：确认工具（Phase 3） |
| `admin/frontend/src/pages/TaskDispatchPage.tsx` | 新页面 |
| `admin/frontend/src/components/AdminLayout.tsx` | 侧边栏加入口 |
| `admin/frontend/src/i18n/en.ts` `zh.ts` | +i18n keys |
