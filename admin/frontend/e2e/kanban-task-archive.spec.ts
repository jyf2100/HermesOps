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

    await page.goto("/admin/agents/1?tab=kanban");
    await expect(page.getByText("Test task to archive")).toBeVisible();
    await page.getByText("Test task to archive").click();

    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    // Click archive button in drawer (exact to avoid matching "Archived" status pill)
    await drawer.getByRole("button", { name: "Archive", exact: true }).click();

    // Confirm bar appears
    await expect(drawer.getByText(/Archive task/)).toBeVisible();

    // Click confirm (last Archive button in the confirm bar)
    await drawer.getByRole("button", { name: "Archive", exact: true }).last().click();

    // Toast
    await expect(page.getByText("Task archived")).toBeVisible();
  });

  test("archive button is disabled for running tasks", async ({ page }) => {
    await setupKanbanArchivePage(page);

    await page.goto("/admin/agents/1?tab=kanban");
    await expect(page.getByText("Running task")).toBeVisible();

    await page.getByText("Running task").click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    const archiveBtn = drawer.getByRole("button", { name: "Archive", exact: true });
    await expect(archiveBtn).toBeDisabled();
  });

  test("escape cancels the confirm bar", async ({ page }) => {
    await setupKanbanArchivePage(page);

    await page.goto("/admin/agents/1?tab=kanban");
    await expect(page.getByText("Test task to archive")).toBeVisible();

    await page.getByText("Test task to archive").click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    await drawer.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(drawer.getByText(/Archive task/)).toBeVisible();

    const cancelBtn = drawer.getByRole("button", { name: "Cancel" });
    await expect(cancelBtn).toBeFocused();

    await cancelBtn.press("Escape");

    await expect(drawer.getByText(/Archive task/)).not.toBeVisible();
    await expect(drawer.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
  });
});
