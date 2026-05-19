# Kanban 任务归档功能 Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 允许管理员从 Admin 面板归档 Kanban 任务，将其从看板活跃视图中移除但保留历史数据。不修改 hermes-agent 核心代码。

**Architecture:** 利用 sidecar 已有的 `PATCH /tasks/{task_id}` + `status: "archived"` 能力实现归档。Admin 后端删除无用的 DELETE 代理路由；前端将"删除"按钮改为"归档"按钮，调用现有 PATCH API。需先回滚 3 个核心文件（kanban_db.py、plugin_api.py、test_kanban_db.py）的改动，以及删除基于 DELETE 的 E2E 测试。

**Tech Stack:** React 19 / Zustand / Tailwind CSS / TypeScript / Playwright E2E

**Constraint:** 所有改动限制在 `admin/` 目录内。hermes-agent 核心代码（`hermes_cli/`、`plugins/`、`tests/`）不得修改。

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `hermes_cli/kanban_db.py` | **Revert** | 回滚 `delete_task()` 函数 |
| `plugins/kanban/dashboard/plugin_api.py` | **Revert** | 回滚 DELETE `/tasks/{task_id}` 路由 |
| `tests/hermes_cli/test_kanban_db.py` | **Revert** | 回滚 delete_task 单元测试 |
| `admin/backend/kanban_routes.py` | **Modify** | 删除 DELETE 代理路由 |
| `admin/frontend/src/i18n/en.ts` | **Modify** | 删除 delete keys，添加 archive keys |
| `admin/frontend/src/i18n/zh.ts` | **Modify** | 删除 delete keys，添加 archive keys |
| `admin/frontend/src/components/kanban/TaskDrawer.tsx` | **Modify** | 删除逻辑改为归档逻辑（PATCH status: "archived"） |
| `admin/frontend/e2e/kanban-task-delete.spec.ts` | **Rename + Rewrite** | 改为 kanban-task-archive.spec.ts，测试归档流程 |

---

### Task 1: 回滚核心代码改动

**Files:**
- Revert: `hermes_cli/kanban_db.py`
- Revert: `plugins/kanban/dashboard/plugin_api.py`
- Revert: `tests/hermes_cli/test_kanban_db.py`

- [ ] **Step 1: 回滚 kanban_db.py 的 delete_task 函数**

删除 `hermes_cli/kanban_db.py` 中 `archive_task` 函数后新增的 `delete_task()` 函数（约 line 2528-2564）。

```bash
git show HEAD~8:hermes_cli/kanban_db.py > /tmp/kanban_db_orig.py
cp /tmp/kanban_db_orig.py hermes_cli/kanban_db.py
```

- [ ] **Step 2: 回滚 plugin_api.py 的 DELETE 路由**

删除 `plugins/kanban/dashboard/plugin_api.py` 中 `update_task` 函数后新增的 `@router.delete("/tasks/{task_id}")` 路由（约 line 670-686）。

```bash
git show HEAD~8:plugins/kanban/dashboard/plugin_api.py > /tmp/plugin_api_orig.py
cp /tmp/plugin_api_orig.py plugins/kanban/dashboard/plugin_api.py
```

- [ ] **Step 3: 回滚 test_kanban_db.py 的 delete 测试**

删除 `tests/hermes_cli/test_kanban_db.py` 中新增的 8 个 delete_task 单元测试。

```bash
git show HEAD~8:tests/hermes_cli/test_kanban_db.py > /tmp/test_kanban_db_orig.py
cp /tmp/test_kanban_db_orig.py tests/hermes_cli/test_kanban_db.py
```

- [ ] **Step 4: 验证回滚**

```bash
git diff HEAD~8 -- hermes_cli/kanban_db.py plugins/kanban/dashboard/plugin_api.py tests/hermes_cli/test_kanban_db.py
```

Expected: 无差异（完全恢复到 HEAD~8 状态）。

- [ ] **Step 5: Commit**

```bash
git add hermes_cli/kanban_db.py plugins/kanban/dashboard/plugin_api.py tests/hermes_cli/test_kanban_db.py
git commit -m "revert(kanban): remove delete_task from core — use archive instead"
```

---

### Task 2: Admin 后端 — 删除 DELETE 代理路由

**Files:**
- Modify: `admin/backend/kanban_routes.py`

- [ ] **Step 1: 删除 DELETE 代理路由**

在 `admin/backend/kanban_routes.py` 中删除 `kanban_delete_task` 函数（约 line 144-147），即：

```python
@router.delete("/tasks/{task_id}", dependencies=[auth])
async def kanban_delete_task(request: Request, agent_id: int, task_id: str = Path(..., pattern=r"^[a-zA-Z0-9_-]{1,128}$")) -> StarletteResponse:
    """Proxy: DELETE task."""
    return await _proxy(request, get_effective_agent_id(request, agent_id), f"/api/plugins/kanban/tasks/{task_id}")
```

删除后，PATCH 路由（line 138-141）后面紧跟 POST comments 路由（line 150）。

- [ ] **Step 2: 验证无 DELETE 路由**

```bash
grep -n "delete" admin/backend/kanban_routes.py
```

Expected: 无匹配结果。

- [ ] **Step 3: Commit**

```bash
git add admin/backend/kanban_routes.py
git commit -m "refactor(kanban): remove DELETE proxy route — archive via PATCH instead"
```

---

### Task 3: 前端 i18n — 替换 delete keys 为 archive keys

**Files:**
- Modify: `admin/frontend/src/i18n/en.ts`
- Modify: `admin/frontend/src/i18n/zh.ts`

- [ ] **Step 1: 在 en.ts 中替换 delete keys 为 archive keys**

删除以下 10 个 key（约 line 666-675）：

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

替换为 5 个 archive key（放在 kanbanArchived 附近）：

```typescript
kanbanArchive: "Archive",
kanbanArchiving: "Archiving...",
kanbanArchiveConfirm: "Archive task \"{title}\"? It will be hidden from the board but preserved in history.",
kanbanTaskArchived: "Task archived",
kanbanArchiveFailed: "Failed to archive task",
```

- [ ] **Step 2: 在 zh.ts 中替换 delete keys 为 archive keys**

删除以下 10 个 key（约 line 1515-1524）：

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

替换为 5 个 archive key：

```typescript
kanbanArchive: "归档",
kanbanArchiving: "归档中...",
kanbanArchiveConfirm: "确定归档任务 \"{title}\"？归档后将从看板隐藏，但历史记录保留。",
kanbanTaskArchived: "任务已归档",
kanbanArchiveFailed: "归档任务失败",
```

- [ ] **Step 3: 验证 TypeScript 编译**

```bash
cd admin/frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: 无类型错误（两个文件的 key 集合完全一致）。

- [ ] **Step 4: Commit**

```bash
git add admin/frontend/src/i18n/en.ts admin/frontend/src/i18n/zh.ts
git commit -m "refactor(kanban): replace delete i18n keys with archive keys"
```

---

### Task 4: 前端 TaskDrawer — 归档按钮替换删除按钮

**Files:**
- Modify: `admin/frontend/src/components/kanban/TaskDrawer.tsx`

- [ ] **Step 1: 更新 imports**

删除 `AdminApiError` 的导入（不再需要，归档使用通用错误处理）：

```typescript
// 之前
import { adminFetch, AdminApiError } from "../../lib/admin-api";
// 改为
import { adminFetch } from "../../lib/admin-api";
```

- [ ] **Step 2: 替换 state 变量名**

将 `confirmingDelete` 改为 `confirmingArchive`，`deleting` 改为 `archiving`：

```typescript
// 之前
const [confirmingDelete, setConfirmingDelete] = useState(false);
const [deleting, setDeleting] = useState(false);
// 改为
const [confirmingArchive, setConfirmingArchive] = useState(false);
const [archiving, setArchiving] = useState(false);
```

将 refs 改名：

```typescript
// 之前
const deleteBtnRef = useRef<HTMLButtonElement>(null);
// 改为
const archiveBtnRef = useRef<HTMLButtonElement>(null);
```

（`cancelConfirmRef` 保留不变）

- [ ] **Step 3: 替换处理函数**

删除以下 4 个函数：
- `handleDeleteClick`
- `handleCancelConfirm`
- `getDeleteErrorMessage`
- `handleConfirmDelete`

替换为 3 个新函数：

```typescript
function handleArchiveClick() {
  setConfirmingArchive(true);
  requestAnimationFrame(() => cancelConfirmRef.current?.focus());
}

function handleCancelArchive() {
  setConfirmingArchive(false);
  requestAnimationFrame(() => archiveBtnRef.current?.focus());
}

async function handleConfirmArchive() {
  if (!task) return;
  setArchiving(true);
  try {
    await adminFetch<KanbanTask>(
      `/agents/${agentId}/kanban/tasks/${task.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "archived" }),
      }
    );
    showToast(t.kanbanTaskArchived);
    onUpdate();
    onClose();
  } catch (e: unknown) {
    showToast(
      e instanceof Error ? e.message : t.kanbanArchiveFailed,
      "error"
    );
    setConfirmingArchive(false);
  } finally {
    setArchiving(false);
  }
}
```

- [ ] **Step 4: 替换底部操作栏 JSX**

将底部栏中的 `confirmingDelete` 条件改为 `confirmingArchive`，删除确认栏改为归档确认栏：

```tsx
          <div className="border-t border-border px-4 py-3">
            {confirmingArchive ? (
              <div
                role="alert"
                aria-live="assertive"
                className="bg-accent-cyan/5 border border-accent-cyan/20 rounded-md px-3 py-2.5 flex items-center justify-between gap-3"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    handleCancelArchive();
                  }
                }}
              >
                <span className="text-xs text-accent-cyan truncate">
                  {t.kanbanArchiveConfirm.replace("{title}", title)}
                </span>
                <div className="flex gap-2 shrink-0">
                  <button
                    ref={cancelConfirmRef}
                    onClick={handleCancelArchive}
                    className="px-3 py-1.5 text-xs rounded-md text-text-secondary hover:text-text-primary border border-border-subtle transition-colors focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-[-2px]"
                  >
                    {t.cancel}
                  </button>
                  <button
                    onClick={handleConfirmArchive}
                    disabled={archiving}
                    className="px-3 py-1.5 text-xs rounded-md bg-accent-cyan text-white hover:bg-accent-cyan/90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-[-2px]"
                  >
                    {archiving ? t.kanbanArchiving : t.kanbanArchive}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex justify-between items-center">
                <div>
                  <button
                    ref={archiveBtnRef}
                    onClick={handleArchiveClick}
                    disabled={task?.status === "running" || task?.status === "archived" || archiving}
                    title={task?.status === "running" ? t.kanbanArchived : undefined}
                    className="px-3 py-1.5 text-xs rounded-md border border-accent-cyan/40 text-accent-cyan hover:bg-accent-cyan/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-[-2px]"
                  >
                    {t.kanbanArchive}
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

关键变更：
- 颜色从 pink（危险删除）改为 cyan（归档操作）
- 归档按钮 disabled 条件：`running` 或 `archived` 状态
- 确认文字使用 `kanbanArchiveConfirm`（无永久删除措辞）
- 确认按钮文案就是"归档"而非"确认删除"

- [ ] **Step 5: 验证 TypeScript 编译**

```bash
cd admin/frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: 无类型错误。

- [ ] **Step 6: 验证前端构建**

```bash
cd admin/frontend && npm run build 2>&1 | tail -5
```

Expected: 构建成功。

- [ ] **Step 7: Commit**

```bash
git add admin/frontend/src/components/kanban/TaskDrawer.tsx
git commit -m "feat(kanban): replace delete button with archive button in TaskDrawer"
```

---

### Task 5: E2E 测试 — 重写归档测试

**Files:**
- Rename: `admin/frontend/e2e/kanban-task-delete.spec.ts` → `admin/frontend/e2e/kanban-task-archive.spec.ts`

- [ ] **Step 1: 删除旧测试文件**

```bash
git rm admin/frontend/e2e/kanban-task-delete.spec.ts
```

- [ ] **Step 2: 创建新的归档测试文件**

创建 `admin/frontend/e2e/kanban-task-archive.spec.ts`：

```typescript
import { test, expect } from "@playwright/test";
import { loginAsAdminEn, mockApi } from "./helpers";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockBoard = {
  columns: [
    {
      name: "triage",
      tasks: [
        {
          id: "task1",
          title: "Test task to archive",
          status: "triage",
          priority: 2,
          body: "archive me",
          assignee: null,
          created_at: 1700000000,
          parents: [],
          children: [],
          skills: [],
        },
      ],
    },
    { name: "todo", tasks: [] },
    { name: "ready", tasks: [] },
    {
      name: "running",
      tasks: [
        {
          id: "task2",
          title: "Running task",
          status: "running",
          priority: 2,
          body: "can't archive",
          assignee: null,
          created_at: 1700000000,
          parents: [],
          children: [],
          skills: [],
        },
      ],
    },
    { name: "done", tasks: [] },
    { name: "blocked", tasks: [] },
    { name: "archived", tasks: [] },
  ],
};

const mockTaskDetail = {
  task: {
    id: "task1",
    title: "Test task to archive",
    status: "triage",
    priority: 2,
    body: "archive me",
    assignee: null,
    created_at: 1700000000,
    completed_at: null,
    block_reason: null,
    parents: [],
    children: [],
    skills: [],
    comments: [],
    latest_summary: null,
    result: null,
    last_failure_error: null,
  },
};

const mockAgentDetail = {
  id: 1,
  name: "hermes-gateway-1",
  status: "running",
  url_path: "/agent1",
  namespace: "hermes-agent",
  labels: {},
  created_at: "2026-04-15T10:00:00Z",
  pods: [],
  resources: {
    cpu_cores: 0.1,
    cpu_request_millicores: 250,
    cpu_limit_millicores: 1000,
    memory_bytes: 268435456,
    memory_request_bytes: 268435456,
    memory_limit_bytes: 536870912,
  },
  health_ok: true,
  restart_count: 0,
  age_human: "1d",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupKanbanArchivePage(
  page: import("@playwright/test").Page,
  overrides?: {
    taskDetail?: unknown;
    archiveResponse?: unknown;
  }
) {
  const archiveResponse = overrides?.archiveResponse ?? {
    id: "task1",
    title: "Test task to archive",
    status: "archived",
    priority: 2,
  };

  await loginAsAdminEn(page);
  await mockApi(page, {
    "GET:/admin/api/agents/1/kanban/tasks": mockBoard,
    "GET:/admin/api/agents/1/kanban/tasks/task1":
      overrides?.taskDetail ?? mockTaskDetail,
    "GET:/admin/api/agents/1/kanban/tasks/task2": {
      task: {
        ...mockTaskDetail.task,
        id: "task2",
        title: "Running task",
        status: "running",
      },
    },
    "PATCH:/admin/api/agents/1/kanban/tasks/task1": archiveResponse,
    "GET:/admin/api/agents/1/kanban/assignees": { assignees: [] },
    "GET:/admin/api/agents/1": mockAgentDetail,
    "GET:/admin/api/cluster": {
      nodes: [],
      namespace: "hermes-agent",
      total_agents: 1,
      running_agents: 1,
    },
    "GET:/admin/api/agents": {
      agents: [
        {
          id: 1,
          name: "hermes-gateway-1",
          status: "running",
          url_path: "/agent1",
          resources: {
            cpu_cores: 0.1,
            cpu_request_millicores: 250,
            cpu_limit_millicores: 1000,
            memory_bytes: 268435456,
            memory_request_bytes: 268435456,
            memory_limit_bytes: 536870912,
          },
          age: "1d",
          restart_count: 0,
          labels: {},
          display_name: "Test Agent",
        },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Kanban Task Archive", () => {
  test("archive button shows inline confirm bar and archives task", async ({
    page,
  }) => {
    await setupKanbanArchivePage(page);

    // Navigate to agent detail kanban tab
    await page.goto("/admin/agents/1?tab=kanban");

    // Wait for board to load
    await expect(page.getByText("Test task to archive")).toBeVisible();

    // Click the task to open drawer
    await page.getByText("Test task to archive").click();

    // Wait for drawer
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    // Click archive button (scoped to drawer)
    await drawer.getByRole("button", { name: "Archive" }).click();

    // Confirm bar should appear
    await expect(
      drawer.getByText(/Archive task/)
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Archive" }).last()
    ).toBeVisible();

    // Click confirm
    await drawer.getByRole("button", { name: "Archive" }).last().click();

    // Toast should appear
    await expect(page.getByText("Task archived")).toBeVisible();
  });

  test("archive button is disabled for running tasks", async ({ page }) => {
    await setupKanbanArchivePage(page);

    await page.goto("/admin/agents/1?tab=kanban");
    await expect(page.getByText("Running task")).toBeVisible();

    // Click the running task to open drawer
    await page.getByText("Running task").click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    // Archive button should be disabled (scoped to drawer)
    const archiveBtn = drawer.getByRole("button", { name: "Archive" });
    await expect(archiveBtn).toBeDisabled();
  });

  test("escape cancels the confirm bar", async ({ page }) => {
    await setupKanbanArchivePage(page);

    await page.goto("/admin/agents/1?tab=kanban");
    await expect(page.getByText("Test task to archive")).toBeVisible();

    await page.getByText("Test task to archive").click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    // Click archive (scoped to drawer)
    await drawer.getByRole("button", { name: "Archive" }).click();
    await expect(
      drawer.getByText(/Archive task/)
    ).toBeVisible();

    // Wait for focus to land on the cancel button after requestAnimationFrame
    const cancelBtn = drawer.getByRole("button", { name: "Cancel" });
    await expect(cancelBtn).toBeFocused();

    // Press Escape from the cancel button
    await cancelBtn.press("Escape");

    // Confirm bar should disappear, archive button should be back
    await expect(
      drawer.getByText(/Archive task/)
    ).not.toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Archive" })
    ).toBeVisible();
  });
});
```

- [ ] **Step 3: 运行 E2E 测试**

```bash
cd admin/frontend && npx playwright test kanban-task-archive --reporter=line 2>&1 | tail -20
```

Expected: 3 tests passed。

- [ ] **Step 4: Commit**

```bash
git add admin/frontend/e2e/kanban-task-delete.spec.ts admin/frontend/e2e/kanban-task-archive.spec.ts
git commit -m "test(kanban): replace delete E2E tests with archive E2E tests"
```

---

## Self-Review Checklist

- [x] **Spec coverage**: 回滚核心代码 + admin 内归档功能覆盖完整（后端→i18n→前端→E2E）
- [x] **Placeholder scan**: 无 TBD、TODO、"implement later" 等占位符
- [x] **Type consistency**: `KanbanStatus` 类型中已包含 `"archived"`，PATCH body `{ status: "archived" }` 类型安全
- [x] **i18n sync**: Task 3 en.ts 和 zh.ts 的 5 个 archive key 完全对应
- [x] **Constraint check**: 所有改动在 admin/ 内，核心代码通过回滚恢复原状
- [x] **API match**: 前端使用现有 `PATCH /tasks/{task_id}` + `status: "archived"`，sidecar 已支持
