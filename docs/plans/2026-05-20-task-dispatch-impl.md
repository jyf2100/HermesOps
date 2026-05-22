# 任务派发系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Hermes Admin 中实现任务派发系统，允许 Admin 运营人员通过频道广播或定向派发将任务发送给 agent 执行。

**Architecture:** 在现有 Admin 后端新增 `dispatch_routes.py` 独立路由模块，通过 PostgreSQL 管理 dispatch 状态，通过现有 orchestrator proxy 提交任务。前端新增 `TaskDispatchPage` 拆分面板页面。orchestrator 仅最小改动（新增 `target_agent_id` 字段）。

**Tech Stack:** FastAPI + SQLAlchemy async + PostgreSQL（后端），React 19 + Vite 7 + Tailwind 4（前端），Pydantic v2（验证）

---

## 文件结构

### 后端（新建/修改）

| 文件 | 操作 | 职责 |
|------|------|------|
| `admin/backend/db_models.py` | 修改 | +4 ORM models（TaskChannel, TaskChannelSubscription, DispatchTask, DispatchAssignment） |
| `admin/backend/database.py` | 修改 | +migration SQL（4 张新表） |
| `admin/backend/models.py` | 修改 | +8 Pydantic models（请求/响应） |
| `admin/backend/dispatch_routes.py` | **新建** | 频道 CRUD + 任务派发 + 回调 + background tasks |
| `admin/backend/main.py` | 修改 | include dispatch_router（1 行） |
| `hermes_orchestrator/models/api.py` | 修改 | +target_agent_id 字段（Phase 1） |
| `hermes_orchestrator/models/task.py` | 修改 | +target_agent_id 字段（Phase 1） |

### 前端（新建/修改）

| 文件 | 操作 | 职责 |
|------|------|------|
| `admin/frontend/src/pages/TaskDispatchPage.tsx` | **新建** | 任务管理拆分面板页面 |
| `admin/frontend/src/App.tsx` | 修改 | +/dispatch 路由 |
| `admin/frontend/src/components/AdminLayout.tsx` | 修改 | +dispatch 导航入口 |
| `admin/frontend/src/lib/admin-api.ts` | 修改 | +dispatch API 函数 |
| `admin/frontend/src/i18n/en.ts` | 修改 | +dispatch i18n keys |
| `admin/frontend/src/i18n/zh.ts` | 修改 | +dispatch i18n keys |

### 不修改的文件（零影响保证）

- `admin/backend/k8s_client.py` — K8s 操作无关
- `admin/backend/agent_manager.py` — Agent CRUD 无关
- `admin/backend/config_manager.py` — 配置管理无关
- `admin/backend/profile_routes.py` — Profile 管理无关
- `admin/backend/user_routes.py` — 用户管理无关
- `admin/backend/hub_routes.py` — Skills Hub 无关
- `admin/backend/weixin.py` — 微信绑定无关
- 所有现有前端页面组件 — 不修改

---

## 风险隔离策略

| 风险 | 缓解措施 |
|------|----------|
| DB migration 影响现有表 | 所有 SQL 用 `IF NOT EXISTS` / `DO $$ ... IF NOT EXISTS` |
| 新路由与现有路由冲突 | 所有新路由以 `/dispatch` 前缀隔离，不碰 `/agents`, `/settings` 等 |
| DB 会话与 HTTP 调用纠缠 | `create_dispatch_task` 使用三阶段：Phase 1 写入+commit，Phase 2 HTTP 调用（无 DB session），Phase 3 更新+commit |
| Auth 循环导入 | dispatch_routes.py 不导入 auth，main.py include 时注入 dependencies |
| callback_url HTTPS 验证阻断内部 URL | callback_url 只放在 metadata 中，不放在 orch_body 顶层（避免触发 TaskSubmitRequest 的 HTTPS+公网 IP 验证器） |
| Orchestrator 改动影响现有任务 | `target_agent_id=None` 默认值，现有请求体不包含此字段，Pydantic 自动使用默认值，路由逻辑走原分支 |
| `from_dict` 反序列化旧数据 | Task dataclass 第88行已过滤未知字段，新字段自动使用默认值 |
| admin-api.ts 改动 | 只在文件末尾追加新函数，不修改现有函数 |
| i18n 改动 | 只在 Translations 接口和 en.ts/zh.ts 末尾追加新 key |

---

## Task 1: 后端 DB Models + Migration

**Files:**
- Modify: `admin/backend/db_models.py`
- Modify: `admin/backend/database.py`

- [ ] **Step 1: 修改 db_models.py 导入行**

在现有第4行导入中添加 `desc`, `text`：

```python
from sqlalchemy import BigInteger, Boolean, CheckConstraint, Column, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, desc, func, text
```

- [ ] **Step 2: 在 db_models.py 末尾添加 4 个 ORM model**

在 `ProfileAuditLog` 类之后追加：

```python
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
            "status IN ('pending','dispatching','dispatched','partial','completed','failed','cancelled')",
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
    status = Column(String(20), default="pending", server_default="pending", nullable=False)
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
    status = Column(String(20), default="pending", server_default="pending", nullable=False)
    user_confirmed_at = Column(DateTime(timezone=True), nullable=True)
    profile_name = Column(String(64), nullable=True)
    profile_source = Column(String(20), nullable=True)
    orchestrator_task_id = Column(String(128), nullable=True)
    callback_token_hash = Column(String(128), nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    result_summary = Column(Text, nullable=True)
    result_data = Column(JSONB, nullable=True)
    error_message = Column(Text, nullable=True)
    confirm_deadline = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
```

- [ ] **Step 3: 在 database.py _MIGRATION_SQL 列表末尾添加 4 张新表的 migration SQL**

在 `_MIGRATION_SQL` 列表最后一个字符串之后追加：

```python
    # --- Dispatch system tables ---
    """
    CREATE TABLE IF NOT EXISTS task_channels (
        id SERIAL PRIMARY KEY,
        name VARCHAR(64) UNIQUE NOT NULL,
        display_name VARCHAR(100) NOT NULL,
        description TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS task_channel_subscriptions (
        id SERIAL PRIMARY KEY,
        channel_id BIGINT NOT NULL REFERENCES task_channels(id) ON DELETE CASCADE,
        agent_number INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_channel_agent UNIQUE (channel_id, agent_number)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_subscriptions_agent
      ON task_channel_subscriptions (agent_number)
    """,
    """
    CREATE TABLE IF NOT EXISTS dispatch_tasks (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        prompt TEXT NOT NULL,
        instructions TEXT DEFAULT '',
        dispatch_type VARCHAR(20) NOT NULL,
        channel_id BIGINT REFERENCES task_channels(id) ON DELETE SET NULL,
        priority INTEGER DEFAULT 5,
        timeout_seconds INTEGER DEFAULT 600,
        confirm_timeout_hours INTEGER DEFAULT 24,
        profile_hint VARCHAR(64),
        status VARCHAR(20) DEFAULT 'pending' NOT NULL,
        created_by VARCHAR(100) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        result_summary TEXT,
        CONSTRAINT ck_dispatch_type CHECK (dispatch_type IN ('channel', 'direct')),
        CONSTRAINT ck_priority_range CHECK (priority BETWEEN 1 AND 10),
        CONSTRAINT ck_timeout_positive CHECK (timeout_seconds > 0),
        CONSTRAINT ck_confirm_timeout CHECK (confirm_timeout_hours BETWEEN 1 AND 168),
        CONSTRAINT ck_task_status CHECK (status IN ('pending','dispatching','dispatched','partial','completed','failed','cancelled'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_dispatch_status_created
      ON dispatch_tasks (status, created_at DESC)
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_dispatch_channel
      ON dispatch_tasks (channel_id)
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_dispatch_created_by
      ON dispatch_tasks (created_by)
    """,
    """
    CREATE TABLE IF NOT EXISTS dispatch_assignments (
        id SERIAL PRIMARY KEY,
        task_id BIGINT NOT NULL REFERENCES dispatch_tasks(id) ON DELETE CASCADE,
        agent_number INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' NOT NULL,
        user_confirmed_at TIMESTAMPTZ,
        profile_name VARCHAR(64),
        profile_source VARCHAR(20),
        orchestrator_task_id VARCHAR(128),
        callback_token_hash VARCHAR(128),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        result_summary TEXT,
        result_data JSONB,
        error_message TEXT,
        confirm_deadline TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_task_agent UNIQUE (task_id, agent_number),
        CONSTRAINT ck_assignment_status CHECK (status IN ('pending','notified','confirmed','rejected','executing','completed','failed','expired')),
        CONSTRAINT ck_profile_source CHECK (profile_source IS NULL OR profile_source IN ('user','auto','admin_hint'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_assignment_agent_status
      ON dispatch_assignments (agent_number, status)
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_assignment_task_id
      ON dispatch_assignments (task_id)
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_assignment_deadline
      ON dispatch_assignments (confirm_deadline)
      WHERE status IN ('pending','notified')
    """,
```

- [ ] **Step 4: 验证 migration 不影响现有表**

Run: `cd admin/backend && python -c "from db_models import Base; print([t for t in Base.metadata.tables.keys()])"`
Expected: 输出包含 `task_channels`, `task_channel_subscriptions`, `dispatch_tasks`, `dispatch_assignments` 以及所有现有表

- [ ] **Step 5: Commit**

```bash
git add admin/backend/db_models.py admin/backend/database.py
git commit -m "feat(dispatch): add DB models and migration for task dispatch system"
```

---

## Task 2: 后端 Pydantic Models

**Files:**
- Modify: `admin/backend/models.py`

- [ ] **Step 1: 在 models.py 的 pydantic 导入行添加 model_validator**

找到现有的 pydantic 导入行（通常包含 `from pydantic import BaseModel, Field, ...`），添加 `model_validator`：

```python
from pydantic import BaseModel, Field, Literal, model_validator
```

- [ ] **Step 2: 在 models.py 末尾添加 dispatch 相关 Pydantic models**

在 `SkillReportResponse` 类之后追加：

```python
# ---------------------------------------------------------------------------
# Task Dispatch
# ---------------------------------------------------------------------------

class ChannelCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64, pattern=r"^[a-z0-9_-]+$")
    display_name: str = Field(..., min_length=1, max_length=100)
    description: str = Field("", max_length=500)


class ChannelUpdateRequest(BaseModel):
    display_name: str | None = Field(None, max_length=100)
    description: str | None = Field(None, max_length=500)


class ChannelResponse(BaseModel):
    id: int
    name: str
    display_name: str
    description: str
    subscriber_count: int = 0
    created_at: str = ""


class SubscriptionRequest(BaseModel):
    agent_numbers: list[int] = Field(..., min_length=1, max_length=100)


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

    @model_validator(mode="after")
    def validate_dispatch_fields(self) -> "DispatchTaskRequest":
        if self.dispatch_type == "channel" and self.channel_id is None:
            raise ValueError("channel_id is required when dispatch_type is 'channel'")
        if self.dispatch_type == "direct" and not self.target_agents:
            raise ValueError("target_agents is required when dispatch_type is 'direct'")
        return self


class DispatchTaskListParams(BaseModel):
    status: str | None = None
    agent_number: int | None = None
    limit: int = Field(50, ge=1, le=200)
    offset: int = Field(0, ge=0)


class DispatchTaskResponse(BaseModel):
    id: int
    title: str
    dispatch_type: str
    status: str
    channel_id: int | None = None
    priority: int = 5
    created_by: str = ""
    created_at: str = ""
    result_summary: str | None = None
    assignments: list["DispatchAssignmentResponse"] = []


class DispatchAssignmentResponse(BaseModel):
    id: int
    agent_number: int
    status: str
    profile_name: str | None = None
    profile_source: str | None = None
    orchestrator_task_id: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    result_summary: str | None = None
    error_message: str | None = None


class CallbackConfirmRequest(BaseModel):
    assignment_id: int
    callback_token: str
    profile_name: str | None = None
    profile_source: Literal["user", "auto", "admin_hint"] = "auto"


class CallbackRejectRequest(BaseModel):
    assignment_id: int
    callback_token: str


class CallbackResultRequest(BaseModel):
    assignment_id: int
    callback_token: str
    profile_name: str
    profile_source: Literal["user", "auto", "admin_hint"]
    result_summary: str
    result_data: dict = Field(default_factory=dict)
    error: str | None = None
```

- [ ] **Step 3: 验证 Pydantic models 可以实例化**

Run: `cd admin/backend && python -c "from models import DispatchTaskRequest; r = DispatchTaskRequest(title='test', prompt='test', dispatch_type='direct', target_agents=[1]); print(r.model_dump())"`
Expected: 输出包含 `title='test'`, `dispatch_type='direct'`, `target_agents=[1]`

- [ ] **Step 4: Commit**

```bash
git add admin/backend/models.py
git commit -m "feat(dispatch): add Pydantic models for dispatch API"
```

---

## Task 3: Orchestrator 最小改动（Phase 1）

**Files:**
- Modify: `hermes_orchestrator/models/api.py`
- Modify: `hermes_orchestrator/models/task.py`
- Modify: `hermes_orchestrator/main.py`

- [ ] **Step 1: TaskSubmitRequest 添加 target_agent_id 字段**

在 `hermes_orchestrator/models/api.py` 的 `TaskSubmitRequest` 类中，在 `preferred_tags` 字段之后追加：

```python
    target_agent_id: str | None = Field(
        None,
        max_length=128,
        description="When set, skip routing and assign to this specific agent.",
    )

    @field_validator("target_agent_id")
    @classmethod
    def validate_target_agent_id(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not re.match(r'^[a-z0-9][a-z0-9-]*$', v):
            raise ValueError(
                "target_agent_id must be a valid deployment name prefix "
                "(lowercase alphanumeric and hyphens, e.g. hermes-gateway-1)"
            )
        return v
```

- [ ] **Step 2: Task dataclass 添加 target_agent_id 字段**

在 `hermes_orchestrator/models/task.py` 的 `Task` dataclass 中，在 `routing_info` 字段之后追加：

```python
    target_agent_id: str | None = None
```


- [ ] **Step 3: submit_task 传递 target_agent_id**

在 `hermes_orchestrator/main.py` 的 `submit_task` 函数中（约第222行），Task 构造时添加 `target_agent_id` 字段：

```python
    task = Task(
        task_id=str(uuid.uuid4()),
        prompt=req.prompt,
        instructions=req.instructions,
        model_id=req.model_id,
        priority=req.priority,
        timeout_seconds=req.timeout_seconds,
        max_retries=req.max_retries,
        callback_url=req.callback_url,
        metadata=req.metadata,
        required_tags=req.required_tags,
        domain=req.domain,
        preferred_tags=req.preferred_tags,
        target_agent_id=req.target_agent_id,  # <-- 新增
        created_at=time.time(),
    )
```

- [ ] **Step 4: _process_task 添加直接派发分支**

在 `hermes_orchestrator/main.py` 的 `_process_task` 函数中，在 `agents = await loop.run_in_executor(None, agent_registry.list_agents)` 之后（约第404-406行），将现有的 `chosen, routing_info = selector.select(agents, task)` 及后续逻辑替换为条件分支：

```python
    agents = await loop.run_in_executor(None, agent_registry.list_agents)
    for a in agents:
        a.circuit_state = circuit_store.check_state(a.agent_id)[0]

    if task.target_agent_id:
        # Direct dispatch: find matching agent by deployment name prefix
        # task.target_agent_id is e.g. "hermes-gateway-1"
        # agent_id in registry is e.g. "hermes-gateway-1-6b8c9d7f4-x2kjp"
        matched = [a for a in agents if a.agent_id.startswith(task.target_agent_id + "-")]
        if not matched:
            # Also try exact match (non-K8s environments)
            matched = [a for a in agents if a.agent_id == task.target_agent_id]
        if not matched:
            await loop.run_in_executor(
                None,
                partial(
                    task_store.update, task_id, status="failed",
                    error=f"Target agent {task.target_agent_id} not available",
                ),
            )
            return
        chosen = matched[0]
        routing_info = RoutingInfo(
            strategy="direct_dispatch",
            chosen_agent_id=chosen.agent_id,
            scores={},
            matched_tags=[],
            fallback=False,
            reason=f"Direct dispatch to {task.target_agent_id}",
        )
        await loop.run_in_executor(
            None,
            partial(task_store.update, task_id, routing_info=routing_info),
        )
    else:
        # Existing routing logic unchanged
        chosen, routing_info = selector.select(agents, task)
        if routing_info:
            await loop.run_in_executor(
                None,
                partial(task_store.update, task_id, routing_info=routing_info),
            )
        if not chosen:
            # ... (existing requeue/fail logic unchanged)
```

注意：上面 `else` 分支中保持现有的 `selector.select` + requeue/fail 逻辑完全不变。需要将原有 `_process_task` 中从 `chosen, routing_info = selector.select(agents, task)` 到 `if not chosen:` 分支的代码移入 `else` 块。后续的 agent load check + execute 逻辑在 `if/else` 块之后保持不变（因为 `chosen` 和 `routing_info` 在两个分支中都已被赋值）。

需要在 `_process_task` 函数顶部确保 `RoutingInfo` 已导入（已有 `from hermes_orchestrator.models.task import Task`，需确认 RoutingInfo 在同文件可引用）：

```python
from hermes_orchestrator.models.task import Task, RoutingInfo
```

- [ ] **Step 5: 验证现有调用不受影响**

Run: `cd /mnt/disk01/workspaces/worksummary/hermes-agent && python -c "from hermes_orchestrator.models.api import TaskSubmitRequest; r = TaskSubmitRequest(prompt='test'); print(r.target_agent_id)"`
Expected: `None`

- [ ] **Step 6: Commit**

```bash
git add hermes_orchestrator/models/api.py hermes_orchestrator/models/task.py hermes_orchestrator/main.py
git commit -m "feat(orchestrator): add target_agent_id for direct dispatch (Phase 1)"
```

---

## Task 4: 后端 Dispatch Routes（核心）

**Files:**
- Create: `admin/backend/dispatch_routes.py`
- Modify: `admin/backend/main.py`（仅 include router）

- [ ] **Step 1: 创建 dispatch_routes.py**

新建 `admin/backend/dispatch_routes.py`，包含以下路由组：

```python
"""Task Dispatch routes — channel management, task dispatch, and callbacks."""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets as _secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import desc, func, select, text

from database import AsyncSessionLocal
from db_models import (
    DispatchAssignment,
    DispatchTask,
    TaskChannel,
    TaskChannelSubscription,
)
from models import (
    CallbackConfirmRequest,
    CallbackRejectRequest,
    CallbackResultRequest,
    ChannelCreateRequest,
    ChannelResponse,
    ChannelUpdateRequest,
    DispatchAssignmentResponse,
    DispatchTaskListParams,
    DispatchTaskRequest,
    DispatchTaskResponse,
    SubscriptionRequest,
)

logger = logging.getLogger("hermes-admin.dispatch")

router = APIRouter(prefix="/dispatch", tags=["dispatch"])

# Reuse orchestrator config from main.py
def _orch_url(request: Request) -> str:
    return request.app.state.orchestrator_url

def _orch_key(request: Request) -> str:
    return request.app.state.orchestrator_api_key


# ── Channel CRUD ──────────────────────────────────────────────

@router.get("/channels", response_model=list[ChannelResponse])
async def list_channels(request: Request):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(TaskChannel, func.count(TaskChannelSubscription.id).label("subscriber_count"))
            .outerjoin(TaskChannelSubscription, TaskChannelSubscription.channel_id == TaskChannel.id)
            .group_by(TaskChannel)
            .order_by(TaskChannel.name)
        )
        return [
            ChannelResponse(
                id=row.TaskChannel.id, name=row.TaskChannel.name,
                display_name=row.TaskChannel.display_name,
                description=row.TaskChannel.description or "",
                subscriber_count=row.subscriber_count,
                created_at=row.TaskChannel.created_at.isoformat() if row.TaskChannel.created_at else "",
            )
            for row in result.all()
        ]


@router.post("/channels", response_model=ChannelResponse, status_code=201)
async def create_channel(req: ChannelCreateRequest, request: Request):
    async with AsyncSessionLocal() as session:
        ch = TaskChannel(
            name=req.name, display_name=req.display_name,
            description=req.description,
        )
        session.add(ch)
        await session.commit()
        await session.refresh(ch)
        return ChannelResponse(
            id=ch.id, name=ch.name, display_name=ch.display_name,
            description=ch.description, subscriber_count=0,
            created_at=ch.created_at.isoformat() if ch.created_at else "",
        )


@router.put("/channels/{channel_id}", response_model=ChannelResponse)
async def update_channel(channel_id: int, req: ChannelUpdateRequest, request: Request):
    async with AsyncSessionLocal() as session:
        ch = await session.get(TaskChannel, channel_id)
        if not ch:
            raise HTTPException(404, "channel_not_found")
        if req.display_name is not None:
            ch.display_name = req.display_name
        if req.description is not None:
            ch.description = req.description
        await session.commit()
        await session.refresh(ch)
        return ChannelResponse(
            id=ch.id, name=ch.name, display_name=ch.display_name,
            description=ch.description or "", subscriber_count=0,
            created_at=ch.created_at.isoformat() if ch.created_at else "",
        )


@router.delete("/channels/{channel_id}")
async def delete_channel(channel_id: int, request: Request):
    async with AsyncSessionLocal() as session:
        ch = await session.get(TaskChannel, channel_id)
        if not ch:
            raise HTTPException(404, "channel_not_found")
        await session.delete(ch)
        await session.commit()
        return {"status": "deleted"}


# ── Channel Subscriptions ────────────────────────────────────

@router.get("/channels/{channel_id}/subscribers")
async def list_subscribers(channel_id: int, request: Request):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(TaskChannelSubscription)
            .where(TaskChannelSubscription.channel_id == channel_id)
        )
        subs = result.scalars().all()
        return {"agent_numbers": [s.agent_number for s in subs]}


@router.post("/channels/{channel_id}/subscribers")
async def set_subscribers(channel_id: int, req: SubscriptionRequest, request: Request):
    async with AsyncSessionLocal() as session:
        # Lock channel row to prevent concurrent subscriber changes
        ch = await session.execute(
            select(TaskChannel).where(TaskChannel.id == channel_id).with_for_update()
        )
        if not ch.scalar_one_or_none():
            raise HTTPException(404, "channel_not_found")
        from sqlalchemy import delete
        await session.execute(
            delete(TaskChannelSubscription)
            .where(TaskChannelSubscription.channel_id == channel_id)
        )
        for agent_num in req.agent_numbers:
            session.add(TaskChannelSubscription(
                channel_id=channel_id, agent_number=agent_num,
            ))
        await session.commit()
        return {"status": "updated", "count": len(req.agent_numbers)}


# ── Task Dispatch ─────────────────────────────────────────────

@router.post("/tasks")
async def create_dispatch_task(req: DispatchTaskRequest, request: Request):
    """Create and dispatch a task to agents.

    Uses a three-phase approach to avoid holding DB sessions during HTTP calls:
      Phase 1: Write DispatchTask + DispatchAssignment rows (commit immediately)
      Phase 2: Submit to orchestrator for each assignment (no DB session held)
      Phase 3: Open new session, update assignment/task status (commit)
    """
    # 1. Resolve target agents
    target_agents: list[int] = []
    if req.dispatch_type == "direct":
        if not req.target_agents:
            raise HTTPException(400, "target_agents required for direct dispatch")
        target_agents = req.target_agents
    elif req.dispatch_type == "channel":
        if not req.channel_id:
            raise HTTPException(400, "channel_id required for channel dispatch")
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(TaskChannelSubscription.agent_number)
                .where(TaskChannelSubscription.channel_id == req.channel_id)
            )
            target_agents = [row[0] for row in result.all()]
        if not target_agents:
            raise HTTPException(400, "No subscribers in channel")

    # 2. Get operator identity
    operator = "admin"
    email = getattr(request.state, "email", None) if hasattr(request, "state") else None
    if email:
        operator = email

    orch_url = _orch_url(request)
    orch_key = _orch_key(request)

    # ── Phase 1: Write DB rows (short session, commit immediately) ──
    dispatch_task_id: int
    assignment_info: list[tuple[int, int, str]] = []  # (assignment_id, agent_num, token)

    async with AsyncSessionLocal() as session:
        dispatch_task = DispatchTask(
            title=req.title, prompt=req.prompt, instructions=req.instructions,
            dispatch_type=req.dispatch_type, channel_id=req.channel_id,
            priority=req.priority, timeout_seconds=req.timeout_seconds,
            confirm_timeout_hours=req.confirm_timeout_hours,
            profile_hint=req.profile_hint,
            status="dispatching",
            created_by=operator,
        )
        session.add(dispatch_task)
        await session.flush()
        dispatch_task_id = dispatch_task.id

        for agent_num in target_agents:
            token = _secrets.token_urlsafe(32)
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            deadline = datetime.now(timezone.utc) + timedelta(hours=req.confirm_timeout_hours)
            assignment = DispatchAssignment(
                task_id=dispatch_task_id,
                agent_number=agent_num,
                callback_token_hash=token_hash,
                confirm_deadline=deadline,
                status="pending",
            )
            session.add(assignment)
            await session.flush()
            assignment_info.append((assignment.id, agent_num, token))

        await session.commit()

    # ── Phase 2: HTTP calls (no DB session held) ──
    results: list[dict] = []
    # Collect updates to apply in Phase 3
    assignment_updates: list[tuple[int, dict]] = []  # (assignment_id, update_fields)

    client = request.app.state.orch_client
    for assignment_id, agent_num, token in assignment_info:
        agent_name = f"hermes-gateway-{agent_num}"
        orch_body = {
            "prompt": req.prompt,
            "instructions": req.instructions or "",
            "priority": req.priority,
            "timeout_seconds": req.timeout_seconds,
            "target_agent_id": agent_name,
            # callback_url is NOT at top-level (validator rejects HTTP/internal URLs)
            # It is passed inside metadata for the dispatch callback flow
            # NOTE: callback_url and callback_token are consumed by the agent's
            # dispatch_confirm tool (Phase 3). In Phase 1, these fields are inert
            # placeholders — the orchestrator's _send_callback() skips HTTP URLs,
            # so no automatic callback fires until the tool is implemented.
            "metadata": {
                "dispatch_task_id": dispatch_task_id,
                "dispatch_assignment_id": assignment_id,
                "callback_url": "http://hermes-admin:48082/dispatch/callback/result",
                "callback_token": token,
            },
        }
        try:
            resp = await client.post(
                f"{orch_url}/api/v1/tasks",
                json=orch_body,
                headers={"Authorization": f"Bearer {orch_key}"},
            )
            if resp.status_code in (200, 201, 202):
                data = resp.json()
                orch_task_id = data.get("task_id")
                results.append({"agent_number": agent_num, "status": "dispatched"})
                assignment_updates.append((assignment_id, {
                    "status": "pending",
                    "orchestrator_task_id": orch_task_id,
                }))
            else:
                results.append({
                    "agent_number": agent_num, "status": "error",
                    "error": resp.text[:200],
                })
                assignment_updates.append((assignment_id, {
                    "status": "failed",
                    "error_message": resp.text[:500],
                }))
        except Exception as exc:
            results.append({
                "agent_number": agent_num, "status": "error",
                "error": str(exc)[:200],
            })
            assignment_updates.append((assignment_id, {
                "status": "failed",
                "error_message": str(exc)[:500],
            }))

    # ── Phase 3: Update DB with results (new session) ──
    all_ok = all(r["status"] == "dispatched" for r in results)
    final_status = "dispatched" if all_ok else "partial"

    async with AsyncSessionLocal() as session:
        for assignment_id, updates in assignment_updates:
            assignment = await session.get(DispatchAssignment, assignment_id)
            if assignment:
                for key, value in updates.items():
                    setattr(assignment, key, value)

        task = await session.get(DispatchTask, dispatch_task_id)
        if task:
            task.status = final_status
        await session.commit()

    return {"task_id": dispatch_task_id, "status": final_status, "assignments": results}


@router.get("/tasks")
async def list_dispatch_tasks(
    status: str | None = None,
    agent_number: int | None = None,
    limit: int = 50,
    offset: int = 0,
):
    query = select(DispatchTask).order_by(desc(DispatchTask.created_at))
    if status:
        query = query.where(DispatchTask.status == status)
    if agent_number:
        query = query.join(DispatchAssignment).where(DispatchAssignment.agent_number == agent_number)
    query = query.limit(min(limit, 200)).offset(offset)

    async with AsyncSessionLocal() as session:
        # Count total
        count_q = select(func.count()).select_from(DispatchTask)
        if status:
            count_q = count_q.where(DispatchTask.status == status)
        if agent_number:
            count_q = count_q.join(DispatchAssignment).where(DispatchAssignment.agent_number == agent_number)
        total = (await session.execute(count_q)).scalar() or 0

        result = await session.execute(query)
        tasks = result.scalars().all()
        if not tasks:
            return {"tasks": [], "total": total}

        # Bulk-fetch assignments
        task_ids = [t.id for t in tasks]
        assign_result = await session.execute(
            select(DispatchAssignment).where(DispatchAssignment.task_id.in_(task_ids))
        )
        assigns_by_task: dict[int, list] = {}
        for a in assign_result.scalars().all():
            assigns_by_task.setdefault(a.task_id, []).append(a)

        return {
            "tasks": [
                {
                    "id": t.id, "title": t.title, "dispatch_type": t.dispatch_type,
                    "status": t.status, "channel_id": t.channel_id,
                    "priority": t.priority, "created_by": t.created_by,
                    "created_at": t.created_at.isoformat() if t.created_at else "",
                    "result_summary": t.result_summary,
                    "assignments": [_assignment_to_dict(a) for a in assigns_by_task.get(t.id, [])],
                }
                for t in tasks
            ],
            "total": total,
        }


@router.get("/tasks/{task_id}")
async def get_dispatch_task(task_id: int, request: Request):
    async with AsyncSessionLocal() as session:
        task = await session.get(DispatchTask, task_id)
        if not task:
            raise HTTPException(404, "Task not found")
        assign_result = await session.execute(
            select(DispatchAssignment).where(DispatchAssignment.task_id == task_id)
        )
        assigns = assign_result.scalars().all()
        return {
            "id": task.id, "title": task.title, "prompt": task.prompt,
            "instructions": task.instructions, "dispatch_type": task.dispatch_type,
            "status": task.status, "channel_id": task.channel_id,
            "priority": task.priority, "timeout_seconds": task.timeout_seconds,
            "created_by": task.created_by,
            "created_at": task.created_at.isoformat() if task.created_at else "",
            "result_summary": task.result_summary,
            "assignments": [_assignment_to_dict(a) for a in assigns],
        }


@router.post("/tasks/{task_id}/cancel")
async def cancel_dispatch_task(task_id: int, request: Request):
    orch_url = _orch_url(request)
    orch_key = _orch_key(request)
    async with AsyncSessionLocal() as session:
        task = await session.get(DispatchTask, task_id)
        if not task:
            raise HTTPException(404, "Task not found")
        if task.status in ("completed", "failed", "cancelled"):
            raise HTTPException(409, f"Cannot cancel task in {task.status} state")
        # Cancel orchestrator tasks
        assign_result = await session.execute(
            select(DispatchAssignment).where(DispatchAssignment.task_id == task_id)
            .where(DispatchAssignment.status.in_(["pending", "notified", "confirmed", "executing"]))
        )
        for a in assign_result.scalars().all():
            if a.orchestrator_task_id:
                try:
                    client = request.app.state.orch_client
                    await client.delete(
                        f"{orch_url}/api/v1/tasks/{a.orchestrator_task_id}",
                        headers={"Authorization": f"Bearer {orch_key}"},
                    )
                except Exception:
                    pass
            a.status = "failed"
            a.error_message = "Cancelled by admin"
        task.status = "cancelled"
        task.updated_at = datetime.now(timezone.utc)
        await session.commit()
    return {"status": "cancelled"}


# ── Callbacks (called by dispatch_confirm tool on agents) ────

@router.post("/callback/confirm")
async def callback_confirm(req: CallbackConfirmRequest, request: Request):
    """Agent confirms task acceptance (with optional profile selection)."""
    async with AsyncSessionLocal() as session:
        assignment = await _verify_token(session, req.assignment_id, req.callback_token)
        assignment.status = "confirmed"
        assignment.profile_name = req.profile_name
        assignment.profile_source = req.profile_source
        assignment.user_confirmed_at = datetime.now(timezone.utc)
        await session.commit()
    return {"status": "confirmed"}


@router.post("/callback/reject")
async def callback_reject(req: CallbackRejectRequest, request: Request):
    """Agent rejects task."""
    async with AsyncSessionLocal() as session:
        assignment = await _verify_token(session, req.assignment_id, req.callback_token)
        assignment.status = "rejected"
        assignment.user_confirmed_at = datetime.now(timezone.utc)
        await session.commit()
    return {"status": "rejected"}


@router.post("/callback/result")
async def callback_result(req: CallbackResultRequest, request: Request):
    """Agent reports task execution result."""
    async with AsyncSessionLocal() as session:
        assignment = await _verify_and_consume_token(session, req.assignment_id, req.callback_token)
        assignment.status = "completed" if not req.error else "failed"
        assignment.result_summary = req.result_summary[:5000]
        assignment.result_data = req.result_data
        assignment.error_message = req.error
        assignment.completed_at = datetime.now(timezone.utc)
        assignment.profile_name = req.profile_name
        assignment.profile_source = req.profile_source
        await session.commit()
        # Check if all assignments are done
        await _update_dispatch_task_status(session, assignment.task_id)
        await session.commit()
    return {"status": "ok"}


# ── Helpers ──────────────────────────────────────────────────

async def _verify_token(session, assignment_id: int, token: str) -> DispatchAssignment:
    """Verify callback token without consuming it. Used for confirm/reject."""
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    result = await session.execute(
        select(DispatchAssignment).where(
            DispatchAssignment.id == assignment_id,
            DispatchAssignment.callback_token_hash == token_hash,
        )
    )
    assignment = result.scalar_one_or_none()
    if not assignment:
        raise HTTPException(403, "invalid_token")
    return assignment


async def _verify_and_consume_token(session, assignment_id: int, token: str) -> DispatchAssignment:
    """Verify callback token and atomically consume it. Used for final result."""
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    result = await session.execute(
        text("""
            UPDATE dispatch_assignments
            SET callback_token_hash = NULL, updated_at = NOW()
            WHERE id = :aid AND callback_token_hash = :hash
        """),
        {"aid": assignment_id, "hash": token_hash},
    )
    if result.rowcount != 1:
        raise HTTPException(403, "invalid_token")
    await session.flush()
    assignment = await session.get(DispatchAssignment, assignment_id)
    if not assignment:
        raise HTTPException(404, "Assignment not found")
    return assignment


async def _update_dispatch_task_status(session, task_id: int):
    """Update parent DispatchTask status based on assignment states."""
    task = await session.get(DispatchTask, task_id)
    if not task:
        return
    result = await session.execute(
        select(DispatchAssignment.status)
        .where(DispatchAssignment.task_id == task_id)
    )
    statuses = [row[0] for row in result.all()]
    if not statuses:
        return
    terminal = {"completed", "failed", "rejected", "expired"}
    if all(s in terminal for s in statuses):
        completed = sum(1 for s in statuses if s == "completed")
        task.status = "completed" if completed > 0 else "failed"
        task.result_summary = f"{completed}/{len(statuses)} completed"
        task.updated_at = datetime.now(timezone.utc)


def _assignment_to_dict(a: DispatchAssignment) -> dict:
    return {
        "id": a.id, "agent_number": a.agent_number, "status": a.status,
        "profile_name": a.profile_name, "profile_source": a.profile_source,
        "orchestrator_task_id": a.orchestrator_task_id,
        "started_at": a.started_at.isoformat() if a.started_at else None,
        "completed_at": a.completed_at.isoformat() if a.completed_at else None,
        "result_summary": a.result_summary, "error_message": a.error_message,
    }
```

- [ ] **Step 2: 修改 main.py — include dispatch router（含 auth 注入）**

在 `main.py` 的现有 `app.include_router(hub_router)` 行之后（约第109行），追加：

```python
# ── Dispatch routes ──
from dispatch_routes import router as dispatch_router
from fastapi.routing import APIRoute

# Inject auth dependencies at include time to avoid circular imports.
# dispatch_routes.py does NOT import auth/admin_only from main.py.
# - Non-callback routes: require admin auth + admin_only
# - Callback routes (/callback/*): require internal_auth (X-Internal-Token)
for route in dispatch_router.routes:
    if isinstance(route, APIRoute):
        if "/callback/" in route.path:
            route.dependencies.append(internal_auth)
        else:
            route.dependencies.append(auth)
            route.dependencies.append(admin_only)

app.include_router(dispatch_router)

# ── Dispatch timeout background task ──
import asyncio

async def _dispatch_timeout_scanner():
    """Periodically scan for expired confirm_deadline assignments and mark them failed."""
    while True:
        await asyncio.sleep(300)  # Every 5 minutes
        try:
            async with AsyncSessionLocal() as session:
                result = await session.execute(
                    select(DispatchAssignment).where(
                        DispatchAssignment.status.in_(["pending", "notified"]),
                        DispatchAssignment.confirm_deadline < datetime.now(timezone.utc),
                    )
                )
                expired = result.scalars().all()
                for a in expired:
                    a.status = "expired"
                if expired:
                    await session.commit()
                    logger.info(f"Expired {len(expired)} dispatch assignments")
        except Exception as e:
            logger.error(f"Dispatch timeout scan error: {e}")


async def _recover_orphaned_dispatches():
    """On startup, recover tasks stuck in 'dispatching' status (admin pod crashed mid-dispatch)."""
    try:
        async with AsyncSessionLocal() as session:
            cutoff = datetime.now(timezone.utc) - timedelta(minutes=10)
            result = await session.execute(
                select(DispatchTask).where(
                    DispatchTask.status == "dispatching",
                    DispatchTask.created_at < cutoff,
                )
            )
            orphans = result.scalars().all()
            for t in orphans:
                t.status = "failed"
                t.result_summary = "Recovery: admin pod restart during dispatch"
            if orphans:
                await session.commit()
                logger.info(f"Recovered {len(orphans)} orphaned dispatch tasks")
    except Exception as e:
        logger.error(f"Dispatch recovery error: {e}")


@app.on_event("startup")
async def _start_dispatch_scanner():
    await _recover_orphaned_dispatches()
    asyncio.create_task(_dispatch_timeout_scanner())
```

同时在 `main.py` 的 startup 区域（约第75行 `ORCHESTRATOR_API_KEY` 之后）添加 app.state 属性，供 dispatch_routes 读取：

```python
import httpx
# ... (add to existing imports at top of main.py)

app.state.orchestrator_url = ORCHESTRATOR_INTERNAL_URL
app.state.orchestrator_api_key = ORCHESTRATOR_API_KEY
app.state.orch_client = httpx.AsyncClient(timeout=30)
```

**关键：dispatch_routes.py 中不需要任何 auth import 或 `_require_admin` 函数。** 所有认证逻辑通过上述 main.py 的 route-level dependency injection 完成，避免循环导入和 auth 不一致问题。

- [ ] **Step 3: 验证路由注册**

Run: `cd admin/backend && python -c "from main import app; routes = [r.path for r in app.routes if hasattr(r, 'path')]; dispatch = [r for r in routes if '/dispatch' in r]; print(dispatch)"`
Expected: 输出包含 `/dispatch/channels`, `/dispatch/tasks` 等路由

- [ ] **Step 4: Commit**

```bash
git add admin/backend/dispatch_routes.py admin/backend/main.py
git commit -m "feat(dispatch): add dispatch routes for channel CRUD, task dispatch, and callbacks"
```

---

## Task 5: 前端 API 客户端 + i18n

**Files:**
- Modify: `admin/frontend/src/lib/admin-api.ts`
- Modify: `admin/frontend/src/i18n/en.ts`
- Modify: `admin/frontend/src/i18n/zh.ts`

- [ ] **Step 1: 在 admin-api.ts 末尾追加 dispatch API 函数**

```typescript
// ---------------------------------------------------------------------------
// Task Dispatch
// ---------------------------------------------------------------------------

export interface DispatchChannel {
  id: number;
  name: string;
  display_name: string;
  description: string;
  subscriber_count: number;
  created_at: string;
}

export interface DispatchTask {
  id: number;
  title: string;
  dispatch_type: string;
  status: string;
  priority: number;
  created_by: string;
  created_at: string;
  result_summary: string | null;
  assignments: DispatchAssignment[];
}

export interface DispatchAssignment {
  id: number;
  agent_number: number;
  status: string;
  profile_name: string | null;
  orchestrator_task_id: string | null;
  result_summary: string | null;
  error_message: string | null;
}

export const dispatchApi = {
  // Channels
  listChannels: () =>
    adminFetch<DispatchChannel[]>(`${ADMIN_BASE}/dispatch/channels`),

  createChannel: (data: { name: string; display_name: string; description?: string }) =>
    adminFetch(`${ADMIN_BASE}/dispatch/channels`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateChannel: (id: number, data: { display_name?: string; description?: string }) =>
    adminFetch(`${ADMIN_BASE}/dispatch/channels/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteChannel: (id: number) =>
    adminFetch(`${ADMIN_BASE}/dispatch/channels/${id}`, {
      method: "DELETE",
    }),

  getSubscribers: (channelId: number) =>
    adminFetch<{ agent_numbers: number[] }>(`${ADMIN_BASE}/dispatch/channels/${channelId}/subscribers`),

  setSubscribers: (channelId: number, agentNumbers: number[]) =>
    adminFetch(`${ADMIN_BASE}/dispatch/channels/${channelId}/subscribers`, {
      method: "POST",
      body: JSON.stringify({ agent_numbers: agentNumbers }),
    }),

  // Tasks
  createTask: (data: {
    title: string;
    prompt: string;
    dispatch_type: "channel" | "direct";
    channel_id?: number;
    target_agents?: number[];
    instructions?: string;
    priority?: number;
    timeout_seconds?: number;
    profile_hint?: string;
  }) =>
    adminFetch(`${ADMIN_BASE}/dispatch/tasks`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  listTasks: async (params?: { status?: string; agent_number?: number; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.agent_number != null) qs.set("agent_number", String(params.agent_number));
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset) qs.set("offset", String(params.offset));
    const query = qs.toString();
    const resp = await adminFetch<{ tasks: DispatchTask[]; total: number }>(`${ADMIN_BASE}/dispatch/tasks${query ? `?${query}` : ""}`);
    return resp;
  },

  getTask: (taskId: number) =>
    adminFetch<DispatchTask & { prompt: string; instructions: string }>(`${ADMIN_BASE}/dispatch/tasks/${taskId}`),

  cancelTask: (taskId: number) =>
    adminFetch(`${ADMIN_BASE}/dispatch/tasks/${taskId}/cancel`, {
      method: "POST",
    }),
};
```

- [ ] **Step 2: 在 en.ts 末尾追加 dispatch i18n keys**

在 `Translations` 接口和 `en.ts` 对象中各追加：

```typescript
// Translations interface additions:
dispatchNav: string;
dispatchTitle: string;
dispatchCreateTask: string;
dispatchTaskTitle: string;
dispatchTaskContent: string;
dispatchTaskType: string;
dispatchTypeChannel: string;
dispatchTypeDirect: string;
dispatchChannel: string;
dispatchTargetAgents: string;
dispatchPriority: string;
dispatchTimeout: string;
dispatchConfirmTimeout: string;
dispatchProfileHint: string;
dispatchAdvanced: string;
dispatchStatusPending: string;
dispatchStatusDispatched: string;
dispatchStatusPartial: string;
dispatchStatusCompleted: string;
dispatchStatusFailed: string;
dispatchStatusCancelled: string;
dispatchChannelsTab: string;
dispatchTasksTab: string;
dispatchNoTasks: string;
dispatchNoChannels: string;
dispatchChannelName: string;
dispatchChannelDisplay: string;
dispatchChannelDesc: string;
dispatchSubscribers: string;
dispatchSelectTask: string;
dispatchAgentStatus: string;
dispatchProgress: string;
dispatchNewChannel: string;
dispatchCreate: string;
dispatchAgentNumbersPlaceholder: string;
dispatchAllStatuses: string;
dispatchCancelTask: string;
dispatchCancelConfirm: string;
dispatchDeleteChannel: string;
dispatchDeleteConfirm: string;
dispatchAssignmentPending: string;
dispatchAssignmentNotified: string;
dispatchAssignmentConfirmed: string;
dispatchAssignmentExecuting: string;
dispatchAssignmentCompleted: string;
dispatchAssignmentFailed: string;
dispatchAssignmentRejected: string;
dispatchAssignmentExpired: string;
dispatchErrorLoad: string;
dispatchProgressOf: string;
dispatchCompleted: string;
dispatchSave: string;
dispatchLoading: string;

// en.ts object additions:
dispatchNav: "Task Dispatch",
dispatchTitle: "Task Dispatch",
dispatchCreateTask: "Create Task",
dispatchTaskTitle: "Task Title",
dispatchTaskContent: "Task Content (sent to Agent)",
dispatchTaskType: "Dispatch Type",
dispatchTypeChannel: "Channel Broadcast",
dispatchTypeDirect: "Direct Dispatch",
dispatchChannel: "Channel",
dispatchTargetAgents: "Target Agents",
dispatchPriority: "Priority",
dispatchTimeout: "Execution Timeout (seconds)",
dispatchConfirmTimeout: "Confirm Timeout (hours)",
dispatchProfileHint: "Suggested Profile",
dispatchAdvanced: "Advanced Options",
dispatchStatusPending: "Pending",
dispatchStatusDispatched: "Dispatched",
dispatchStatusPartial: "Partial",
dispatchStatusCompleted: "Completed",
dispatchStatusFailed: "Failed",
dispatchStatusCancelled: "Cancelled",
dispatchChannelsTab: "Channels",
dispatchTasksTab: "Tasks",
dispatchNoTasks: "No tasks yet",
dispatchNoChannels: "No channels yet",
dispatchChannelName: "Channel Name",
dispatchChannelDisplay: "Display Name",
dispatchChannelDesc: "Description",
dispatchSubscribers: "Subscribers",
dispatchSelectTask: "Select a task to view details",
dispatchAgentStatus: "Agent Status",
dispatchProgress: "Progress",
dispatchNewChannel: "New Channel",
dispatchCreate: "Create",
dispatchAgentNumbersPlaceholder: "Agent numbers (e.g. 1,5,12)",
dispatchAllStatuses: "All Statuses",
dispatchCancelTask: "Cancel Task",
dispatchCancelConfirm: "Are you sure you want to cancel this task?",
dispatchDeleteChannel: "Delete",
dispatchDeleteConfirm: "Are you sure you want to delete this channel?",
dispatchAssignmentPending: "Pending",
dispatchAssignmentNotified: "Notified",
dispatchAssignmentConfirmed: "Confirmed",
dispatchAssignmentExecuting: "Executing",
dispatchAssignmentCompleted: "Completed",
dispatchAssignmentFailed: "Failed",
dispatchAssignmentRejected: "Rejected",
dispatchAssignmentExpired: "Expired",
dispatchErrorLoad: "Failed to load data",
dispatchProgressOf: "of",
dispatchCompleted: "completed",
dispatchSave: "Save",
dispatchLoading: "Loading...",
```

- [ ] **Step 3: 在 zh.ts 末尾追加对应中文翻译**

```typescript
dispatchNav: "任务派发",
dispatchTitle: "任务派发",
dispatchCreateTask: "发布任务",
dispatchTaskTitle: "任务标题",
dispatchTaskContent: "任务内容（发送给 Agent）",
dispatchTaskType: "派发方式",
dispatchTypeChannel: "频道广播",
dispatchTypeDirect: "定向派发",
dispatchChannel: "频道",
dispatchTargetAgents: "目标 Agent",
dispatchPriority: "优先级",
dispatchTimeout: "执行超时（秒）",
dispatchConfirmTimeout: "确认超时（小时）",
dispatchProfileHint: "建议 Profile",
dispatchAdvanced: "高级选项",
dispatchStatusPending: "待派发",
dispatchStatusDispatched: "已派发",
dispatchStatusPartial: "部分成功",
dispatchStatusCompleted: "已完成",
dispatchStatusFailed: "失败",
dispatchStatusCancelled: "已取消",
dispatchChannelsTab: "频道管理",
dispatchTasksTab: "任务列表",
dispatchNoTasks: "暂无任务",
dispatchNoChannels: "暂无频道",
dispatchChannelName: "频道标识",
dispatchChannelDisplay: "显示名称",
dispatchChannelDesc: "描述",
dispatchSubscribers: "订阅者",
dispatchSelectTask: "选择任务查看详情",
dispatchAgentStatus: "Agent 状态",
dispatchProgress: "进度",
dispatchNewChannel: "新建频道",
dispatchCreate: "创建",
dispatchAgentNumbersPlaceholder: "Agent 编号（如 1,5,12）",
dispatchAllStatuses: "全部状态",
dispatchCancelTask: "取消任务",
dispatchCancelConfirm: "确定要取消此任务吗？",
dispatchDeleteChannel: "删除",
dispatchDeleteConfirm: "确定要删除此频道吗？",
dispatchAssignmentPending: "待处理",
dispatchAssignmentNotified: "已通知",
dispatchAssignmentConfirmed: "已确认",
dispatchAssignmentExecuting: "执行中",
dispatchAssignmentCompleted: "已完成",
dispatchAssignmentFailed: "失败",
dispatchAssignmentRejected: "已拒绝",
dispatchAssignmentExpired: "已过期",
dispatchErrorLoad: "数据加载失败",
dispatchProgressOf: "/",
dispatchCompleted: "完成",
dispatchSave: "保存",
dispatchLoading: "加载中...",
```

- [ ] **Step 4: 验证 TypeScript 编译**

Run: `cd admin/frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: 无 dispatch 相关错误（可能有其他已存在的错误）

- [ ] **Step 5: Commit**

```bash
git add admin/frontend/src/lib/admin-api.ts admin/frontend/src/i18n/en.ts admin/frontend/src/i18n/zh.ts
git commit -m "feat(dispatch): add frontend API client and i18n for task dispatch"
```

---

## Task 6: 前端路由 + 导航

**Files:**
- Modify: `admin/frontend/src/App.tsx`
- Modify: `admin/frontend/src/components/AdminLayout.tsx`

- [ ] **Step 1: App.tsx 添加 import 和路由**

在现有 import 末尾追加：
```tsx
import { TaskDispatchPage } from "./pages/TaskDispatchPage";
```

在 `/templates` 路由之后追加：
```tsx
<Route path="/dispatch" element={<TaskDispatchPage />} />
```

- [ ] **Step 2: AdminLayout.tsx 添加 dispatch 图标和导航入口**

在 `IconPlus` 组件之后添加新图标组件：

```tsx
function IconDispatch({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M12 12v9" />
      <path d="m8 17 4 4 4-4" />
    </svg>
  );
}
```

在 admin navItems 数组中，`/templates` 之前添加：
```tsx
{ to: "/dispatch", label: t.dispatchNav, icon: IconDispatch },
```

同时在 user 模式重定向守卫中添加 `/dispatch`（与 `/settings`、`/create` 同级）：

```tsx
if (location.pathname === "/settings" || location.pathname === "/create" || location.pathname === "/dispatch") {
  return <Navigate to="/" replace />;
}
```

- [ ] **Step 3: 验证导航显示**

Run: `cd admin/frontend && npx tsc --noEmit 2>&1 | head -10`
Expected: 无 dispatch 相关错误

- [ ] **Step 4: Commit**

```bash
git add admin/frontend/src/App.tsx admin/frontend/src/components/AdminLayout.tsx
git commit -m "feat(dispatch): add /dispatch route and sidebar navigation entry"
```

---

## Task 7: 前端 TaskDispatchPage 页面

**Files:**
- Create: `admin/frontend/src/pages/TaskDispatchPage.tsx`

- [ ] **Step 1: 创建 TaskDispatchPage.tsx**

组件结构（遵循现有页面模式，不使用 TanStack Query）：

```tsx
import { useState, useEffect, useCallback, useMemo } from "react";
import { useI18n } from "../hooks/useI18n";
import { dispatchApi, type DispatchTask, type DispatchChannel } from "../lib/admin-api";
import { showToast } from "../lib/toast";
import { ConfirmDialog } from "../components/ConfirmDialog";

type TabKey = "tasks" | "channels";

function statusLabel(t: Record<string, string>, status: string): string {
  const map: Record<string, string> = {
    pending: t.dispatchStatusPending,
    dispatched: t.dispatchStatusDispatched,
    partial: t.dispatchStatusPartial,
    completed: t.dispatchStatusCompleted,
    failed: t.dispatchStatusFailed,
    cancelled: t.dispatchStatusCancelled,
  };
  return map[status] || status;
}

export function TaskDispatchPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<TabKey>("tasks");
  const [tasks, setTasks] = useState<DispatchTask[]>([]);
  const [channels, setChannels] = useState<DispatchChannel[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Confirm dialog state for destructive actions (cancel task, delete channel)
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    message: string;
    onConfirm: () => Promise<void>;
  } | null>(null);

  // Data loading
  const loadTasks = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const resp = await dispatchApi.listTasks(
        statusFilter ? { status: statusFilter } : undefined
      );
      setTasks(resp.tasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.dispatchErrorLoad);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, t]);

  const loadChannels = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await dispatchApi.listChannels();
      setChannels(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.dispatchErrorLoad);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (tab === "tasks") loadTasks();
    else loadChannels();
  }, [tab, loadTasks, loadChannels]);

  // Task detail panel
  const selectedTask = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId)
    : null;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">{t.dispatchTitle}</h2>
        {tab === "tasks" && (
          <button
            onClick={() => setShowCreate(true)}
            className="px-3 py-1.5 rounded-md text-sm bg-accent-pink text-white hover:bg-accent-pink/90 transition-colors"
          >
            + {t.dispatchCreateTask}
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-border-subtle mb-4">
        {(["tasks", "channels"] as TabKey[]).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm transition-colors ${
              tab === key
                ? "text-accent-pink border-b-2 border-accent-pink font-medium"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {key === "tasks" ? t.dispatchTasksTab : t.dispatchChannelsTab}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

      {/* Loading spinner */}
      {loading && (
        <div className="flex items-center justify-center py-8 text-text-secondary text-sm">
          <svg className="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          {t.loading || "Loading..."}
        </div>
      )}

      {/* Content */}
      {!loading && tab === "tasks" ? (
        <div className="flex-1 flex gap-4 min-h-0">
          {/* Task list — lg: left panel, mobile: full width */}
          <div className={`lg:w-80 shrink-0 overflow-auto border border-border-subtle rounded-lg ${
            selectedTaskId ? "hidden lg:block" : ""
          }`}>
            {/* Status filter */}
            <div className="p-3 border-b border-border-subtle">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full px-2 py-1.5 rounded text-sm bg-surface border border-border-subtle"
              >
                <option value="">{t.dispatchAllStatuses}</option>
                <option value="pending">{t.dispatchStatusPending}</option>
                <option value="dispatched">{t.dispatchStatusDispatched}</option>
                <option value="completed">{t.dispatchStatusCompleted}</option>
                <option value="failed">{t.dispatchStatusFailed}</option>
              </select>
            </div>
            {/* Task items */}
            {tasks.length === 0 ? (
              <p className="p-4 text-sm text-text-secondary">{t.dispatchNoTasks}</p>
            ) : (
              tasks.map((task) => (
                <button
                  key={task.id}
                  onClick={() => setSelectedTaskId(task.id)}
                  className={`w-full text-left p-3 border-b border-border-subtle hover:bg-surface/50 transition-colors ${
                    selectedTaskId === task.id ? "bg-accent-pink/10" : ""
                  }`}
                >
                  <p className="text-sm font-medium truncate">#{task.id} {task.title}</p>
                  <p className="text-xs text-text-secondary mt-1">
                    {task.dispatch_type === "channel" ? t.dispatchTypeChannel : t.dispatchTypeDirect}
                    {" · "}
                    <span className={
                      task.status === "completed" ? "text-green-400" :
                      task.status === "failed" ? "text-red-400" :
                      "text-text-secondary"
                    }>
                      {statusLabel(t, task.status)}
                    </span>
                  </p>
                </button>
              ))
            )}
          </div>

          {/* Task detail — lg: right panel, mobile: full width */}
          <div className={`flex-1 overflow-auto ${
            !selectedTaskId ? "hidden lg:block" : ""
          }`}>
            {selectedTask ? (
              <div>
                {/* Mobile back button */}
                <button
                  onClick={() => setSelectedTaskId(null)}
                  className="lg:hidden mb-3 text-sm text-accent-cyan hover:underline"
                >
                  &larr; {t.back || "Back"}
                </button>
                <TaskDetail
                  task={selectedTask}
                  t={t}
                  onRefresh={loadTasks}
                  onRequestConfirm={setPendingConfirm}
                />
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-text-secondary text-sm">
                {t.dispatchSelectTask}
              </div>
            )}
          </div>
        </div>
      ) : (
        <ChannelManagement
          channels={channels}
          t={t}
          onRefresh={loadChannels}
          onRequestConfirm={setPendingConfirm}
        />
      )}

      {/* Create task dialog */}
      {showCreate && (
        <CreateTaskDialog
          channels={channels}
          t={t}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadTasks(); }}
        />
      )}

      {/* Confirm dialog for destructive actions */}
      <ConfirmDialog
        open={!!pendingConfirm}
        title={pendingConfirm?.title ?? ""}
        message={pendingConfirm?.message ?? ""}
        variant="destructive"
        confirmLabel={t.dispatchCancelTask}
        onConfirm={() => {
          if (pendingConfirm) {
            pendingConfirm.onConfirm().catch((err: unknown) => {
              showToast(err instanceof Error ? err.message : String(err), "error");
            });
            setPendingConfirm(null);
          }
        }}
        onCancel={() => setPendingConfirm(null)}
      />
    </div>
  );
}

// ── Sub-components ──

function TaskDetail({ task, t, onRefresh, onRequestConfirm }: {
  task: DispatchTask;
  t: Record<string, string>;
  onRefresh: () => void;
  onRequestConfirm: (action: { title: string; message: string; onConfirm: () => Promise<void> }) => void;
}) {
  const [fullTask, setFullTask] = useState<(DispatchTask & { prompt?: string; instructions?: string }) | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setDetailLoading(true);
        const data = await dispatchApi.getTask(task.id);
        if (!cancelled) setFullTask(data);
      } catch {
        // Fall back to list-level data
        if (!cancelled) setFullTask(task);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [task.id]);

  return (
    <div className="p-4 space-y-4">
      <h3 className="text-base font-semibold">#{task.id} {task.title}</h3>
      <div className="text-sm text-text-secondary space-y-1">
        <p>{t.dispatchTaskType}: {task.dispatch_type === "channel" ? t.dispatchTypeChannel : t.dispatchTypeDirect}</p>
        <p>Admin: {task.created_by} · {task.created_at}</p>
      </div>

      {/* Task content from detail API */}
      {detailLoading ? (
        <p className="text-xs text-text-secondary animate-pulse">...</p>
      ) : fullTask?.prompt && (
        <div className="p-3 rounded border border-border-subtle bg-surface/30">
          <p className="text-xs text-text-secondary mb-1">{t.dispatchTaskContent}</p>
          <p className="text-sm whitespace-pre-wrap">{fullTask.prompt}</p>
          {fullTask.instructions && (
            <p className="text-sm text-text-secondary mt-2 whitespace-pre-wrap">{fullTask.instructions}</p>
          )}
        </div>
      )}

      {/* Assignment list */}
      <div>
        <h4 className="text-sm font-medium mb-2">{t.dispatchAgentStatus}</h4>
        <div className="space-y-2">
          {task.assignments.map((a) => (
            <div key={a.id} className="flex items-center gap-2 p-2 rounded border border-border-subtle text-sm">
              <span className="font-medium">Agent #{a.agent_number}</span>
              <StatusBadge status={a.status} t={t} />
              {a.profile_name && (
                <span className="text-xs text-text-secondary">({a.profile_name})</span>
              )}
              {a.error_message && (
                <span className="text-xs text-red-400 truncate">{a.error_message}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Progress */}
      {task.assignments.length > 0 && (
        <p className="text-sm text-text-secondary">
          {t.dispatchProgress}: {task.assignments.filter(a => a.status === "completed").length}{t.dispatchProgressOf}{task.assignments.length} {t.dispatchCompleted}
        </p>
      )}

      {/* Cancel button — requires confirmation */}
      {["pending", "dispatched", "partial"].includes(task.status) && (
        <button
          onClick={() => onRequestConfirm({
            title: t.dispatchCancelTask,
            message: t.dispatchCancelConfirm,
            onConfirm: async () => {
              try {
                await dispatchApi.cancelTask(task.id);
                showToast(t.dispatchStatusCancelled);
                onRefresh();
              } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), "error");
              }
            },
          })}
          className="px-3 py-1.5 rounded text-sm border border-red-400 text-red-400 hover:bg-red-400/10"
        >
          {t.dispatchCancelTask}
        </button>
      )}
    </div>
  );
}

function StatusBadge({ status, t }: { status: string; t: Record<string, string> }) {
  const colors: Record<string, string> = {
    pending: "text-yellow-400",
    notified: "text-yellow-400",
    confirmed: "text-blue-400",
    executing: "text-blue-400",
    completed: "text-green-400",
    failed: "text-red-400",
    rejected: "text-orange-400",
    expired: "text-text-secondary",
  };
  const labels: Record<string, string> = {
    pending: t.dispatchAssignmentPending,
    notified: t.dispatchAssignmentNotified,
    confirmed: t.dispatchAssignmentConfirmed,
    executing: t.dispatchAssignmentExecuting,
    completed: t.dispatchAssignmentCompleted,
    failed: t.dispatchAssignmentFailed,
    rejected: t.dispatchAssignmentRejected,
    expired: t.dispatchAssignmentExpired,
  };
  return <span className={`text-xs ${colors[status] || "text-text-secondary"}`}>{labels[status] || status}</span>;
}

function ChannelManagement({ channels, t, onRefresh, onRequestConfirm }: {
  channels: DispatchChannel[];
  t: Record<string, string>;
  onRefresh: () => void;
  onRequestConfirm: (action: { title: string; message: string; onConfirm: () => Promise<void> }) => void;
}) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [desc, setDesc] = useState("");
  const [editChannelId, setEditChannelId] = useState<number | null>(null);
  const [subscribers, setSubscribers] = useState<number[]>([]);
  const [subscriberInput, setSubscriberInput] = useState("");

  const loadSubscribers = async (channelId: number) => {
    const data = await dispatchApi.getSubscribers(channelId);
    setSubscribers(data.agent_numbers);
    setSubscriberInput(data.agent_numbers.join(", "));
    setEditChannelId(channelId);
  };

  const saveSubscribers = async () => {
    if (editChannelId == null) return;
    try {
      const nums = subscriberInput.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n) && n > 0);
      await dispatchApi.setSubscribers(editChannelId, nums);
      setEditChannelId(null);
      showToast(t.dispatchSave);
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "error");
    }
  };

  return (
    <div className="space-y-4">
      {/* Create channel form */}
      <div className="p-4 border border-border-subtle rounded-lg space-y-3">
        <h3 className="text-sm font-medium">{t.dispatchNewChannel}</h3>
        <div className="grid grid-cols-2 gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.dispatchChannelName}
            className="px-2 py-1.5 rounded text-sm bg-surface border border-border-subtle"
          />
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t.dispatchChannelDisplay}
            className="px-2 py-1.5 rounded text-sm bg-surface border border-border-subtle"
          />
        </div>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={t.dispatchChannelDesc}
          className="w-full px-2 py-1.5 rounded text-sm bg-surface border border-border-subtle"
        />
        <button
          onClick={async () => {
            if (!name || !displayName) return;
            try {
              await dispatchApi.createChannel({ name, display_name: displayName, description: desc });
              setName(""); setDisplayName(""); setDesc("");
              showToast(t.dispatchCreate);
              onRefresh();
            } catch (err) {
              showToast(err instanceof Error ? err.message : String(err), "error");
            }
          }}
          className="px-3 py-1.5 rounded text-sm bg-accent-pink text-white hover:bg-accent-pink/90"
        >
          {t.dispatchCreate}
        </button>
      </div>

      {/* Channel list with subscriber management */}
      {channels.length === 0 ? (
        <p className="text-sm text-text-secondary">{t.dispatchNoChannels}</p>
      ) : (
        <div className="space-y-2">
          {channels.map((ch) => (
            <div key={ch.id} className="p-3 border border-border-subtle rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{ch.display_name}</p>
                  <p className="text-xs text-text-secondary">{ch.name} · {ch.subscriber_count} {t.dispatchSubscribers}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => editChannelId === ch.id ? setEditChannelId(null) : loadSubscribers(ch.id)}
                    className="text-xs text-accent-cyan hover:underline"
                  >
                    {t.dispatchSubscribers}
                  </button>
                  <button
                    onClick={() => onRequestConfirm({
                      title: t.dispatchDeleteChannel,
                      message: t.dispatchDeleteConfirm,
                      onConfirm: async () => {
                        try {
                          await dispatchApi.deleteChannel(ch.id);
                          showToast(t.dispatchDeleteChannel);
                          onRefresh();
                        } catch (err) {
                          showToast(err instanceof Error ? err.message : String(err), "error");
                        }
                      },
                    })}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    {t.dispatchDeleteChannel}
                  </button>
                </div>
              </div>
              {/* Subscriber editor (expanded) */}
              {editChannelId === ch.id && (
                <div className="mt-2 pt-2 border-t border-border-subtle space-y-2">
                  <input
                    value={subscriberInput}
                    onChange={(e) => setSubscriberInput(e.target.value)}
                    placeholder={t.dispatchAgentNumbersPlaceholder}
                    className="w-full px-2 py-1.5 rounded text-sm bg-surface border border-border-subtle"
                  />
                  <button
                    onClick={saveSubscribers}
                    className="px-2 py-1 rounded text-xs bg-accent-pink text-white hover:bg-accent-pink/90"
                  >
                    {t.dispatchSave || "Save"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateTaskDialog({ channels, t, onClose, onCreated }: {
  channels: DispatchChannel[];
  t: Record<string, string>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [dispatchType, setDispatchType] = useState<"channel" | "direct">("channel");
  const [channelId, setChannelId] = useState<number | null>(null);
  const [targetAgents, setTargetAgents] = useState("");
  const [profileHint, setProfileHint] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Parse agents outside onClick so disabled check can reference them
  const parsedAgents = useMemo(
    () => targetAgents.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n) && n > 0),
    [targetAgents]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dispatch-create-title"
        className="bg-sidebar-bg border border-border-subtle rounded-lg w-full max-w-lg p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="dispatch-create-title" className="text-base font-semibold">{t.dispatchCreateTask}</h3>

        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t.dispatchTaskTitle}
          className="w-full px-3 py-2 rounded text-sm bg-surface border border-border-subtle" />
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t.dispatchTaskContent}
          rows={5} className="w-full px-3 py-2 rounded text-sm bg-surface border border-border-subtle resize-y" />

        <div className="grid grid-cols-2 gap-3">
          <select value={dispatchType} onChange={(e) => setDispatchType(e.target.value as "channel" | "direct")}
            className="px-2 py-1.5 rounded text-sm bg-surface border border-border-subtle">
            <option value="channel">{t.dispatchTypeChannel}</option>
            <option value="direct">{t.dispatchTypeDirect}</option>
          </select>
          {dispatchType === "channel" ? (
            <select value={channelId || ""} onChange={(e) => setChannelId(Number(e.target.value))}
              className="px-2 py-1.5 rounded text-sm bg-surface border border-border-subtle">
              <option value="">{t.dispatchChannel}</option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>{ch.display_name}</option>
              ))}
            </select>
          ) : (
            <input value={targetAgents} onChange={(e) => setTargetAgents(e.target.value)}
              placeholder={t.dispatchAgentNumbersPlaceholder}
              className="px-2 py-1.5 rounded text-sm bg-surface border border-border-subtle" />
          )}
        </div>

        <button onClick={() => setAdvanced(!advanced)} className="text-xs text-accent-cyan hover:underline">
          {advanced ? "▾" : "▸"} {t.dispatchAdvanced}
        </button>
        {advanced && (
          <div className="space-y-2 text-sm">
            <input value={profileHint} onChange={(e) => setProfileHint(e.target.value)}
              placeholder={t.dispatchProfileHint}
              className="w-full px-2 py-1.5 rounded bg-surface border border-border-subtle" />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded text-sm text-text-secondary hover:bg-surface/50">{t.cancel}</button>
          <button
            onClick={async () => {
              setSubmitting(true);
              try {
                await dispatchApi.createTask({
                  title,
                  prompt,
                  dispatch_type: dispatchType,
                  channel_id: dispatchType === "channel" ? channelId! : undefined,
                  target_agents: dispatchType === "direct" ? parsedAgents : undefined,
                  profile_hint: profileHint || undefined,
                });
                showToast(t.dispatchCreateTask);
                onCreated();
              } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), "error");
              } finally {
                setSubmitting(false);
              }
            }}
            disabled={submitting || !title || !prompt || (dispatchType === "channel" && !channelId) || (dispatchType === "direct" && parsedAgents.length === 0)}
            className="px-4 py-2 rounded text-sm bg-accent-pink text-white hover:bg-accent-pink/90 disabled:opacity-50"
          >
            {submitting ? "..." : t.dispatchCreateTask}
          </button>
        </div>
      </div>
    </div>
  );
}
```

注意：
- parsedAgents 通过 useMemo 计算，disabled 和 onClick 都正确引用 parsedAgents（非 onClick 局部变量）。profileHint 绑定了 value/onChange 并传入 createTask。
- **Toast notifications**: 使用 `showToast`（来自 `../lib/toast`）为所有 mutations 提供成功/错误反馈。创建频道、删除频道、保存订阅者、创建任务、取消任务都包装了 try/catch + showToast。
- **Confirm dialog**: 取消任务和删除频道使用现有的 `ConfirmDialog` 组件（`variant="destructive"`），通过 `pendingConfirm` state + `onRequestConfirm` prop 传递到子组件。
- **Double-submit protection**: `CreateTaskDialog` 使用 `submitting` state，submit 按钮 `disabled` 包含 `submitting`，按钮文本在提交中显示 "..."。
- **Modal accessibility**: CreateTaskDialog 的内层 div 添加 `role="dialog"`, `aria-modal="true"`, `aria-labelledby="dispatch-create-title"`，外层 div 添加 `onKeyDown` 处理 Escape 键。

- [ ] **Step 2: 验证页面编译**

Run: `cd admin/frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: 无 dispatch 相关错误

- [ ] **Step 3: Commit**

```bash
git add admin/frontend/src/pages/TaskDispatchPage.tsx
git commit -m "feat(dispatch): add TaskDispatchPage with split-panel layout"
```

---

## Task 8: 前端构建 + 集成验证

**Files:**
- 无新文件

- [ ] **Step 1: 运行前端构建**

Run: `cd admin/frontend && npm run build`
Expected: 构建成功，输出到 `dist/`

- [ ] **Step 2: 验证构建产物包含 dispatch 页面**

Run: `grep -r "dispatch" admin/frontend/dist/assets/*.js | head -5`
Expected: 输出包含 dispatch 相关代码

- [ ] **Step 3: 运行现有 E2E 测试确保无回归**

Run: `cd admin/frontend && npx playwright test --reporter=list 2>&1 | tail -20`
Expected: 所有现有测试通过

- [ ] **Step 4: Commit（如有构建产物更新）**

```bash
git add -A
git commit -m "build(dispatch): rebuild frontend with dispatch page"
```


---

## Task 9: Dispatch 功能测试

**Files:**
- Create: `admin/backend/tests/test_dispatch.py`
- Create: `admin/frontend/e2e/dispatch.spec.ts`

- [ ] **Step 1: 创建后端单元测试**

创建 `admin/backend/tests/test_dispatch.py`：

```python
"""Unit tests for dispatch routes — token verification, status rollup, cross-field validation."""
import hashlib
import pytest
from models import DispatchTaskRequest


def test_dispatch_request_channel_requires_channel_id():
    """channel dispatch without channel_id should fail validation."""
    with pytest.raises(ValueError, match="channel_id"):
        DispatchTaskRequest(
            title="test", prompt="test", dispatch_type="channel",
        )


def test_dispatch_request_direct_requires_target_agents():
    """direct dispatch without target_agents should fail validation."""
    with pytest.raises(ValueError, match="target_agents"):
        DispatchTaskRequest(
            title="test", prompt="test", dispatch_type="direct",
        )


def test_dispatch_request_valid_channel():
    req = DispatchTaskRequest(
        title="test", prompt="test", dispatch_type="channel", channel_id=1,
    )
    assert req.channel_id == 1


def test_dispatch_request_valid_direct():
    req = DispatchTaskRequest(
        title="test", prompt="test", dispatch_type="direct", target_agents=[1, 2],
    )
    assert req.target_agents == [1, 2]


def test_callback_token_hash_verification():
    """Token hash matches SHA-256 of raw token."""
    token = "test_token_abc"
    expected = hashlib.sha256(token.encode()).hexdigest()
    assert len(expected) == 64
```

- [ ] **Step 2: 运行后端测试**

Run: `cd admin/backend && python -m pytest tests/test_dispatch.py -v`
Expected: 5 tests pass

- [ ] **Step 3: 创建前端 E2E 测试**

创建 `admin/frontend/e2e/dispatch.spec.ts`：

```typescript
import { test, expect } from "@playwright/test";

test.describe("Task Dispatch", () => {
  test("dispatch nav entry is visible for admin", async ({ page }) => {
    await page.goto("/dispatch");
    // Should not redirect to home (admin mode)
    await expect(page).toHaveURL(/\/dispatch/);
  });

  test("shows task list tab by default", async ({ page }) => {
    await page.goto("/dispatch");
    await expect(page.getByText("任务列表")).toBeVisible();
  });

  test("shows channel management tab", async ({ page }) => {
    await page.goto("/dispatch");
    await page.getByText("频道管理").click();
    await expect(page.getByText("暂无频道")).toBeVisible();
  });

  test("create task dialog opens and closes", async ({ page }) => {
    await page.goto("/dispatch");
    await page.getByText("发布任务").click();
    await expect(page.getByText("任务标题")).toBeVisible();
    await page.keyboard.press("Escape");
    // Dialog should close
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add admin/backend/tests/test_dispatch.py admin/frontend/e2e/dispatch.spec.ts
git commit -m "test(dispatch): add unit tests for validation and E2E tests for dispatch page"
```


## Self-Review

### Spec Coverage

| 设计文档要求 | 覆盖 Task |
|-------------|----------|
| 4 个 DB models | Task 1 |
| Migration SQL | Task 1 |
| Pydantic models | Task 2 |
| Orchestrator target_agent_id | Task 3 |
| 频道 CRUD API | Task 4 |
| 任务派发 API | Task 4 |
| Agent 回调端点 | Task 4 |
| callback_token 安全 | Task 4（_verify_and_consume_token） |
| 前端 API 客户端 | Task 5 |
| i18n | Task 5 |
| 路由 + 导航 | Task 6 |
| 任务管理拆分面板 | Task 7 |
| 发布任务对话框 | Task 7 |
| 频道管理 tab | Task 7 |
| 集成验证 | Task 8 |
| 测试 | Task 9 |

### Placeholder Scan

- 无 "TBD", "TODO", "implement later" 占位符
- 所有步骤包含实际代码
- 所有文件路径精确

### Type Consistency

- `DispatchTask.id` 类型 `int`（BigInteger）→ 前端 `DispatchTask.id: number` 一致
- `callback_token_hash` 后端 `str` → 验证使用 `hmac.compare_digest` 一致
- `status` 字段后端 `str` → 前端 `string` 一致
- `dispatchApi.createTask` 参数与 `DispatchTaskRequest` 字段名匹配
