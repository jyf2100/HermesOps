import { test, expect, type Page } from "@playwright/test";
import { loginAsAdminEn } from "./helpers";
import {
  mockAgentList,
  mockDispatchChannels,
  mockEmptyDispatchChannels,
  mockCreatedDispatchChannel,
  mockUpdatedDispatchChannel,
  mockChannelSubscribers,
  mockUpdatedChannelSubscribers,
  mockDispatchTasks,
  mockEmptyDispatchTasks,
  mockDispatchTaskDetail,
  mockDispatchTaskCreateResponse,
  mockDispatchTaskCancelResponse,
} from "./fixtures/mock-data";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Locate the innermost modal content box (the card inside the overlay). */
function modalCard(page: Page) {
  // Modals in this page render as: <div class="fixed inset-0 z-50 ..."> (backdrop) -> <div class="bg-surface ..."> (card)
  // We want the card element that has stopPropagation
  return page.locator(".fixed.inset-0.z-50 > .bg-surface, .fixed.inset-0.z-50 > .bg-surface\\/elevated").last();
}

/** Click the backdrop overlay to close a modal. */
async function clickBackdrop(page: Page) {
  // The modal backdrop is the outer fixed div with onClick={onClose}.
  // We click on it but NOT on the inner card. Use JavaScript to click the backdrop directly.
  await page.evaluate(() => {
    // Find the topmost fixed overlay and click it directly
    const overlays = document.querySelectorAll(".fixed.inset-0.z-50");
    const last = overlays[overlays.length - 1];
    if (last) (last as HTMLElement).click();
  });
}

/**
 * Set up API route mocks and navigate to the dispatch page.
 */
async function goToDispatch(
  page: Page,
  overrides?: {
    tasks?: unknown;
    channels?: unknown;
    agents?: unknown;
  }
) {
  const tasksData = overrides?.tasks ?? mockDispatchTasks;
  const channelsData = overrides?.channels ?? mockDispatchChannels;
  const agentsData = overrides?.agents ?? mockAgentList;

  await page.route("**/admin/api/dispatch/channels**", (route) => {
    return route.fulfill({ json: channelsData });
  });
  await page.route("**/admin/api/agents", (route) => {
    return route.fulfill({ json: agentsData });
  });
  await page.route("**/admin/api/dispatch/tasks**", (route) => {
    return route.fulfill({ json: tasksData });
  });

  await page.goto("/admin/dispatch");
  await expect(page.getByRole("heading", { name: "Task Dispatch" })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

test.describe("Task Dispatch Page", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  // ----- Page load & layout -----

  test("renders dispatch page with tasks tab active by default", async ({ page }) => {
    await goToDispatch(page);

    await expect(page.getByRole("heading", { name: "Task Dispatch" })).toBeVisible();

    const tasksTab = page.locator('button:has-text("Tasks")');
    await expect(tasksTab).toBeVisible();
    expect(await tasksTab.getAttribute("class")).toContain("accent-cyan");

    const channelsTab = page.locator('button:has-text("Channels")');
    await expect(channelsTab).toBeVisible();
    expect(await channelsTab.getAttribute("class")).not.toContain("font-medium");
  });

  // ----- Empty state -----

  test("shows empty state when no tasks exist", async ({ page }) => {
    await goToDispatch(page, {
      tasks: mockEmptyDispatchTasks,
      channels: mockEmptyDispatchChannels,
    });

    await expect(page.getByText("No dispatch tasks")).toBeVisible();
  });

  // ----- Task list rendering -----

  test("displays task list with status badges", async ({ page }) => {
    await goToDispatch(page);

    // All three task titles visible
    await expect(page.getByText("Review code changes").first()).toBeVisible();
    await expect(page.getByText("Translate documentation").first()).toBeVisible();
    await expect(page.getByText("Analyze performance").first()).toBeVisible();

    // Status badges are spans with status-specific colors.
    // Use locator chaining: find span containing the status text, then verify its color class.
    const completedBadge = page.locator("span", { hasText: /^Completed$/ }).first();
    await expect(completedBadge).toBeVisible();
    expect(await completedBadge.getAttribute("class") || "").toContain("text-emerald-400");

    const dispatchingBadge = page.locator("span", { hasText: /^Dispatching$/ }).first();
    await expect(dispatchingBadge).toBeVisible();
    expect(await dispatchingBadge.getAttribute("class") || "").toContain("text-yellow-400");

    const failedBadge = page.locator("span", { hasText: /^Failed$/ }).first();
    await expect(failedBadge).toBeVisible();
    expect(await failedBadge.getAttribute("class") || "").toContain("text-red-400");
  });

  test("shows dispatch type and created_by for each task", async ({ page }) => {
    await goToDispatch(page);

    const firstCard = page.getByText("Review code changes").first().locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
    await expect(firstCard.getByText("Direct", { exact: true })).toBeVisible();
    await expect(firstCard.getByText(/Created By: admin/)).toBeVisible();

    const secondCard = page.getByText("Translate documentation").first().locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
    await expect(secondCard.getByText("Channel", { exact: true })).toBeVisible();
  });

  test("shows assignment pills in task cards", async ({ page }) => {
    await goToDispatch(page);

    const secondCard = page.getByText("Translate documentation").first().locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
    await expect(secondCard.getByText("Agent 1")).toBeVisible();
    await expect(secondCard.getByText("Agent 2")).toBeVisible();
  });

  // ----- Status filtering -----

  test("filters tasks by status", async ({ page }) => {
    let capturedStatus: string | null = null;

    await page.route("**/admin/api/dispatch/channels**", (route) =>
      route.fulfill({ json: mockDispatchChannels })
    );
    await page.route("**/admin/api/agents", (route) =>
      route.fulfill({ json: mockAgentList })
    );
    await page.route("**/admin/api/dispatch/tasks**", (route) => {
      const url = new URL(route.request().url());
      capturedStatus = url.searchParams.get("status");
      if (capturedStatus === "completed") {
        return route.fulfill({
          json: { tasks: [mockDispatchTasks.tasks[0]], total: 1 },
        });
      }
      return route.fulfill({ json: mockDispatchTasks });
    });

    await page.goto("/admin/dispatch");
    await expect(page.getByRole("heading", { name: "Task Dispatch" })).toBeVisible();

    const statusSelect = page.locator("select").first();
    await statusSelect.selectOption("completed");

    await expect(() => {
      expect(capturedStatus).toBe("completed");
    }).toPass();

    await expect(page.getByText("Review code changes").first()).toBeVisible();
    await expect(page.getByText("Translate documentation")).toHaveCount(0);
  });

  // ----- Tab switching -----

  test("switches to channels tab and shows channels", async ({ page }) => {
    await goToDispatch(page);

    await page.click('button:has-text("Channels")');

    await expect(page.getByText("Engineering Team")).toBeVisible();
    await expect(page.getByText("Support Team")).toBeVisible();
    await expect(page.getByText("2 subscriber(s)")).toBeVisible();
    await expect(page.getByText("1 subscriber(s)")).toBeVisible();

    await expect(page.getByText("Review code changes")).toHaveCount(0);

    const channelsTab = page.locator('button:has-text("Channels")');
    expect(await channelsTab.getAttribute("class")).toContain("accent-cyan");
  });

  test("switching back to tasks tab restores task view", async ({ page }) => {
    await goToDispatch(page);

    await page.click('button:has-text("Channels")');
    await expect(page.getByText("Engineering Team")).toBeVisible();

    await page.click('button:has-text("Tasks")');

    await expect(page.getByText("Review code changes").first()).toBeVisible();
    await expect(page.getByText("Engineering Team")).toHaveCount(0);
  });

  test("shows empty state when no channels exist", async ({ page }) => {
    await goToDispatch(page, { channels: mockEmptyDispatchChannels });

    await page.click('button:has-text("Channels")');
    await expect(page.getByText("No channels created yet")).toBeVisible();
  });

  // ----- Channel CRUD -----

  test("creates a new channel via modal", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await goToDispatch(page);

    await page.route("**/admin/api/dispatch/channels**", (route) => {
      if (route.request().method() === "POST") {
        const url = route.request().url();
        if (url.includes("/subscribers")) {
          return route.fulfill({ json: mockUpdatedChannelSubscribers });
        }
        createBody = route.request().postDataJSON();
        return route.fulfill({ json: mockCreatedDispatchChannel });
      }
      return route.fulfill({ json: mockDispatchChannels });
    });

    await page.click('button:has-text("Channels")');

    // Click "Create Channel" button in the header area
    await page.locator('button:has-text("Create Channel")').click();

    // Modal appears — use h2 heading to verify
    const m = modalCard(page);
    await expect(m.getByRole("heading", { name: "Create Channel" })).toBeVisible();

    // Fill name (first input)
    await m.locator("input").first().fill("research");
    // Fill display name (second input)
    await m.locator("input").nth(1).fill("Research Team");
    // Fill description
    await m.locator("textarea").fill("Research and analysis agents");

    await m.locator('button:has-text("Save")').click();

    await expect(() => {
      expect(createBody).toBeTruthy();
      expect((createBody as Record<string, unknown>).name).toBe("research");
    }).toPass();
  });

  test("edits an existing channel", async ({ page }) => {
    let updateBody: Record<string, unknown> | null = null;

    await goToDispatch(page);

    await page.route("**/admin/api/dispatch/channels/**", (route) => {
      const method = route.request().method();
      const url = route.request().url();
      if (method === "PUT") {
        updateBody = route.request().postDataJSON();
        return route.fulfill({ json: mockUpdatedDispatchChannel });
      }
      if (method === "GET" && url.includes("/subscribers")) {
        return route.fulfill({ json: mockChannelSubscribers });
      }
      if (method === "POST" && url.includes("/subscribers")) {
        return route.fulfill({ json: mockUpdatedChannelSubscribers });
      }
      return route.fulfill({ json: mockDispatchChannels });
    });

    await page.click('button:has-text("Channels")');
    await page.locator('button:has-text("Edit Channel")').first().click();

    const m = modalCard(page);
    await expect(m.getByRole("heading", { name: "Edit Channel" })).toBeVisible();

    // Name field should be disabled
    const nameInput = m.locator("input").first();
    expect(await nameInput.isDisabled()).toBe(true);

    // Update display name
    const displayInput = m.locator("input").nth(1);
    await displayInput.clear();
    await displayInput.fill("Engineering Team Updated");

    await m.locator('button:has-text("Save")').click();

    await expect(() => {
      expect(updateBody).toBeTruthy();
      expect((updateBody as Record<string, unknown>).display_name).toBe("Engineering Team Updated");
    }).toPass();
  });

  test("deletes a channel with confirmation", async ({ page }) => {
    let deleted = false;

    await goToDispatch(page);

    await page.route("**/admin/api/dispatch/channels/**", (route) => {
      if (route.request().method() === "DELETE") {
        deleted = true;
        return route.fulfill({ json: { status: "deleted" } });
      }
      return route.fulfill({ json: mockDispatchChannels });
    });

    await page.click('button:has-text("Channels")');
    await page.locator('button:has-text("Delete Channel")').first().click();

    // ConfirmDialog should appear
    await expect(page.getByText(/Delete channel/)).toBeVisible();
    await page.locator('button:has-text("Confirm")').click();

    await expect(() => {
      expect(deleted).toBe(true);
    }).toPass();
  });

  test("deleting a channel can be cancelled", async ({ page }) => {
    let deleted = false;

    await goToDispatch(page);

    await page.route("**/admin/api/dispatch/channels/**", (route) => {
      if (route.request().method() === "DELETE") {
        deleted = true;
        return route.fulfill({ json: { status: "deleted" } });
      }
      return route.fulfill({ json: mockDispatchChannels });
    });

    await page.click('button:has-text("Channels")');
    await page.locator('button:has-text("Delete Channel")').first().click();

    // Click Cancel in the ConfirmDialog (the last overlay)
    await page.locator(".fixed.inset-0.z-50").last().locator('button:has-text("Cancel")').click();

    await expect(page.getByText("Engineering Team")).toBeVisible();
    expect(deleted).toBe(false);
  });

  // ----- Subscriber management -----

  test("opens subscriber modal and shows agents", async ({ page }) => {
    await goToDispatch(page);

    await page.route("**/admin/api/dispatch/channels/*/subscribers**", (route) => {
      return route.fulfill({ json: mockChannelSubscribers });
    });

    await page.click('button:has-text("Channels")');
    await page.locator('button:has-text("Subscribers")').first().click();

    const m = modalCard(page);
    await expect(m.getByText("hermes-gateway-1")).toBeVisible();
    await expect(m.getByText("hermes-gateway-2")).toBeVisible();
  });

  test("shows owner info on agent buttons", async ({ page }) => {
    await goToDispatch(page);

    await page.locator('button:has-text("New Task")').first().click();
    const m = modalCard(page);
    await expect(m.getByRole("heading", { name: "New Task" })).toBeVisible();

    // Agent 1 has owner_display_name "张三"
    await expect(m.getByText("张三")).toBeVisible();
    // Agent 2 has owner_display_name "李四"
    await expect(m.getByText("李四")).toBeVisible();
    // Agent 3 has no owner info — should NOT show any owner text
    const agent3Btn = m.locator('button:has-text("hermes-gateway-3")');
    await expect(agent3Btn).toBeVisible();
    // Verify no sub-span (owner info) inside the agent 3 button
    const agent3Texts = await agent3Btn.locator("span").count();
    expect(agent3Texts).toBe(0);
  });

  test("saves subscriber changes", async ({ page }) => {
    let savedBody: Record<string, unknown> | null = null;

    await goToDispatch(page);

    await page.route("**/admin/api/dispatch/channels/*/subscribers**", (route) => {
      const method = route.request().method();
      if (method === "GET") {
        return route.fulfill({ json: mockChannelSubscribers });
      }
      if (method === "POST") {
        savedBody = route.request().postDataJSON();
        return route.fulfill({ json: mockUpdatedChannelSubscribers });
      }
      return route.fulfill({ status: 404, json: { detail: "Not found" } });
    });

    await page.click('button:has-text("Channels")');
    await page.locator('button:has-text("Subscribers")').first().click();

    const m = modalCard(page);
    await expect(m.getByText("hermes-gateway-1")).toBeVisible();

    // Click Save button inside the subscriber modal
    await m.locator("button").filter({ hasText: "Save" }).click();

    await expect(() => {
      expect(savedBody).toBeTruthy();
    }).toPass();
  });

  // ----- Create task modal -----

  test("opens create task modal and validates required fields", async ({ page }) => {
    await goToDispatch(page);

    await page.locator('button:has-text("New Task")').first().click();

    const m = modalCard(page);
    await expect(m.getByRole("heading", { name: "New Task" })).toBeVisible();

    // Submit button should be disabled without required fields
    const submitBtn = m.locator('button[type="submit"]');
    expect(await submitBtn.isEnabled()).toBe(false);
  });

  test("create task modal closes on Cancel", async ({ page }) => {
    await goToDispatch(page);

    await page.locator('button:has-text("New Task")').first().click();

    const m = modalCard(page);
    await expect(m.getByRole("heading", { name: "New Task" })).toBeVisible();

    await m.locator('button:has-text("Cancel")').click();

    // Modal card should disappear
    await expect(m).not.toBeVisible();
  });

  // ----- Direct dispatch task creation -----

  test("creates a direct dispatch task", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await goToDispatch(page);

    await page.route("**/admin/api/dispatch/tasks**", (route) => {
      if (route.request().method() === "POST") {
        createBody = route.request().postDataJSON();
        return route.fulfill({ json: mockDispatchTaskCreateResponse });
      }
      return route.fulfill({ json: mockDispatchTasks });
    });

    await page.locator('button:has-text("New Task")').first().click();

    const m = modalCard(page);
    await expect(m.getByRole("heading", { name: "New Task" })).toBeVisible();

    // Fill title — first input in the form
    await m.locator("input").first().fill("New dispatch task");
    // Fill prompt — first textarea
    await m.locator("textarea").first().fill("Please review the latest changes");

    // "direct" type should be selected by default
    const directBtn = m.locator('button:has-text("Direct")');
    expect(await directBtn.getAttribute("class")).toContain("accent-cyan");

    // Click an agent button to select it
    await m.locator('button:has-text("hermes-gateway-1")').click();

    await m.locator('button[type="submit"]').click();

    await expect(() => {
      expect(createBody).toBeTruthy();
      const body = createBody as Record<string, unknown>;
      expect(body.title).toBe("New dispatch task");
      expect(body.prompt).toBe("Please review the latest changes");
      expect(body.dispatch_type).toBe("direct");
      expect(body.target_agents).toContain(1);
    }).toPass();
  });

  // ----- Channel dispatch task creation -----

  test("creates a channel dispatch task", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await goToDispatch(page);

    await page.route("**/admin/api/dispatch/tasks**", (route) => {
      if (route.request().method() === "POST") {
        createBody = route.request().postDataJSON();
        return route.fulfill({ json: mockDispatchTaskCreateResponse });
      }
      return route.fulfill({ json: mockDispatchTasks });
    });

    await page.locator('button:has-text("New Task")').first().click();

    const m = modalCard(page);
    await expect(m.getByRole("heading", { name: "New Task" })).toBeVisible();

    await m.locator("input").first().fill("Channel dispatch task");
    await m.locator("textarea").first().fill("Translate all docs to Chinese");

    // Switch to channel dispatch type
    await m.locator('button:has-text("Channel")').click();

    // Select a channel from the dropdown
    await m.locator("select").selectOption("1");

    await m.locator('button[type="submit"]').click();

    await expect(() => {
      expect(createBody).toBeTruthy();
      const body = createBody as Record<string, unknown>;
      expect(body.dispatch_type).toBe("channel");
      expect(body.channel_id).toBe(1);
    }).toPass();
  });

  test("channel dispatch requires channel selection", async ({ page }) => {
    await goToDispatch(page);

    await page.locator('button:has-text("New Task")').first().click();

    const m = modalCard(page);
    await expect(m.getByRole("heading", { name: "New Task" })).toBeVisible();

    await m.locator("input").first().fill("Test task");
    await m.locator("textarea").first().fill("Test prompt");

    // Switch to channel type but don't select a channel
    await m.locator('button:has-text("Channel")').click();

    // Submit button is enabled (title and prompt filled)
    const submitBtn = m.locator('button[type="submit"]');
    expect(await submitBtn.isEnabled()).toBe(true);
  });

  // ----- Task detail modal -----

  test("opens task detail modal", async ({ page }) => {
    await goToDispatch(page);

    await page.route("**/admin/api/dispatch/tasks/*", (route) => {
      return route.fulfill({ json: mockDispatchTaskDetail });
    });

    await page.locator('button:has-text("View Detail")').first().click();

    const m = modalCard(page);
    await expect(m.getByRole("heading", { name: "Review code changes" })).toBeVisible();
    await expect(m.getByText("Review the latest pull request and provide feedback")).toBeVisible();
    await expect(m.getByText("Focus on security and performance")).toBeVisible();
    await expect(m.getByText("Assignments")).toBeVisible();
    await expect(m.getByText("Agent 1")).toBeVisible();
    await expect(m.getByText("default")).toBeVisible();

    await m.locator('button:has-text("Close")').click();
  });

  test("task detail modal closes on backdrop click", async ({ page }) => {
    await goToDispatch(page);

    await page.route("**/admin/api/dispatch/tasks/*", (route) => {
      return route.fulfill({ json: mockDispatchTaskDetail });
    });

    await page.locator('button:has-text("View Detail")').first().click();

    const m = modalCard(page);
    await expect(m.getByText("Review the latest pull request")).toBeVisible();

    // Close via backdrop
    await clickBackdrop(page);

    await expect(m).not.toBeVisible();
  });

  // ----- Cancel task -----

  test("cancels a task with confirmation", async ({ page }) => {
    let cancelled = false;

    await goToDispatch(page);

    await page.route("**/admin/api/dispatch/tasks/*/cancel", (route) => {
      cancelled = true;
      return route.fulfill({ json: mockDispatchTaskCancelResponse });
    });

    const taskCard = page.getByText("Translate documentation").first().locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
    await expect(taskCard.locator('button:has-text("Cancel Task")')).toBeVisible();

    await taskCard.locator('button:has-text("Cancel Task")').click();

    await expect(page.getByText("Cancel this task?")).toBeVisible();
    await page.locator('button:has-text("Confirm")').click();

    await expect(() => {
      expect(cancelled).toBe(true);
    }).toPass();
  });

  test("cancel task can be dismissed", async ({ page }) => {
    let cancelled = false;

    await goToDispatch(page);

    await page.route("**/admin/api/dispatch/tasks/*/cancel", (route) => {
      cancelled = true;
      return route.fulfill({ json: mockDispatchTaskCancelResponse });
    });

    const taskCard = page.getByText("Translate documentation").first().locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
    await taskCard.locator('button:has-text("Cancel Task")').click();

    // Cancel via the ConfirmDialog
    await page.locator(".fixed.inset-0.z-50").last().locator('button:has-text("Cancel")').click();

    expect(cancelled).toBe(false);
  });

  test("completed task does not show cancel button", async ({ page }) => {
    await goToDispatch(page);

    const completedCard = page.getByText("Review code changes").first().locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
    await expect(completedCard.locator('button:has-text("Cancel Task")')).toHaveCount(0);
  });

  // ----- Pagination -----

  test("shows pagination when total exceeds page size", async ({ page }) => {
    const manyTasks = Array.from({ length: 25 }, (_, i) => ({
      id: 200 + i,
      title: `Pagination Task ${i + 1}`,
      dispatch_type: "direct",
      status: "completed",
      channel_id: null,
      priority: 5,
      created_by: "admin",
      created_at: "2026-05-19T10:00:00Z",
      result_summary: null,
      assignments: [],
    }));

    await goToDispatch(page, { tasks: { tasks: manyTasks, total: 25 } });

    await expect(page.locator('button:has-text("Prev")')).toBeVisible();
    await expect(page.locator('button:has-text("Next")')).toBeVisible();
    await expect(page.getByText("1 / 2")).toBeVisible();
    await expect(page.locator('button:has-text("Prev")')).toBeDisabled();
    await expect(page.locator('button:has-text("Next")')).toBeEnabled();
  });

  // ----- Modal backdrop close -----

  test("channel create modal closes on backdrop click", async ({ page }) => {
    await goToDispatch(page);

    await page.click('button:has-text("Channels")');
    await page.locator('button:has-text("Create Channel")').click();

    const m = modalCard(page);
    await expect(m.getByRole("heading", { name: "Create Channel" })).toBeVisible();

    await clickBackdrop(page);

    await expect(m).not.toBeVisible();
  });

  // ----- "New Task" button only shows on Tasks tab -----

  test("New Task button only shows on tasks tab", async ({ page }) => {
    await goToDispatch(page);

    await expect(page.locator('button:has-text("New Task")').first()).toBeVisible();

    await page.click('button:has-text("Channels")');

    await expect(page.locator('button:has-text("New Task")')).toHaveCount(0);
    await expect(page.locator('button:has-text("Create Channel")')).toBeVisible();
  });
});
