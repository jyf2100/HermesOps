# Kanban 任务删除功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 允许管理员和用户从 Admin 面板彻底删除 Kanban 任务（物理删除），包括清理所有关联数据。

**Architecture:** 三层架构 — Sidecar 数据层 (`kanban_db.py`) 新增 `delete_task()` 函数处理级联删除；Sidecar API (`plugin_api.py`) 新增 DELETE 路由带 running 状态守卫；Admin 后端 (`kanban_routes.py`) 新增 DELETE 代理路由透传请求。前端在 TaskDrawer 底部栏左侧加删除按钮，inline confirm bar 确认。

**Tech Stack:** Python 3.11 / FastAPI / SQLite (WAL mode) / React 19 / Zustand / Tailwind CSS / TypeScript

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `hermes_cli/kanban_db.py` | Modify (line ~2526 后插入) | `delete_task()` 数据层函数，事务内级联删 6 张关联表 |
| `plugins/kanban/dashboard/plugin_api.py` | Modify (line ~668 后插入) | DELETE `/tasks/{task_id}` 路由，状态检查 + 调用数据层 |
| `admin/backend/kanban_routes.py` | Modify (line ~141 后插入) | DELETE 代理路由，与现有 PATCH 路由模式一致 |
| `admin/frontend/src/i18n/en.ts` | Modify | 新增 10 个英文翻译 key |
| `admin/frontend/src/i18n/zh.ts` | Modify | 新增 10 个中文翻译 key |
| `admin/frontend/src/components/kanban/TaskDrawer.tsx` | Modify | 删除按钮 + inline confirm bar + 焦点管理 |

---

### Task 1: 数据层 — `delete_task()` 函数

**Files:**
- Modify: `hermes_cli/kanban_db.py` (在 `archive_task` 函数之后，约 line 2526)

- [ ] **Step 1: 在 `archive_task()` 之后添加 `delete_task()` 函数**

在 `hermes_cli/kanban_db.py` 的 `archive_task` 函数结束（line 2525 `return True`）之后、`# Workspace resolution` 注释（line 2528）之前，插入以下代码：

```python
def delete_task(conn: sqlite3.Connection, task_id: str) -> bool:
    """Hard-delete a task and all associated rows.

    Returns False when the task is in 'running' status (must reclaim first).
    Returns True on success.  Raises on unexpected errors.
    """
    with write_txn(conn):
        row = conn.execute(
            "SELECT status, current_run_id FROM tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
        if row is None:
            return False
        if row["status"] == "running":
            return False
        if row["current_run_id"]:
            _end_run(conn, task_id, outcome="reclaimed", status="reclaimed",
                     summary="task deleted with run still recorded")
        conn.execute("DELETE FROM task_comments WHERE task_id = ?", (task_id,))
        conn.execute("DELETE FROM task_events WHERE task_id = ?", (task_id,))
        conn.execute("DELETE FROM task_runs WHERE task_id = ?", (task_id,))
        conn.execute("DELETE FROM kanban_notify_subs WHERE task_id = ?", (task_id,))
        conn.execute("DELETE FROM task_links WHERE parent_id = ? OR child_id = ?",
                     (task_id, task_id))
        cur = conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        if cur.rowcount != 1:
            return False
    return True
```

- [ ] **Step 2: 验证函数位置正确**

Run: `grep -n "def delete_task\|def archive_task\|# Workspace resolution" hermes_cli/kanban_db.py`

Expected: `archive_task` 在 `delete_task` 之前，`delete_task` 在 `# Workspace resolution` 之前。

- [ ] **Step 3: Commit**

```bash
git add hermes_cli/kanban_db.py
git commit -m "feat(kanban): add delete_task function with cascade cleanup"
```

---

### Task 2: Sidecar — DELETE `/tasks/{task_id}` 路由

**Files:**
- Modify: `plugins/kanban/dashboard/plugin_api.py` (在 `update_task` 函数之后，约 line 668)

- [ ] **Step 1: 在 `update_task` 路由之后添加 DELETE 路由**

在 `plugins/kanban/dashboard/plugin_api.py` 中 `update_task` 函数结束（约 line 668 `conn.close()`）之后、`_set_status_direct` 函数定义（约 line 670）之前，插入以下代码：

```python
@router.delete("/tasks/{task_id}")
def delete_task(task_id: str, board: Optional[str] = Query(None)):
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        task = kanban_db.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail=f"task {task_id} not found")
        ok = kanban_db.delete_task(conn, task_id)
        if not ok:
            raise HTTPException(
                status_code=409,
                detail=f"cannot delete task {task_id}: status is 'running', reclaim or wait for completion first",
            )
        return {"ok": True, "task_id": task_id}
    finally:
        conn.close()
```

- [ ] **Step 2: 验证路由注册**

Run: `grep -n "@router.delete\|def delete_task" plugins/kanban/dashboard/plugin_api.py`

Expected: 看到新增的 `@router.delete("/tasks/{task_id}")` 和对应的 `def delete_task` 函数。

- [ ] **Step 3: Commit**

```bash
git add plugins/kanban/dashboard/plugin_api.py
git commit -m "feat(kanban): add DELETE /tasks/{task_id} sidecar route"
```

---

### Task 3: Admin 后端 — DELETE 代理路由

**Files:**
- Modify: `admin/backend/kanban_routes.py` (在 PATCH 路由之后，约 line 141)

- [ ] **Step 1: 在 PATCH 路由之后添加 DELETE 代理路由**

在 `admin/backend/kanban_routes.py` 中 `kanban_update_task` 函数之后（line 141 结束），`kanban_add_comment` 函数之前（line 144），插入以下代码：

```python
@router.delete("/tasks/{task_id}", dependencies=[auth])
async def kanban_delete_task(request: Request, agent_id: int, task_id: str = Path(..., pattern=r"^[a-zA-Z0-9_-]{1,128}$")) -> StarletteResponse:
    """Proxy: DELETE task."""
    return await _proxy(request, get_effective_agent_id(request, agent_id), f"/api/plugins/kanban/tasks/{task_id}")
```

- [ ] **Step 2: 验证路由位置**

Run: `grep -n "@router\.\(get\|post\|patch\|delete\)" admin/backend/kanban_routes.py`

Expected: PATCH 路由之后紧接 DELETE 路由，然后是 POST comments 路由。

- [ ] **Step 3: Commit**

```bash
git add admin/backend/kanban_routes.py
git commit -m "feat(kanban): add DELETE proxy route in admin backend"
```

---

### Task 4: 前端 i18n — 新增翻译 key

**Files:**
- Modify: `admin/frontend/src/i18n/en.ts`
- Modify: `admin/frontend/src/i18n/zh.ts`

- [ ] **Step 1: 在 `en.ts` 的 kanban 区域添加 10 个英文 key**

找到 `en.ts` 中 kanban 相关 key 的末尾（如 `kanbanCommentSend` 或 `kanbanSaving` 附近），在其后添加：

```typescript
kanbanDelete: "Delete",
kanbanDeleting: "Deleting...",
kanbanDeleteConfirm: "Permanently delete task \"{title}\" (ID: {id})?",
kanbanDeleteConfirmBtn: "Confirm Delete",
kanbanTaskDeleted: "Task deleted",
kanbanDeleteFailed: "Failed to delete task",
kanbanDeleteNotFound: "Task not found, it may have been deleted already",
kanbanDeleteConflict: "Cannot delete a running task, please reclaim it first",
kanbanDeleteGatewayError: "Agent unreachable, please try again later",
kanbanDeleteDisabledRunning: "Cannot delete while task is running",
```

- [ ] **Step 2: 在 `zh.ts` 的 kanban 区域添加对应的 10 个中文 key**

在 `zh.ts` 中与 `en.ts` 完全相同的位置添加：

```typescript
kanbanDelete: "删除",
kanbanDeleting: "删除中...",
kanbanDeleteConfirm: "确定永久删除任务 \"{title}\" (ID: {id})？",
kanbanDeleteConfirmBtn: "确认删除",
kanbanTaskDeleted: "任务已删除",
kanbanDeleteFailed: "删除任务失败",
kanbanDeleteNotFound: "任务不存在，可能已被删除",
kanbanDeleteConflict: "无法删除正在执行的任务，请先回收(reclaim)",
kanbanDeleteGatewayError: "Agent 不可达，请稍后重试",
kanbanDeleteDisabledRunning: "任务执行中，无法删除",
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `cd admin/frontend && npx tsc --noEmit 2>&1 | head -20`

Expected: 无新增类型错误（两个文件的 key 集合必须完全一致）。

- [ ] **Step 4: Commit**

```bash
git add admin/frontend/src/i18n/en.ts admin/frontend/src/i18n/zh.ts
git commit -m "feat(kanban): add delete i18n keys for en/zh"
```

---

### Task 5: 前端 TaskDrawer — 删除按钮 + inline confirm bar

**Files:**
- Modify: `admin/frontend/src/components/kanban/TaskDrawer.tsx`

- [ ] **Step 1: 添加 state 和 ref**

在 TaskDrawer 组件中现有 state 声明区域（约 line 39-41）后添加：

```typescript
const [confirmingDelete, setConfirmingDelete] = useState(false);
const [deleting, setDeleting] = useState(false);
```

以及两个 ref（在 state 声明之后，`const assignees` 之前）：

```typescript
const deleteBtnRef = useRef<HTMLButtonElement>(null);
const cancelConfirmRef = useRef<HTMLButtonElement>(null);
```

同时在顶部 import 中确保 `useRef` 已导入（当前 import 行是 `import { useState, useEffect } from "react"`，改为）：

```typescript
import { useState, useEffect, useRef } from "react";
```

还需要导入 `AdminApiError`：

```typescript
import { adminFetch, AdminApiError } from "../../lib/admin-api";
```

- [ ] **Step 2: 添加删除处理函数**

在 `handleUnblock` 函数之后（约 line 147 后），添加以下三个函数：

```typescript
function handleDeleteClick() {
  setConfirmingDelete(true);
  requestAnimationFrame(() => cancelConfirmRef.current?.focus());
}

function handleCancelConfirm() {
  setConfirmingDelete(false);
  requestAnimationFrame(() => deleteBtnRef.current?.focus());
}

function getDeleteErrorMessage(error: unknown): string {
  if (error instanceof AdminApiError) {
    switch (error.status) {
      case 404: return t.kanbanDeleteNotFound;
      case 409: return t.kanbanDeleteConflict;
      case 502: case 504: return t.kanbanDeleteGatewayError;
      default: return error.message || t.kanbanDeleteFailed;
    }
  }
  return t.kanbanDeleteFailed;
}

async function handleConfirmDelete() {
  if (!task) return;
  setDeleting(true);
  try {
    await adminFetch<void>(
      `/agents/${agentId}/kanban/tasks/${task.id}`,
      { method: "DELETE" }
    );
    showToast(t.kanbanTaskDeleted);
    onUpdate();
    onClose();
  } catch (e: unknown) {
    showToast(getDeleteErrorMessage(e), "error");
    setConfirmingDelete(false);
  } finally {
    setDeleting(false);
  }
}
```

- [ ] **Step 3: 重写底部操作栏**

替换 TaskDrawer 底部操作栏（约 line 409-432），将原来的：

```tsx
<div className="border-t border-border px-4 py-3 flex justify-end gap-2">
```

整段替换为：

```tsx
          <div className="border-t border-border px-4 py-3">
            {confirmingDelete ? (
              <div
                role="alert"
                aria-live="assertive"
                className="bg-accent-pink/5 border border-accent-pink/20 rounded-md px-3 py-2.5 flex items-center justify-between gap-3"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    handleCancelConfirm();
                  }
                }}
              >
                <span className="text-xs text-accent-pink truncate">
                  {t.kanbanDeleteConfirm.replace("{title}", title).replace("{id}", task?.id ?? "")}
                </span>
                <div className="flex gap-2 shrink-0">
                  <button
                    ref={cancelConfirmRef}
                    onClick={handleCancelConfirm}
                    className="px-3 py-1.5 text-xs rounded-md text-text-secondary hover:text-text-primary border border-border-subtle transition-colors focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-[-2px]"
                  >
                    {t.cancel}
                  </button>
                  <button
                    onClick={handleConfirmDelete}
                    disabled={deleting}
                    className="px-3 py-1.5 text-xs rounded-md bg-accent-pink text-white hover:bg-accent-pink/90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-[-2px]"
                  >
                    {deleting ? t.kanbanDeleting : t.kanbanDeleteConfirmBtn}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex justify-between items-center">
                <div>
                  <button
                    ref={deleteBtnRef}
                    onClick={handleDeleteClick}
                    disabled={task?.status === "running" || deleting}
                    title={task?.status === "running" ? t.kanbanDeleteDisabledRunning : undefined}
                    className="px-3 py-1.5 text-xs rounded-md border border-accent-pink/40 text-accent-pink hover:bg-accent-pink/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-[-2px]"
                  >
                    {t.kanbanDelete}
                  </button>
                </div>
                <div className="flex gap-2">
                  {status === "blocked" && (
                    <button
                      onClick={handleUnblock}
                      disabled={saving}
                      className="px-4 py-2 text-sm rounded-md bg-accent-cyan text-white hover:bg-accent-cyan/90 disabled:opacity-50"
                    >
                      {saving ? t.kanbanUnblocking : t.kanbanUnblockRetry}
                    </button>
                  )}
                  <button
                    onClick={onClose}
                    className="px-4 py-2 text-sm rounded-md text-text-secondary hover:text-text-primary border border-border-subtle transition-colors"
                  >
                    {t.kanbanCancel}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-4 py-2 text-sm rounded-md bg-accent-pink text-white hover:bg-accent-pink/90 disabled:opacity-50"
                  >
                    {saving ? t.kanbanSaving : t.kanbanSave}
                  </button>
                </div>
              </div>
            )}
          </div>
```

- [ ] **Step 4: 验证 TypeScript 编译**

Run: `cd admin/frontend && npx tsc --noEmit 2>&1 | head -20`

Expected: 无类型错误。

- [ ] **Step 5: 验证前端构建**

Run: `cd admin/frontend && npm run build 2>&1 | tail -5`

Expected: 构建成功。

- [ ] **Step 6: Commit**

```bash
git add admin/frontend/src/components/kanban/TaskDrawer.tsx
git commit -m "feat(kanban): add delete button with inline confirm bar in TaskDrawer"
```

---

## Self-Review Checklist

- [x] **Spec coverage**: MVP 所有需求均有对应 Task（数据层→Sidecar 路由→Admin 代理→i18n→前端）
- [x] **Placeholder scan**: 无 TBD、TODO、"implement later"、"add appropriate" 等占位符
- [x] **Type consistency**: `delete_task(conn, task_id) -> bool` 在 Task 1 定义，Task 2 调用签名一致；前端 `AdminApiError` 在 Task 5 导入并使用
- [x] **Error codes**: 200/404/409/502/504 全部覆盖，前端 `getDeleteErrorMessage` 映射完整
- [x] **i18n sync**: Task 4 en.ts 和 zh.ts 的 10 个 key 完全对应
