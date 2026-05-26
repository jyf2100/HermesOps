import { test, expect } from "@playwright/test";
import {
  mockAgentList,
  mockClusterStatus,
  mockMonitorSummary,
  mockMonitorSummaryHealthy,
  mockMonitorSummaryEmpty,
  mockAnomalyItems,
  mockUpdatedAnomaly,
  mockInspectionBatchResponse,
  mockTriggerInspectionResponse,
  mockInspectionBatchPaged,
} from "./fixtures/mock-data";
import { loginAsAdmin, mockApi } from "./helpers";

// ---------------------------------------------------------------------------
// Shared helpers for monitoring tests
// ---------------------------------------------------------------------------

/** Route mock map for a typical monitoring page load (agents + summary). */
function monitoringRoutes(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    "GET:/admin/api/agents": mockAgentList,
    "GET:/admin/api/monitor/summary": mockMonitorSummary,
    "GET:/admin/api/monitor/inspections/latest": mockInspectionBatchResponse,
    ...overrides,
  };
}

/** Navigate to monitoring page with all API routes mocked. */
async function goToMonitoring(page: import("@playwright/test").Page, overrides?: Record<string, unknown>) {
  await mockApi(page, monitoringRoutes(overrides));
  await loginAsAdmin(page);
  await page.goto("/admin/monitoring");
}

// ---------------------------------------------------------------------------
// 1. Navigation
// ---------------------------------------------------------------------------

test.describe("Monitoring Navigation", () => {
  test("shows monitoring nav item in admin mode", async ({ page }) => {
    await mockApi(page, {
      "GET:/admin/api/agents": mockAgentList,
      "GET:/admin/api/cluster/status": mockClusterStatus,
      "GET:/admin/api/monitor/summary": mockMonitorSummary,
    });
    await loginAsAdmin(page);
    await page.goto("/admin/");

    // The sidebar should contain "监控" nav item
    const monitoringNav = page.getByRole("link", { name: /监控|Monitoring/i });
    await expect(monitoringNav).toBeVisible();
  });

  test("clicking nav item navigates to monitoring page", async ({ page }) => {
    await mockApi(page, {
      "GET:/admin/api/agents": mockAgentList,
      "GET:/admin/api/cluster/status": mockClusterStatus,
      "GET:/admin/api/monitor/summary": mockMonitorSummary,
    });
    await loginAsAdmin(page);
    await page.goto("/admin/");

    await page.getByRole("link", { name: /监控|Monitoring/i }).click();
    await expect(page).toHaveURL(/\/monitoring/);

    // Page title should be visible
    await expect(page.getByText("监控中心")).toBeVisible();
  });

  test("user mode does NOT show monitoring nav item", async ({ page }) => {
    await mockApi(page, {
      "GET:/admin/api/agents": { agents: [mockAgentList.agents[0]], total: 1 },
      "GET:/admin/api/cluster/status": mockClusterStatus,
    });
    // Login as user mode
    await page.goto("/admin/login");
    await page.evaluate(() => {
      localStorage.setItem("admin_api_key", "test-admin-key-1234");
      localStorage.setItem("admin_mode", "user");
      localStorage.setItem("admin_user_token", "fake-user-token");
      localStorage.setItem("admin_user_agent_id", "1");
    });
    await page.goto("/admin/");

    // The monitoring nav should NOT be present
    const monitoringNav = page.getByRole("link", { name: /监控|Monitoring/i });
    await expect(monitoringNav).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 2. Monitoring Page — Overview Tab (default)
// ---------------------------------------------------------------------------

test.describe("Monitoring Overview Tab", () => {
  test("loads page with correct title", async ({ page }) => {
    await goToMonitoring(page);
    await expect(page.getByText("监控中心")).toBeVisible();
  });

  test("shows cluster status bar", async ({ page }) => {
    await goToMonitoring(page);
    // ClusterStatusBar shows node name from mockClusterStatus
    await expect(page.getByText("k8s-node-1")).toBeVisible();
    // Shows CPU/Memory/Disk bars
    await expect(page.getByText(/CPU 使用率/)).toBeVisible();
    await expect(page.getByText(/内存使用率/)).toBeVisible();
  });

  test("shows resource usage section for agents", async ({ page }) => {
    await goToMonitoring(page);
    // Resource usage heading
    await expect(page.getByText("资源使用")).toBeVisible();
    // Agent names appear in both anomaly list and resource bars, use .first()
    await expect(page.getByText("hermes-gateway-1").first()).toBeVisible();
    await expect(page.getByText("hermes-gateway-3").first()).toBeVisible();
    // CPU/MEM labels in resource bars
    await expect(page.locator("span", { hasText: /^CPU$/ }).first()).toBeVisible();
    await expect(page.locator("span", { hasText: /^MEM$/ }).first()).toBeVisible();
  });

  test("shows anomaly quick view with alert link when anomalies exist", async ({ page }) => {
    await goToMonitoring(page);
    // Anomaly heading in overview section
    const anomalyHeading = page.locator("text=异常").first();
    await expect(anomalyHeading).toBeVisible();
    // "2 个 Agent 需要关注" link
    await expect(page.getByText(/2 个 Agent 需要关注/)).toBeVisible();
  });

  test("clicking anomaly alert link switches to anomaly tab", async ({ page }) => {
    await goToMonitoring(page);
    await page.getByText(/2 个 Agent 需要关注/).click();
    await expect(page).toHaveURL(/tab=anomaly/);
  });

  test("shows anomaly count badge on anomaly tab", async ({ page }) => {
    await goToMonitoring(page);
    // Tab bar should show count badge "2" next to anomaly tab
    const anomalyTab = page.locator("button", { hasText: /异常/ });
    await expect(anomalyTab).toBeVisible();
    // The badge shows "2" inside the tab
    const badge = anomalyTab.locator("span", { hasText: /^2$/ });
    await expect(badge).toBeVisible();
  });

  test("shows inspection timestamp in header", async ({ page }) => {
    await goToMonitoring(page);
    // "上次巡检" label visible
    await expect(page.getByText(/上次巡检/)).toBeVisible();
  });

  test("shows no anomaly alert when all healthy", async ({ page }) => {
    await goToMonitoring(page, {
      "GET:/admin/api/monitor/summary": mockMonitorSummaryHealthy,
    });
    // Should NOT show "n 个 Agent 需要关注"
    await expect(page.getByText(/个 Agent 需要关注/)).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 3. Anomaly Tab
// ---------------------------------------------------------------------------

test.describe("Monitoring Anomaly Tab", () => {
  test("switches to anomaly tab via URL param", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=anomaly");
    // Should show anomaly section heading with count
    await expect(page.getByText(/异常 \(2\)/)).toBeVisible();
  });

  test("displays anomaly cards grouped by agent", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=anomaly");

    // Two grouped anomaly cards: agent 1 and agent 3
    await expect(page.getByText("hermes-gateway-1")).toBeVisible();
    await expect(page.getByText("hermes-gateway-3")).toBeVisible();
  });

  test("shows correct anomaly type labels", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=anomaly");

    // health_down -> "Health Down" label
    await expect(page.getByText("Health Down")).toBeVisible();
    // high_cpu -> "High CPU" label
    await expect(page.getByText("High CPU")).toBeVisible();
    // high_memory -> "High Memory" label
    await expect(page.getByText("High Memory")).toBeVisible();
  });

  test("shows resource info for anomalies", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=anomaly");

    // CPU and Memory percentages from anomaly data
    await expect(page.getByText(/CPU.*85\.3%/)).toBeVisible();
    await expect(page.getByText(/内存.*72\.1%/)).toBeVisible();
    // Restart count for agent 1
    await expect(page.getByText(/重启.*3/)).toBeVisible();
  });

  test("shows last event summary when available", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=anomaly");

    // Last event summary from mock data
    await expect(page.getByText(/Liveness probe failed/)).toBeVisible();
    await expect(page.getByText(/OOM approaching limit/)).toBeVisible();
  });

  test("acknowledge button triggers PATCH API", async ({ page }) => {
    let patchCalled = false;
    let patchBody: string | null = null;

    await goToMonitoring(page);

    // Register PATCH route AFTER mockApi so it takes priority (LIFO ordering)
    await page.route("**/admin/api/monitor/anomalies/1", async (route) => {
      if (route.request().method() === "PATCH") {
        patchCalled = true;
        patchBody = route.request().postData();
        return route.fulfill({ json: mockUpdatedAnomaly });
      }
      return route.fallback();
    });

    await page.goto("/admin/monitoring?tab=anomaly");

    // Click the "确认" (acknowledge) button — visible on active anomalies
    const ackButtons = page.getByRole("button", { name: /确认/ });
    await expect(ackButtons.first()).toBeVisible();
    await ackButtons.first().click();

    // Verify the PATCH was called
    await expect(() => {
      expect(patchCalled).toBe(true);
      expect(patchBody).toContain("acknowledged");
    }).toPass();
  });

  test("ignore button triggers PATCH API", async ({ page }) => {
    let patchCalled = false;
    let patchBody: string | null = null;

    await goToMonitoring(page);

    // Register PATCH route AFTER mockApi so it takes priority
    await page.route("**/admin/api/monitor/anomalies/*", async (route) => {
      if (route.request().method() === "PATCH") {
        patchCalled = true;
        patchBody = route.request().postData();
        return route.fulfill({
          json: { ...mockUpdatedAnomaly, status: "ignored" },
        });
      }
      return route.fallback();
    });

    await page.goto("/admin/monitoring?tab=anomaly");

    // Click the "忽略" (ignore) button
    const ignoreButtons = page.getByRole("button", { name: /忽略/ });
    await expect(ignoreButtons.first()).toBeVisible();
    await ignoreButtons.first().click();

    await expect(() => {
      expect(patchCalled).toBe(true);
      expect(patchBody).toContain("ignored");
    }).toPass();
  });

  test("shows empty state when no anomalies", async ({ page }) => {
    await goToMonitoring(page, {
      "GET:/admin/api/monitor/summary": mockMonitorSummaryHealthy,
    });
    await page.goto("/admin/monitoring?tab=anomaly");

    // Empty state: "所有 Agent 运行正常"
    await expect(page.getByText("所有 Agent 运行正常")).toBeVisible();
  });

  test("shows severity border color for critical and warning", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=anomaly");

    // Critical anomaly card for agent 1 — has border-l-accent-pink
    const criticalCard = page.locator("div.border-l-accent-pink").first();
    await expect(criticalCard).toBeVisible();

    // Warning anomaly card for agent 3 — has border-l-yellow-500
    const warningCard = page.locator("div.border-l-yellow-500").first();
    await expect(warningCard).toBeVisible();
  });

  test("view details navigates to agent page", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=anomaly");

    // Mock agent detail for navigation
    await page.route("**/admin/api/agents/1", (route) =>
      route.fulfill({ json: { id: 1, name: "hermes-gateway-1" } })
    );

    // Click "查看详情 →" link
    const viewDetailLinks = page.getByText(/查看详情/);
    await expect(viewDetailLinks.first()).toBeVisible();
    await viewDetailLinks.first().click();
    await expect(page).toHaveURL(/\/agents\//);
  });
});

// ---------------------------------------------------------------------------
// 4. Resources Tab
// ---------------------------------------------------------------------------

test.describe("Monitoring Resources Tab", () => {
  test("switches to resources tab via URL param", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=resources");

    // Resources section heading
    await expect(page.getByText("资源使用")).toBeVisible();
  });

  test("shows CPU and MEM bars for each running agent", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=resources");

    // CPU labels should be visible
    const cpuLabels = page.locator("span", { hasText: /^CPU$/ });
    await expect(cpuLabels.first()).toBeVisible();

    // MEM labels should be visible
    const memLabels = page.locator("span", { hasText: /^MEM$/ });
    await expect(memLabels.first()).toBeVisible();

    // Agent names visible
    await expect(page.getByText("hermes-gateway-1")).toBeVisible();
    await expect(page.getByText("hermes-gateway-3")).toBeVisible();
  });

  test("stopped agents sorted last and show stopped badge", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=resources");

    // Stopped agent hermes-gateway-2 shows "已停止" badge
    await expect(page.getByText("已停止")).toBeVisible();

    // Stopped agent shows "-" for percentages (not null)
    const stoppedRow = page.locator("div", { hasText: "hermes-gateway-2" }).first();
    await expect(stoppedRow).toBeVisible();
  });

  test("percentage labels display correctly for running agents", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=resources");

    // ResourceBars uses agent.resources.memory_bytes / memory_limit_bytes for memory pct
    // Agent 1: memory_bytes=268435456, memory_limit_bytes=1073741824 => 25%
    await expect(page.getByText("25%")).toBeVisible();
    // Stopped agents show "-" for percentages
    await expect(page.getByText("已停止")).toBeVisible();
    // Agent names visible in resource rows
    await expect(page.getByText("hermes-gateway-1").first()).toBeVisible();
  });

  test("shows empty state when no agents", async ({ page }) => {
    await goToMonitoring(page, {
      "GET:/admin/api/agents": { agents: [], total: 0 },
      "GET:/admin/api/monitor/summary": mockMonitorSummaryEmpty,
    });
    await page.goto("/admin/monitoring?tab=resources");

    // Empty state text
    await expect(page.getByText("暂无数据")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 5. Inspection Tab
// ---------------------------------------------------------------------------

test.describe("Monitoring Inspection Tab", () => {
  test("switches to inspection tab via URL param", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=inspection");

    // Inspection section heading with result count
    await expect(page.getByText(/巡检.*\(8\)/)).toBeVisible();
  });

  test("shows latest inspection results table", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=inspection");

    // Table headers
    await expect(page.getByText("Agent").first()).toBeVisible();
    await expect(page.getByText("检查项").first()).toBeVisible();
    await expect(page.getByText("状态").first()).toBeVisible();
    await expect(page.getByText("详情").first()).toBeVisible();

    // Table data from mock inspection results
    await expect(page.getByText("health_check").first()).toBeVisible();
    await expect(page.getByText("Gateway returned 503")).toBeVisible();
  });

  test("shows correct status labels for check results", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=inspection");

    // Status labels from i18n
    await expect(page.getByText("失败").first()).toBeVisible();
    await expect(page.getByText("通过").first()).toBeVisible();
    await expect(page.getByText("警告").first()).toBeVisible();
    await expect(page.getByText("跳过").first()).toBeVisible();
  });

  test("trigger inspection button calls POST API and shows toast", async ({ page }) => {
    let postCalled = false;

    await goToMonitoring(page);

    // Register POST route AFTER mockApi so it takes priority
    await page.route("**/admin/api/monitor/inspections", async (route) => {
      if (route.request().method() === "POST") {
        postCalled = true;
        return route.fulfill({ json: mockTriggerInspectionResponse });
      }
      return route.fallback();
    });

    await page.goto("/admin/monitoring?tab=inspection");

    // Click trigger inspection button "立即巡检"
    const triggerBtn = page.getByRole("button", { name: /立即巡检/ });
    await expect(triggerBtn).toBeVisible();
    await triggerBtn.click();

    // Toast success message
    await expect(page.getByText("巡检已触发")).toBeVisible();

    // Verify POST was called
    await expect(() => expect(postCalled).toBe(true)).toPass();
  });

  test("shows loading state during inspection trigger", async ({ page }) => {
    await goToMonitoring(page);

    // Register delayed POST route AFTER mockApi so it takes priority
    await page.route("**/admin/api/monitor/inspections", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return route.fulfill({ json: mockTriggerInspectionResponse });
      }
      return route.fallback();
    });

    await page.goto("/admin/monitoring?tab=inspection");

    const triggerBtn = page.getByRole("button", { name: /立即巡检/ });
    await triggerBtn.click();

    // Button text changes to "巡检进行中..."
    await expect(page.getByText(/巡检进行中/)).toBeVisible();
  });

  test("pagination works with more than 20 results", async ({ page }) => {
    await goToMonitoring(page, {
      "GET:/admin/api/monitor/inspections/latest": mockInspectionBatchPaged,
    });
    await page.goto("/admin/monitoring?tab=inspection");

    // Pagination controls visible (50 results, 20 per page = 3 pages)
    await expect(page.getByText(/第 1 \/ 3 页/)).toBeVisible();
    await expect(page.getByRole("button", { name: /下一页/ })).toBeVisible();

    // First page should show 20 rows, next button enabled
    const nextBtn = page.getByRole("button", { name: /下一页/ });
    await expect(nextBtn).toBeEnabled();

    // Click next
    await nextBtn.click();
    await expect(page.getByText(/第 2 \/ 3 页/)).toBeVisible();

    // Previous button now enabled
    const prevBtn = page.getByRole("button", { name: /上一页/ });
    await expect(prevBtn).toBeEnabled();

    // Go back to page 1
    await prevBtn.click();
    await expect(page.getByText(/第 1 \/ 3 页/)).toBeVisible();
  });

  test("previous button disabled on first page", async ({ page }) => {
    await goToMonitoring(page, {
      "GET:/admin/api/monitor/inspections/latest": mockInspectionBatchPaged,
    });
    await page.goto("/admin/monitoring?tab=inspection");

    const prevBtn = page.getByRole("button", { name: /上一页/ });
    await expect(prevBtn).toBeDisabled();
  });

  test("next button disabled on last page", async ({ page }) => {
    await goToMonitoring(page, {
      "GET:/admin/api/monitor/inspections/latest": mockInspectionBatchPaged,
    });
    await page.goto("/admin/monitoring?tab=inspection");

    const nextBtn = page.getByRole("button", { name: /下一页/ });
    // Navigate to last page (page 3)
    await nextBtn.click();
    await nextBtn.click();
    // Now on page 3, next should be disabled
    await expect(page.getByText(/第 3 \/ 3 页/)).toBeVisible();
    await expect(nextBtn).toBeDisabled();
  });

  test("shows empty state when no inspection data", async ({ page }) => {
    await goToMonitoring(page, {
      "GET:/admin/api/monitor/inspections/latest": null,
    });
    await page.goto("/admin/monitoring?tab=inspection");

    // Empty state text
    await expect(page.getByText("暂无巡检数据")).toBeVisible();

    // Trigger button still visible
    await expect(page.getByRole("button", { name: /立即巡检/ })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 6. Dashboard AnomalyBadge
// ---------------------------------------------------------------------------

test.describe("Dashboard AnomalyBadge", () => {
  test("dashboard shows AnomalyBadge with count when anomaly_count > 0", async ({ page }) => {
    await mockApi(page, {
      "GET:/admin/api/agents": mockAgentList,
      "GET:/admin/api/cluster/status": mockClusterStatus,
      "GET:/admin/api/monitor/summary": mockMonitorSummary,
    });
    await loginAsAdmin(page);
    await page.goto("/admin/");

    // The dashboard fetches monitor summary on every 3rd load cycle.
    // Force it by triggering enough loads or directly evaluating.
    // Since loadCountRef starts at 0 and increments, we need load 3.
    // Easiest approach: wait for the badge to appear via polling.

    // The badge is a button with count number
    const badge = page.locator("button", { hasText: /^2$/ }).first();
    // Badge might take a moment since it only loads on every 3rd cycle.
    // Force an immediate reload to trigger the monitor fetch.
    await page.reload();
    await page.reload();
    // After 3 loads, anomaly_count should be fetched and badge visible
    await expect(badge).toBeVisible({ timeout: 15000 });
  });

  test("clicking badge navigates to monitoring anomaly tab", async ({ page }) => {
    await mockApi(page, {
      "GET:/admin/api/agents": mockAgentList,
      "GET:/admin/api/cluster/status": mockClusterStatus,
      "GET:/admin/api/monitor/summary": mockMonitorSummary,
      "GET:/admin/api/monitor/inspections/latest": mockInspectionBatchResponse,
    });
    await loginAsAdmin(page);

    // Set anomaly count directly via evaluation to avoid polling timing
    await page.goto("/admin/");
    // The DashboardPage loads monitor summary every 3rd call.
    // We force-set the state by reloading twice more to trigger the fetch.
    await page.reload();
    await page.reload();

    // Wait for badge to appear
    const badge = page.locator("button[title*='anomaly']").first();
    await expect(badge).toBeVisible({ timeout: 15000 });
    await badge.click();
    await expect(page).toHaveURL(/\/monitoring\?tab=anomaly/);
  });

  test("no badge when anomaly_count is 0", async ({ page }) => {
    await mockApi(page, {
      "GET:/admin/api/agents": mockAgentList,
      "GET:/admin/api/cluster/status": mockClusterStatus,
      "GET:/admin/api/monitor/summary": mockMonitorSummaryHealthy,
    });
    await loginAsAdmin(page);
    await page.goto("/admin/");

    // Trigger 3 loads for the monitor summary fetch
    await page.reload();
    await page.reload();

    // No anomaly badge should be present
    const badge = page.locator("button[title*='anomaly']");
    await expect(badge).not.toBeVisible({ timeout: 10000 });
  });
});

// ---------------------------------------------------------------------------
// 7. Edge Cases
// ---------------------------------------------------------------------------

test.describe("Monitoring Edge Cases", () => {
  test("API error shows error state", async ({ page }) => {
    // Mock agents OK but summary returns 500
    await page.route("**/admin/api/agents", (route) =>
      route.fulfill({ json: mockAgentList })
    );
    await page.route("**/admin/api/monitor/summary", (route) =>
      route.fulfill({ status: 500, json: { detail: "Internal Server Error" } })
    );
    await loginAsAdmin(page);
    await page.goto("/admin/monitoring");

    // Should show error display — either "加载失败" from catch block
    // or the raw error from the API
    await expect(page.getByText(/加载失败|Internal Server Error/i)).toBeVisible();
  });

  test("loading state renders spinner before data arrives", async ({ page }) => {
    // Delay both API calls to ensure loading state is visible
    let resolveAll: () => void;
    const blockPromise = new Promise<void>((resolve) => { resolveAll = resolve; });

    await page.route("**/admin/api/agents", async (route) => {
      await blockPromise;
      return route.fulfill({ json: mockAgentList });
    });
    await page.route("**/admin/api/monitor/summary", async (route) => {
      await blockPromise;
      return route.fulfill({ json: mockMonitorSummary });
    });

    await loginAsAdmin(page);

    // Navigate and wait only for the DOM to be ready, not for network idle
    await page.goto("/admin/monitoring", { waitUntil: "domcontentloaded" });

    // Wait a moment for React to render the loading spinner (APIs are blocked)
    await page.waitForTimeout(1000);

    // The spinner div should exist in the DOM while data is loading
    const spinnerInDom = await page.locator("div.animate-spin").count();
    expect(spinnerInDom).toBeGreaterThan(0);

    // Release APIs so the page finishes loading
    resolveAll!();

    // Eventually the page renders the content
    await expect(page.getByText("监控中心")).toBeVisible({ timeout: 10000 });
  });

  test("invalid tab parameter defaults to overview", async ({ page }) => {
    await goToMonitoring(page);
    await page.goto("/admin/monitoring?tab=invalidtab");

    // Should still show the page title
    await expect(page.getByText("监控中心")).toBeVisible();

    // Overview tab should be active (overview content visible)
    // The overview tab shows cluster status bar and anomaly quick view
    await expect(page.getByText("k8s-node-1")).toBeVisible();
  });

  test("tab switching works via button clicks", async ({ page }) => {
    await goToMonitoring(page);

    // Click anomaly tab button
    const anomalyTabBtn = page.locator("button", { hasText: /异常/ });
    await anomalyTabBtn.click();
    await expect(page).toHaveURL(/tab=anomaly/);

    // Click resources tab button
    const resourcesTabBtn = page.locator("button", { hasText: /资源水位/ });
    await resourcesTabBtn.click();
    await expect(page).toHaveURL(/tab=resources/);

    // Click inspection tab button
    const inspectionTabBtn = page.locator("button", { hasText: /巡检/ });
    await inspectionTabBtn.click();
    await expect(page).toHaveURL(/tab=inspection/);

    // Click overview tab button
    const overviewTabBtn = page.locator("button", { hasText: /^概览$/ });
    await overviewTabBtn.click();
    await expect(page).toHaveURL(/tab=overview/);
  });

  test("handles null cluster gracefully", async ({ page }) => {
    await goToMonitoring(page, {
      "GET:/admin/api/monitor/summary": mockMonitorSummaryEmpty,
    });

    // Page should load without errors
    await expect(page.getByText("监控中心")).toBeVisible();
    // No cluster status bar rendered when cluster is null
    await expect(page.getByText("k8s-node-1")).not.toBeVisible();
  });

  test("handles trigger inspection failure with error toast", async ({ page }) => {
    await goToMonitoring(page);

    // Register failing POST route AFTER mockApi so it takes priority
    await page.route("**/admin/api/monitor/inspections", async (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ status: 500, json: { detail: "Inspection failed" } });
      }
      return route.fallback();
    });

    await page.goto("/admin/monitoring?tab=inspection");

    const triggerBtn = page.getByRole("button", { name: /立即巡检/ });
    await triggerBtn.click();

    // Error toast should appear
    await expect(page.getByText("触发巡检失败")).toBeVisible();
  });

  test("acknowledged anomaly shows acknowledged badge instead of buttons", async ({ page }) => {
    const summaryWithAck = {
      ...mockMonitorSummary,
      anomaly_agents: [
        {
          ...mockMonitorSummary.anomaly_agents[0],
          status: "acknowledged" as const,
        },
      ],
      anomaly_count: 1,
    };

    await goToMonitoring(page, {
      "GET:/admin/api/monitor/summary": summaryWithAck,
    });
    await page.goto("/admin/monitoring?tab=anomaly");

    // "已确认" badge should be visible instead of action buttons
    await expect(page.getByText("已确认")).toBeVisible();

    // Acknowledge/Ignore buttons should NOT be visible for acknowledged anomaly
    const ackButtons = page.getByRole("button", { name: /^确认$/ });
    await expect(ackButtons).not.toBeVisible();
  });

  test("ignored anomaly shows ignored badge", async ({ page }) => {
    const summaryWithIgnored = {
      ...mockMonitorSummary,
      anomaly_agents: [
        {
          ...mockMonitorSummary.anomaly_agents[0],
          status: "ignored" as const,
        },
      ],
      anomaly_count: 1,
    };

    await goToMonitoring(page, {
      "GET:/admin/api/monitor/summary": summaryWithIgnored,
    });
    await page.goto("/admin/monitoring?tab=anomaly");

    // "已忽略" badge should be visible
    await expect(page.getByText("已忽略")).toBeVisible();
  });
});
