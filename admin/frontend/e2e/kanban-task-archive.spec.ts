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

const mockBoardWithArchived = {
  columns: [
    { name: "triage", tasks: [] },
    { name: "todo", tasks: [] },
    { name: "ready", tasks: [] },
    { name: "running", tasks: [] },
    { name: "done", tasks: [] },
    { name: "blocked", tasks: [] },
    {
      name: "archived",
      tasks: [
        {
          id: "archived1",
          title: "Old research task",
          status: "archived",
          priority: 3,
          body: "Finished research",
          assignee: null,
          created_at: 1700000000,
          parents: [],
          children: [],
          skills: [],
        },
        {
          id: "archived2",
          title: "Legacy cleanup",
          status: "archived",
          priority: 1,
          body: "Cleanup done",
          assignee: "agent-a",
          created_at: 1700001000,
          parents: [],
          children: [],
          skills: [],
        },
      ],
    },
  ],
};

const mockBoardWithSingleArchived = {
  columns: [
    { name: "triage", tasks: [] },
    { name: "todo", tasks: [] },
    { name: "ready", tasks: [] },
    { name: "running", tasks: [] },
    { name: "done", tasks: [] },
    { name: "blocked", tasks: [] },
    {
      name: "archived",
      tasks: [
        {
          id: "archived1",
          title: "Old research task",
          status: "archived",
          priority: 3,
          body: "Finished research",
          assignee: null,
          created_at: 1700000000,
          parents: [],
          children: [],
          skills: [],
        },
      ],
    },
  ],
};

const mockBoardEmpty = {
  columns: [
    { name: "triage", tasks: [] },
    { name: "todo", tasks: [] },
    { name: "ready", tasks: [] },
    { name: "running", tasks: [] },
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

const mockArchivedTaskDetail = {
  task: {
    id: "archived1",
    title: "Old research task",
    status: "archived",
    priority: 3,
    body: "Finished research",
    assignee: null,
    created_at: 1700000000,
    completed_at: 1700050000,
    block_reason: null,
    parents: [],
    children: [],
    skills: [],
    comments: [],
    latest_summary: "Research completed successfully",
    result: "Final report delivered",
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

// Shared agent list mock used across all tests
const mockAgentsList = {
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
};

const mockClusterInfo = {
  nodes: [],
  namespace: "hermes-agent",
  total_agents: 1,
  running_agents: 1,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build common API mocks shared across all kanban tests. */
function baseRoutes() {
  return {
    "GET:/admin/api/agents/1/kanban/assignees": { assignees: [] },
    "GET:/admin/api/agents/1": mockAgentDetail,
    "GET:/admin/api/cluster": mockClusterInfo,
    "GET:/admin/api/agents": mockAgentsList,
  };
}

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
    ...baseRoutes(),
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
  });
}

/**
 * Setup helper for archived-section tests.
 * Allows callers to pick which board fixture to use and optionally add
 * extra route overrides.
 */
async function setupArchivedSectionPage(
  page: import("@playwright/test").Page,
  board: typeof mockBoardWithArchived,
  extraRoutes?: Record<string, unknown>
) {
  await loginAsAdminEn(page);
  await mockApi(page, {
    ...baseRoutes(),
    "GET:/admin/api/agents/1/kanban/tasks": board,
    ...extraRoutes,
  });
}

// ---------------------------------------------------------------------------
// Tests — TaskDrawer archive flow
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

// ---------------------------------------------------------------------------
// Tests — Archived tasks collapsible section
// ---------------------------------------------------------------------------

test.describe("Kanban Archived Tasks Section", () => {
  test("archived section appears when there are archived tasks", async ({
    page,
  }) => {
    await setupArchivedSectionPage(page, mockBoardWithArchived);

    await page.goto("/admin/agents/1?tab=kanban");

    // The "Archived" collapsible header should be visible
    const archivedHeader = page.getByRole("button", { name: /Archived/ });
    await expect(archivedHeader).toBeVisible();

    // Count badge should show "2"
    await expect(archivedHeader.getByText("2")).toBeVisible();
  });

  test("archived section is hidden when no archived tasks exist", async ({
    page,
  }) => {
    await setupArchivedSectionPage(page, mockBoardEmpty);

    await page.goto("/admin/agents/1?tab=kanban");

    // The "Archived" header should NOT be visible
    const archivedHeader = page.getByRole("button", { name: /Archived/ });
    await expect(archivedHeader).not.toBeVisible();
  });

  test("expanding archived section shows task cards", async ({ page }) => {
    await setupArchivedSectionPage(page, mockBoardWithArchived);

    await page.goto("/admin/agents/1?tab=kanban");

    // Click the archived header to expand
    const archivedHeader = page.getByRole("button", { name: /Archived/ });
    await archivedHeader.click();

    // Both archived task titles should now be visible
    await expect(page.getByText("Old research task")).toBeVisible();
    await expect(page.getByText("Legacy cleanup")).toBeVisible();
  });

  test("clicking archived task opens drawer with details", async ({
    page,
  }) => {
    await setupArchivedSectionPage(page, mockBoardWithSingleArchived, {
      "GET:/admin/api/agents/1/kanban/tasks/archived1": mockArchivedTaskDetail,
    });

    await page.goto("/admin/agents/1?tab=kanban");

    // Expand the archived section
    const archivedHeader = page.getByRole("button", { name: /Archived/ });
    await archivedHeader.click();

    // Click the archived task card
    await page.getByText("Old research task").click();

    // TaskDrawer should open — the title is rendered in an <input>
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    // The dialog aria-label includes the task title
    await expect(drawer).toHaveAttribute("aria-label", /Old research task/);
    // The title input should hold the task title
    const titleInput = drawer.locator("input[type='text']").first();
    await expect(titleInput).toHaveValue("Old research task");
  });
});
