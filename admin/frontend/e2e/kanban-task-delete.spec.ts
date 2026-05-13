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
          title: "Test task to delete",
          status: "triage",
          priority: 2,
          body: "delete me",
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
          body: "can't delete",
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
    title: "Test task to delete",
    status: "triage",
    priority: 2,
    body: "delete me",
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

async function setupKanbanDeletePage(
  page: import("@playwright/test").Page,
  overrides?: {
    taskDetail?: unknown;
    deleteResponse?: unknown;
  }
) {
  const deleteResponse = overrides?.deleteResponse ?? { ok: true, task_id: "task1" };

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
    "DELETE:/admin/api/agents/1/kanban/tasks/task1": deleteResponse,
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

test.describe("Kanban Task Deletion", () => {
  test("delete button shows inline confirm bar and deletes task", async ({
    page,
  }) => {
    await setupKanbanDeletePage(page);

    // Navigate to agent detail kanban tab
    await page.goto("/admin/agents/1?tab=kanban");

    // Wait for board to load
    await expect(page.getByText("Test task to delete")).toBeVisible();

    // Click the task to open drawer
    await page.getByText("Test task to delete").click();

    // Wait for drawer
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    // Click delete button (scoped to drawer to avoid matching page-level Delete button)
    await drawer.getByRole("button", { name: "Delete" }).click();

    // Confirm bar should appear
    await expect(
      drawer.getByText(/Permanently delete task/)
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Confirm Delete" })
    ).toBeVisible();

    // Click confirm
    await drawer.getByRole("button", { name: "Confirm Delete" }).click();

    // Toast should appear
    await expect(page.getByText("Task deleted")).toBeVisible();
  });

  test("delete button is disabled for running tasks", async ({ page }) => {
    await setupKanbanDeletePage(page);

    await page.goto("/admin/agents/1?tab=kanban");
    await expect(page.getByText("Running task")).toBeVisible();

    // Click the running task to open drawer
    await page.getByText("Running task").click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    // Delete button should be disabled (scoped to drawer)
    const deleteBtn = drawer.getByRole("button", { name: "Delete" });
    await expect(deleteBtn).toBeDisabled();
  });

  test("escape cancels the confirm bar", async ({ page }) => {
    await setupKanbanDeletePage(page);

    await page.goto("/admin/agents/1?tab=kanban");
    await expect(page.getByText("Test task to delete")).toBeVisible();

    await page.getByText("Test task to delete").click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    // Click delete (scoped to drawer)
    await drawer.getByRole("button", { name: "Delete" }).click();
    await expect(
      drawer.getByText(/Permanently delete task/)
    ).toBeVisible();

    // Wait for focus to land on the cancel button after requestAnimationFrame
    const cancelBtn = drawer.getByRole("button", { name: "Cancel" });
    await expect(cancelBtn).toBeFocused();

    // Press Escape from the cancel button (which bubbles to the confirm bar onKeyDown)
    await cancelBtn.press("Escape");

    // Confirm bar should disappear, delete button should be back
    await expect(
      drawer.getByText(/Permanently delete task/)
    ).not.toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Delete" })
    ).toBeVisible();
  });
});
