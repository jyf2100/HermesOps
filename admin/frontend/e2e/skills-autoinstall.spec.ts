/**
 * E2E tests for the AgentSkillsTab AutoInstallPanel.
 *
 * Covers: panel appearance on hub-auto-install event, status icons per task
 * state, task status polling, auto-hide after completion, and error messages
 * for failed tasks.
 * All API responses are mocked -- no real backend needed.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  VALID_ADMIN_KEY,
  mockAgentDetail,
  mockEnvVars,
  mockConfigYaml,
  mockSoul,
  mockHealth,
  mockEvents,
} from "./fixtures/mock-data";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockInstalledSkillsEmpty = {
  ok: true,
  running: true,
  skills: [],
};

const mockTaskPending: Record<string, unknown> = {
  ok: true,
  task_id: "task-auto-1",
  status: "running",
  progress: 30,
  phase: "Fetching...",
};

const mockTaskCompleted: Record<string, unknown> = {
  ok: true,
  task_id: "task-auto-1",
  status: "completed",
  progress: 100,
  phase: "Completed",
};

const mockTaskFailed: Record<string, unknown> = {
  ok: true,
  task_id: "task-auto-2",
  status: "failed",
  progress: 0,
  phase: "Failed",
  error: "Download failed: connection timeout",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_ID = 1;

async function loginAndSetLang(page: Page) {
  await page.goto("/admin/login");
  await page.evaluate((key) => {
    localStorage.setItem("admin_api_key", key);
    localStorage.setItem("admin_lang", "en");
  }, VALID_ADMIN_KEY);
}

async function setupAgentRoutes(page: Page) {
  await page.route("**/admin/api/agents/1", (route) =>
    route.fulfill({ json: mockAgentDetail })
  );
  await page.route("**/admin/api/agents/1/env", (route) =>
    route.fulfill({ json: mockEnvVars })
  );
  await page.route("**/admin/api/agents/1/config", (route) =>
    route.fulfill({ json: mockConfigYaml })
  );
  await page.route("**/admin/api/agents/1/soul", (route) =>
    route.fulfill({ json: mockSoul })
  );
  await page.route("**/admin/api/agents/1/health", (route) =>
    route.fulfill({ json: mockHealth })
  );
  await page.route("**/admin/api/agents/1/events", (route) =>
    route.fulfill({ json: mockEvents })
  );
  await page.route("**/admin/api/hub/agents/1/skills", (route) =>
    route.fulfill({ json: mockInstalledSkillsEmpty })
  );
}

async function goToSkillsTab(page: Page) {
  await setupAgentRoutes(page);
  await loginAndSetLang(page);
  await page.goto(`/admin/agents/${AGENT_ID}?tab=skills`);
  await expect(page.locator('button[role="tab"]:has-text("Installed")')).toBeVisible();
}

async function dispatchAutoInstallEvent(
  page: Page,
  detail: { taskIds: string[]; skills: string[] }
) {
  await page.evaluate(({ taskIds, skills }) => {
    window.dispatchEvent(
      new CustomEvent("hub-auto-install", { detail: { taskIds, skills } })
    );
  }, detail);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Skills Auto-Install Progress", () => {
  test.beforeEach(async ({ page }) => {
    await loginAndSetLang(page);
  });

  // ----- Panel appears when event fires -----

  test("auto-install panel appears when hub-auto-install event fires", async ({ page }) => {
    await goToSkillsTab(page);

    // Panel should not be visible initially
    await expect(page.locator("text=Auto-Install Progress")).toHaveCount(0);

    // Dispatch the event
    await dispatchAutoInstallEvent(page, {
      taskIds: ["task-auto-1"],
      skills: ["web-search"],
    });

    // Panel should now be visible
    await expect(page.locator("text=Auto-Install Progress")).toBeVisible();
    await expect(page.locator("text=web-search")).toBeVisible();
  });

  // ----- Shows spinner for pending/running tasks -----

  test("shows spinner for pending/running tasks", async ({ page }) => {
    await goToSkillsTab(page);

    // Mock task status to return running
    await page.route("**/admin/api/hub/agents/1/tasks/**", (route) =>
      route.fulfill({ json: mockTaskPending })
    );

    await dispatchAutoInstallEvent(page, {
      taskIds: ["task-auto-1"],
      skills: ["web-search"],
    });

    await expect(page.locator("text=Auto-Install Progress")).toBeVisible();

    // The spinner is an SVG with animate-spin class
    const spinner = page.locator("svg.animate-spin");
    await expect(spinner.first()).toBeVisible();

    // Phase text should be visible
    await expect(page.locator("text=Fetching")).toBeVisible();
  });

  // ----- Shows green check for completed tasks -----

  test("shows green check for completed tasks", async ({ page }) => {
    await goToSkillsTab(page);

    // Mock task status to return completed
    await page.route("**/admin/api/hub/agents/1/tasks/**", (route) =>
      route.fulfill({ json: mockTaskCompleted })
    );

    await dispatchAutoInstallEvent(page, {
      taskIds: ["task-auto-1"],
      skills: ["web-search"],
    });

    await expect(page.locator("text=Auto-Install Progress")).toBeVisible();

    // Wait for polling to pick up the completed status (1500ms interval)
    await page.waitForTimeout(2500);

    // Should show "All skills installed" in the footer
    await expect(page.locator("text=All skills installed")).toBeVisible();
  });

  // ----- Shows red X for failed tasks -----

  test("shows red X for failed tasks", async ({ page }) => {
    await goToSkillsTab(page);

    // Mock task status to return failed
    await page.route("**/admin/api/hub/agents/1/tasks/**", (route) =>
      route.fulfill({ json: mockTaskFailed })
    );

    await dispatchAutoInstallEvent(page, {
      taskIds: ["task-auto-2"],
      skills: ["data-analyzer"],
    });

    await expect(page.locator("text=Auto-Install Progress")).toBeVisible();

    // Wait for polling to pick up the failed status
    await page.waitForTimeout(2500);

    // Should show the error message
    await expect(page.locator("text=Download failed: connection timeout")).toBeVisible();
  });

  // ----- Polls task status endpoint for each task -----

  test("polls task status endpoint for each task", async ({ page }) => {
    let pollCount = 0;
    let polledTaskId = "";

    // Override the task route with counting
    await page.route("**/admin/api/hub/agents/1/tasks/**", (route) => {
      pollCount++;
      const url = route.request().url();
      polledTaskId = url.split("/").pop() ?? "";
      return route.fulfill({ json: mockTaskPending });
    });

    await goToSkillsTab(page);

    await dispatchAutoInstallEvent(page, {
      taskIds: ["task-auto-99"],
      skills: ["my-skill"],
    });

    // Wait for at least one polling cycle (1500ms interval)
    await page.waitForTimeout(2500);

    expect(pollCount).toBeGreaterThanOrEqual(1);
    expect(polledTaskId).toBe("task-auto-99");
  });

  // ----- Panel auto-hides after all tasks complete -----

  test("panel auto-hides 3 seconds after all tasks complete", async ({ page }) => {
    await goToSkillsTab(page);

    // Mock task status to return completed
    await page.route("**/admin/api/hub/agents/1/tasks/**", (route) =>
      route.fulfill({ json: mockTaskCompleted })
    );

    await dispatchAutoInstallEvent(page, {
      taskIds: ["task-auto-1"],
      skills: ["web-search"],
    });

    await expect(page.locator("text=Auto-Install Progress")).toBeVisible();

    // Wait for polling to mark task as completed
    await page.waitForTimeout(2500);

    // Panel should still be visible right after completion
    await expect(page.locator("text=All skills installed")).toBeVisible();
    await expect(page.locator("text=Auto-Install Progress")).toBeVisible();

    // Wait for the 3-second auto-hide timer
    await page.waitForTimeout(4000);

    // Panel should now be hidden
    await expect(page.locator("text=Auto-Install Progress")).toHaveCount(0);
  });

  // ----- Shows error message for failed tasks in footer summary -----

  test("shows error message for failed tasks in footer summary", async ({ page }) => {
    await goToSkillsTab(page);

    // Return different statuses for different task IDs
    await page.route("**/admin/api/hub/agents/1/tasks/task-auto-1", (route) =>
      route.fulfill({ json: mockTaskCompleted })
    );
    await page.route("**/admin/api/hub/agents/1/tasks/task-auto-2", (route) =>
      route.fulfill({ json: mockTaskFailed })
    );

    await dispatchAutoInstallEvent(page, {
      taskIds: ["task-auto-1", "task-auto-2"],
      skills: ["web-search", "data-analyzer"],
    });

    await expect(page.locator("text=Auto-Install Progress")).toBeVisible();

    // Wait for polling
    await page.waitForTimeout(2500);

    // Should show failure count
    await expect(page.locator("text=/1 failed/")).toBeVisible();

    // The specific error should be visible for the failed task
    await expect(page.locator("text=Download failed: connection timeout")).toBeVisible();
  });

  // ----- Multiple tasks show progress counter -----

  test("shows correct progress counter for multiple tasks", async ({ page }) => {
    await goToSkillsTab(page);

    // All tasks running
    await page.route("**/admin/api/hub/agents/1/tasks/**", (route) =>
      route.fulfill({ json: mockTaskPending })
    );

    await dispatchAutoInstallEvent(page, {
      taskIds: ["task-1", "task-2", "task-3"],
      skills: ["skill-a", "skill-b", "skill-c"],
    });

    await expect(page.locator("text=Auto-Install Progress")).toBeVisible();

    // Should show 0/3 completed initially (tasks are still running)
    await expect(page.locator("text=0/3 completed")).toBeVisible();
  });

  // ----- Dismiss button appears when all done -----

  test("dismiss button appears when all tasks are done", async ({ page }) => {
    await goToSkillsTab(page);

    // Mock task status to return completed
    await page.route("**/admin/api/hub/agents/1/tasks/**", (route) =>
      route.fulfill({ json: mockTaskCompleted })
    );

    await dispatchAutoInstallEvent(page, {
      taskIds: ["task-auto-1"],
      skills: ["web-search"],
    });

    await expect(page.locator("text=Auto-Install Progress")).toBeVisible();

    // Wait for polling to complete
    await page.waitForTimeout(2500);

    // Dismiss button has aria-label="Close" (from t.close)
    const dismissBtn = page.locator('[aria-label="Close"]').first();
    await expect(dismissBtn).toBeVisible();

    // Clicking dismiss hides the panel immediately
    await dismissBtn.click();
    await expect(page.locator("text=Auto-Install Progress")).toHaveCount(0);
  });
});
