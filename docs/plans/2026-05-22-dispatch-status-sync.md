# Dispatch Assignment 状态同步修复方案 v2

> 基于专家团队审核意见修订。第一轮审核发现 2 个 CRITICAL + 3 个 HIGH 问题。

## 问题描述

用户在"我的任务"页面确认分派任务后，kanban 任务会被创建并执行，但 admin DB 中的 assignment 状态永远停在 `confirmed`，不会推进到 `executing` → `completed`。导致：

1. **我的任务页面**：确认后永远显示"已确认"
2. **任务调度页面**：assignment pills 只显示颜色不显示状态文字，无法辨别实际状态

根因：`my_task_confirm` 确认后调用 `_kanban_create_and_dispatch` 创建 kanban 任务，但 kanban 执行完成后没有反馈机制把结果同步回 admin DB。

## 涉及文件

| # | 文件 | 改动 |
|---|------|------|
| 1 | `admin/backend/db_models.py` | DispatchAssignment 加 `kanban_task_id` 列 |
| 2 | `admin/backend/database.py` | 加 migration SQL |
| 3 | `admin/backend/dispatch_routes.py` | 重构 kanban 函数 + 轮询 + 启动恢复 |
| 4 | `admin/frontend/src/components/StatusBadge.tsx` | **新建**：共享状态标签组件 |
| 5 | `admin/frontend/src/pages/TaskDispatchPage.tsx` | assignment pills 用共享 StatusBadge |
| 6 | `admin/frontend/src/pages/MyTasksPage.tsx` | 替换硬编码 STATUS_LABELS 为共享 StatusBadge |

## 改动详情

### 改动 1: DB — 新增 `kanban_task_id` 列

**审核问题**: CRITICAL — asyncio.create_task 在服务器重启后丢失，assignment 永远卡在 "confirmed"。
**解决**: 持久化 kanban_task_id 到 DB，启动时恢复轮询。

**db_models.py** — DispatchAssignment 加列:
```python
kanban_task_id = Column(String(128), nullable=True)
```

**database.py** — migration SQL:
```sql
ALTER TABLE dispatch_assignments
  ADD COLUMN IF NOT EXISTS kanban_task_id VARCHAR(128);
```

### 改动 2: Backend — 重构 kanban 函数 + 轮询 + 启动恢复

**文件**: `admin/backend/dispatch_routes.py`

#### 2a. 认证缓存 `_get_kanban_auth`

**审核问题**: MEDIUM — 每 10s 读一次 K8s secret 无缓存。
**解决**: 简单 TTL 内存缓存（5 分钟）。

```python
_kanban_auth_cache: dict[int, tuple[float, tuple[str, str]]] = {}
_AUTH_CACHE_TTL = 300  # 5 minutes

async def _get_kanban_auth(agent_number: int) -> tuple[str, str] | None:
    import time
    now = time.monotonic()
    cached = _kanban_auth_cache.get(agent_number)
    if cached and now - cached[0] < _AUTH_CACHE_TTL:
        return cached[1]
    # ... read from K8s secret ...
    if result:
        _kanban_auth_cache[agent_number] = (now, result)
    return result
```

#### 2b. `_kanban_create_and_dispatch` 返回 kanban_task_id + 存 DB

```python
async def _kanban_create_and_dispatch(agent_number: int, title: str, body: str) -> str | None:
    # ... create + dispatch ...
    kanban_task_id = create_resp.json().get("task", {}).get("id")
    return kanban_task_id
```

#### 2c. `_poll_kanban_status` 后台轮询

**审核问题修复**:
- HIGH — 复用 httpx.AsyncClient（移到循环外）
- HIGH — 加连续错误计数，区分永久/瞬态错误（404 立即终止）
- HIGH — 活动轮询器注册表（app state set），防止无限并发

```python
_active_pollers: set[int] = set()  # assignment IDs with active pollers

async def _poll_kanban_status(agent_number: int, kanban_task_id: str, assignment_id: int):
    _active_pollers.add(assignment_id)
    try:
        auth = await _get_kanban_auth(agent_number)
        if not auth:
            return
        webui_url, api_key = auth
        headers = {"Authorization": f"Bearer {api_key}"}
        max_polls = 120  # ~20 min
        consecutive_errors = 0

        async with httpx.AsyncClient(timeout=15.0) as client:  # 复用 client
            for _ in range(max_polls):
                await asyncio.sleep(10)
                try:
                    resp = await client.get(
                        f"{webui_url}/api/hermes/kanban/{kanban_task_id}",
                        headers=headers,
                    )
                    consecutive_errors = 0  # 成功重置

                    if resp.status_code == 404:
                        # kanban 任务被删除，永久失败
                        await _mark_assignment_failed(assignment_id, "Kanban task deleted")
                        return
                    if resp.status_code != 200:
                        continue

                    data = resp.json()
                    task = data.get("task", data)
                    kb_status = task.get("status", "")
                    result = task.get("result")

                    # 检查是否已被其他路径（orchestrator callback）终结
                    async with AsyncSessionLocal() as session:
                        assignment = await session.get(DispatchAssignment, assignment_id)
                        if not assignment or assignment.status in ("completed", "failed", "cancelled"):
                            return  # 已被终结，退出轮询

                        if kb_status == "running" and assignment.status != "executing":
                            assignment.status = "executing"
                            assignment.started_at = datetime.now(timezone.utc)
                            await session.commit()
                        elif kb_status in ("done", "archived"):
                            assignment.status = "completed"
                            assignment.completed_at = datetime.now(timezone.utc)
                            if result:
                                assignment.result_summary = str(result)[:5000]
                            await session.commit()
                            await _update_dispatch_task_status(session, assignment.task_id)
                            await session.commit()
                            return
                except Exception as exc:
                    consecutive_errors += 1
                    logger.warning("Poll kanban %s error (%d): %s", kanban_task_id, consecutive_errors, exc)
                    if consecutive_errors >= 10:
                        await _mark_assignment_failed(assignment_id, f"Polling failed: {exc}")
                        return

        # 超时
        await _mark_assignment_failed(assignment_id, "Kanban task polling timed out")
    finally:
        _active_pollers.discard(assignment_id)
```

#### 2d. `my_task_confirm` 启动后台轮询 + 存 kanban_task_id

```python
@router.post("/my-tasks/{assignment_id}/confirm")
async def my_task_confirm(assignment_id: int, request: Request):
    # ... 现有确认逻辑 ...
    assignment.status = "confirmed"
    # ...

    if task:
        kanban_task_id = await _kanban_create_and_dispatch(agent_number, task.title, body_text)
        if kanban_task_id:
            # 持久化 kanban_task_id
            async with AsyncSessionLocal() as session:
                a = await session.get(DispatchAssignment, assignment_id)
                if a:
                    a.kanban_task_id = kanban_task_id
                    await session.commit()
            # 启动后台轮询
            import asyncio
            asyncio.create_task(_poll_kanban_status(agent_number, kanban_task_id, assignment_id))

    return {"status": "confirmed"}
```

#### 2e. 启动时恢复卡住的 assignments

**审核问题**: CRITICAL — 服务器重启后丢失轮询。
**解决**: 在 app startup 事件中扫描 status=confirmed/executing 且有 kanban_task_id 的 assignments，重启轮询。

```python
async def recover_kanban_pollers():
    """App startup: resume polling for assignments that were interrupted by restart."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(DispatchAssignment)
            .where(
                DispatchAssignment.status.in_(["confirmed", "executing"]),
                DispatchAssignment.kanban_task_id.isnot(None),
            )
        )
        for a in result.scalars().all():
            if a.id not in _active_pollers:
                import asyncio
                asyncio.create_task(_poll_kanban_status(a.agent_number, a.kanban_task_id, a.id))
                logger.info("Recovered kanban poller for assignment %d (task %s)", a.id, a.kanban_task_id)
```

在 `main.py` 的 startup 事件中调用 `recover_kanban_pollers()`。

### 改动 3: Frontend — 共享 StatusBadge 组件

**审核问题**: TaskDispatchPage 和 MyTasksPage 各自定义状态标签，MyTasksPage 硬编码中文违反 i18n。
**解决**: 提取共享 StatusBadge 组件，统一使用 i18n key。

#### 3a. 新建 `components/StatusBadge.tsx`

```tsx
import { useI18n } from "../hooks/useI18n";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400",
  notified: "bg-blue-500/20 text-blue-400",
  confirmed: "bg-green-500/20 text-green-400",
  executing: "bg-cyan-500/20 text-cyan-400",
  completed: "bg-emerald-500/20 text-emerald-400",
  failed: "bg-red-500/20 text-red-400",
  rejected: "bg-pink-500/20 text-pink-400",
  expired: "bg-amber-500/20 text-amber-400",
  cancelled: "bg-zinc-500/20 text-zinc-400",
  // dispatch task 级别状态
  dispatching: "bg-yellow-500/20 text-yellow-400",
  dispatched: "bg-blue-500/20 text-blue-400",
  partial: "bg-orange-500/20 text-orange-400",
};

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const key = `dispatchStatus${status.charAt(0).toUpperCase() + status.slice(1)}` as keyof typeof t;
  const label = (t[key] as string) || status;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status] || "bg-gray-500/20 text-gray-400"}`}>
      {label}
    </span>
  );
}
```

#### 3b. TaskDispatchPage — assignment pills 显示状态

```tsx
// 改前: 只显示 agent number + 颜色
// 改后: agent number + StatusBadge 组件

{task.assignments.map((a) => (
  <span
    key={a.id}
    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-surface/50 border border-border-subtle"
  >
    <span className="text-text-primary font-medium">
      {t.dispatchAgent.replace("{number}", String(a.agent_number))}
    </span>
    <StatusBadge status={a.status} />
  </span>
))}
```

同时移除 TaskDispatchPage 中已有的本地 `StatusBadge` 组件，改用共享版。

#### 3c. MyTasksPage — 替换硬编码 STATUS_LABELS

移除本地 `STATUS_LABELS` 和 `StatusBadge`，改用共享组件。

## 竞态问题说明

**审核问题**: CRITICAL — orchestrator callback 和 kanban polling 同时更新同一个 assignment。

**分析**: 两条路径可以安全共存：
1. `_poll_kanban_status` 每次更新前检查 `assignment.status in ("completed", "failed", "cancelled")` 就退出
2. `callback_orchestrator` 也有相同的终态检查
3. 两条路径都写入相同的终态（"completed"），只是 result 来源不同
4. 先到达的路径设置终态，后到达的路径看到终态就退出

不需要加锁或 SELECT FOR UPDATE，因为两个写入者写的是相同的终态值，顺序无关。

## 状态流转

```
用户确认 → confirmed (存 kanban_task_id)
  ↓ 后台轮询启动
  kanban "running" → executing
  kanban "done" → completed + result_summary
                   ↓ _update_dispatch_task_status
                   DispatchTask.status → "completed"

异常路径:
  kanban 404 → failed "Kanban task deleted"
  连续 10 次错误 → failed "Polling failed: ..."
  20 分钟超时 → failed "Polling timed out"
  服务器重启 → recover_kanban_pollers() 恢复轮询
```

## 不影响现有功能

- `kanban_task_id` 列默认 NULL，现有 assignments 不受影响
- `_poll_kanban_status` 是纯新增函数
- `my_task_confirm` 的确认逻辑不变，只增加了 kanban_task_id 存储和轮询启动
- 前端 StatusBadge 纯 UI 变更
- `create_dispatch_task`（管理员创建任务）路径完全不受影响

## 执行顺序

1. DB 改动（db_models.py + database.py migration）
2. Backend 改动（dispatch_routes.py + main.py startup）
3. Frontend 改动（StatusBadge.tsx + TaskDispatchPage.tsx + MyTasksPage.tsx）
4. E2E 测试更新
5. 部署验证
