import { test, expect, type Page } from "@playwright/test";
import {
  VALID_USER_TOKEN,
  mockMyDispatchTasks,
  mockEmptyMyTasks,
} from "./fixtures/mock-data";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loginAsUser(page: Page) {
  await page.goto("/admin/login");
  await page.evaluate((token) => {
    localStorage.setItem("admin_mode", "user");
    localStorage.setItem("admin_user_token", token);
    localStorage.setItem("admin_user_agent_id", "1");
    localStorage.setItem("admin_user_display_name", "Agent #1");
    localStorage.setItem("admin_lang", "zh");
  }, VALID_USER_TOKEN);
}

async function goToMyTasks(page: Page, tasksData = mockMyDispatchTasks) {
  await page.route("**/admin/api/dispatch/my-tasks**", (route) => {
    if (route.request().method() === "POST") {
      const url = route.request().url();
      if (url.includes("/confirm")) {
        return route.fulfill({ json: { status: "confirmed" } });
      }
      if (url.includes("/reject")) {
        return route.fulfill({ json: { status: "rejected" } });
      }
    }
    return route.fulfill({ json: tasksData });
  });

  await page.goto("/admin/my-tasks");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "我的任务" })).toBeVisible({ timeout: 10000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("My Tasks Page (User Mode)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page);
  });

  // ----- Page load -----

  test("renders task list with status badges", async ({ page }) => {
    await goToMyTasks(page);

    await expect(page.getByText("Review code changes")).toBeVisible();
    await expect(page.getByText("Translate documentation")).toBeVisible();
    await expect(page.getByText("Analyze performance")).toBeVisible();

    // Status badges
    await expect(page.locator("span", { hasText: "待确认" }).first()).toBeVisible();
    await expect(page.locator("span", { hasText: "已确认" }).first()).toBeVisible();
    await expect(page.locator("span", { hasText: "已完成" }).first()).toBeVisible();
  });

  test("shows pending count badge", async ({ page }) => {
    await goToMyTasks(page);

    const badge = page.locator("span.animate-pulse");
    await expect(badge).toBeVisible();
    expect(await badge.textContent()).toBe("1");
  });

  // ----- Empty state -----

  test("shows empty state when no tasks", async ({ page }) => {
    await goToMyTasks(page, mockEmptyMyTasks);

    await expect(page.getByText("暂无任务")).toBeVisible();
  });

  // ----- Confirm / Reject buttons -----

  test("shows confirm and reject buttons for pending tasks", async ({ page }) => {
    await goToMyTasks(page);

    await expect(page.locator("button", { hasText: "确认" })).toBeVisible();
    await expect(page.locator("button", { hasText: "拒绝" })).toBeVisible();
  });

  test("does not show action buttons for completed tasks", async ({ page }) => {
    await goToMyTasks(page);

    // Completed task card
    const completedCard = page.locator("div.rounded-lg", { hasText: "Analyze performance" });
    await expect(completedCard.getByRole("button", { name: "确认" })).toHaveCount(0);
    await expect(completedCard.getByRole("button", { name: "拒绝" })).toHaveCount(0);
  });

  test("does not show action buttons for confirmed tasks", async ({ page }) => {
    await goToMyTasks(page);

    const confirmedCard = page.locator("div.rounded-lg", { hasText: "Translate documentation" });
    await expect(confirmedCard.getByRole("button", { name: "确认" })).toHaveCount(0);
    await expect(confirmedCard.getByRole("button", { name: "拒绝" })).toHaveCount(0);
  });

  // ----- Confirm action -----

  test("confirms a pending task", async ({ page }) => {
    let confirmUrl: string | null = null;

    await page.route("**/admin/api/dispatch/my-tasks**", (route) => {
      const url = route.request().url();
      if (route.request().method() === "POST" && url.includes("/confirm")) {
        confirmUrl = url;
        return route.fulfill({ json: { status: "confirmed" } });
      }
      return route.fulfill({ json: mockMyDispatchTasks });
    });

    await page.goto("/admin/my-tasks");
    await expect(page.getByRole("heading", { name: "我的任务" })).toBeVisible();

    // Click confirm on the pending task
    await page.locator("button", { hasText: "确认" }).first().click();

    // Should show success toast (in #admin-toast-container)
    await expect(page.locator("#admin-toast-container").getByText("已确认")).toBeVisible();

    await expect(() => {
      expect(confirmUrl).toBeTruthy();
      expect(confirmUrl).toContain("/confirm");
    }).toPass();
  });

  // ----- Reject action -----

  test("rejects a pending task", async ({ page }) => {
    let rejectUrl: string | null = null;

    await page.route("**/admin/api/dispatch/my-tasks**", (route) => {
      const url = route.request().url();
      if (route.request().method() === "POST" && url.includes("/reject")) {
        rejectUrl = url;
        return route.fulfill({ json: { status: "rejected" } });
      }
      return route.fulfill({ json: mockMyDispatchTasks });
    });

    await page.goto("/admin/my-tasks");
    await expect(page.getByRole("heading", { name: "我的任务" })).toBeVisible();

    // Click reject on the pending task
    await page.locator("button", { hasText: "拒绝" }).first().click();

    await expect(page.locator("#admin-toast-container").getByText("已拒绝")).toBeVisible();

    await expect(() => {
      expect(rejectUrl).toBeTruthy();
      expect(rejectUrl).toContain("/reject");
    }).toPass();
  });

  // ----- Expand / collapse -----

  test("expands task to show instructions", async ({ page }) => {
    await goToMyTasks(page);

    const card = page.locator("div.rounded-lg", { hasText: "Review code changes" });

    // Instructions not visible initially
    await expect(card.getByText("Focus on security and performance")).not.toBeVisible();

    // Click expand button
    await card.getByText("▼").click();

    await expect(card.getByText("Focus on security and performance")).toBeVisible();

    // Collapse
    await card.getByText("▲").click();
    await expect(card.getByText("Focus on security and performance")).not.toBeVisible();
  });

  test("shows completed_at for completed tasks when expanded", async ({ page }) => {
    await goToMyTasks(page);

    const card = page.locator("div.rounded-lg", { hasText: "Analyze performance" });
    await card.getByText("▼").click();

    await expect(card.getByText("完成时间")).toBeVisible();
  });

  // ----- Pending task visual highlight -----

  test("highlights pending tasks with yellow border", async ({ page }) => {
    await goToMyTasks(page);

    const pendingCard = page.locator("div.rounded-lg", { hasText: "Review code changes" });
    const classAttr = await pendingCard.getAttribute("class") || "";
    expect(classAttr).toContain("border-yellow-500");
  });

  // ----- Refresh button -----

  test("refresh button reloads tasks", async ({ page }) => {
    let fetchCount = 0;

    await page.route("**/admin/api/dispatch/my-tasks**", (route) => {
      fetchCount++;
      return route.fulfill({ json: mockMyDispatchTasks });
    });

    await page.goto("/admin/my-tasks");
    await expect(page.getByRole("heading", { name: "我的任务" })).toBeVisible();

    const initialCount = fetchCount;

    await page.getByText("刷新").click();

    await expect(() => {
      expect(fetchCount).toBeGreaterThan(initialCount);
    }).toPass();
  });

  // ----- Result summary -----

  test("shows result summary for completed tasks", async ({ page }) => {
    await goToMyTasks(page);

    await expect(page.getByText("Found 3 N+1 queries, fixed them")).toBeVisible();
  });
});
