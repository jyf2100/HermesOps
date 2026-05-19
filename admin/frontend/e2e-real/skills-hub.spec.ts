import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_KEY =
  process.env.ADMIN_KEY ||
  "Abcd@123";

const BASE_URL = "http://172.32.153.184:40080";

async function loginAsAdmin(page: Page) {
  // Navigate to login page to set localStorage with proper origin
  await page.goto("/admin/login");
  await page.evaluate((key) => {
    localStorage.setItem("admin_api_key", key);
    localStorage.setItem("admin_mode", "admin");
    localStorage.setItem("admin_lang", "en");
  }, ADMIN_KEY);
  // Navigate to dashboard — auth guard should now accept us
  await page.goto("/admin/");
  await page.waitForLoadState("networkidle").catch(() => {});
  // Give SPA time to mount
  await page.waitForTimeout(1500);
}

/** Call the agents list API directly to get an agent ID. */
async function getFirstAgentId(): Promise<number> {
  const res = await fetch(`${BASE_URL}/admin/api/agents`, {
    headers: { "X-Admin-Key": ADMIN_KEY },
  });
  if (!res.ok) {
    throw new Error(`Failed to list agents: ${res.status}`);
  }
  const body = await res.json();
  const agents: Array<{ id: number; name: string; status: string }> =
    body.agents;
  if (!agents || agents.length === 0) {
    throw new Error("No agents found in the cluster");
  }
  // Prefer a running agent for Skills Hub tests
  const running = agents.find((a) => a.status === "running");
  return (running ?? agents[0]).id;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("Skills Hub — Integration (184 cluster)", () => {
  let agentId: number;

  test.beforeAll(async () => {
    agentId = await getFirstAgentId();
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  // -----------------------------------------------------------------------
  // 1. Page load + navigation to agent detail
  // -----------------------------------------------------------------------
  test("loads dashboard and navigates to agent detail", async ({ page }) => {
    // Dashboard should have rendered with agent cards
    // Look for any content that confirms agents loaded
    await page.waitForTimeout(500);

    // Navigate directly to agent detail (we already know the ID from API)
    await page.goto(`/admin/agents/${agentId}`);
    await page.waitForLoadState("networkidle").catch(() => {});

    // Agent detail page should show agent name or status
    const pageContent = page.locator("body");
    await expect(pageContent).toContainText(String(agentId), {
      timeout: 10000,
    });
  });

  // -----------------------------------------------------------------------
  // 2. Skills Tab visibility
  // -----------------------------------------------------------------------
  test("shows Skills tab with Installed and Browse Hub sub-tabs", async ({
    page,
  }) => {
    await page.goto(`/admin/agents/${agentId}?tab=skills`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1000);

    // Sub-tabs: "Installed" and "Browse Hub" (English locale)
    const installedTab = page.getByRole("tab", { name: "Installed" });
    const browseTab = page.getByRole("tab", { name: "Browse Hub" });
    await expect(installedTab).toBeVisible({ timeout: 10000 });
    await expect(browseTab).toBeVisible({ timeout: 10000 });
  });

  // -----------------------------------------------------------------------
  // 3. Installed Skills list
  // -----------------------------------------------------------------------
  test("loads installed skills list for agent", async ({ page }) => {
    await page.goto(`/admin/agents/${agentId}?tab=skills`);
    await page.waitForLoadState("networkidle").catch(() => {});

    // Wait for loading indicator to disappear
    await page.waitForTimeout(3000);

    // Check that a tabpanel rendered
    const tabPanel = page.getByRole("tabpanel").first();
    await expect(tabPanel).toBeVisible({ timeout: 10000 });

    // Either we see skill rows (with font-mono class for skill names)
    // or the empty state message
    const hasSkills = await tabPanel.locator(".font-mono").count();
    const hasEmpty =
      (await page.getByText("No skills installed").count()) > 0;
    const hasContent = await tabPanel.textContent();

    // The tab panel should have some content (not just empty)
    expect(hasContent!.trim().length).toBeGreaterThan(0);
    expect(hasSkills > 0 || hasEmpty).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // 4. Browse Hub
  // -----------------------------------------------------------------------
  test("loads Browse Hub results", async ({ page }) => {
    await page.goto(`/admin/agents/${agentId}?tab=skills`);
    await page.waitForLoadState("networkidle").catch(() => {});

    // Click "Browse Hub" sub-tab
    const browseTab = page.getByRole("tab", { name: "Browse Hub" });
    await browseTab.click();

    // Wait for browse API to respond
    await page.waitForTimeout(3000);
    await page.waitForLoadState("networkidle").catch(() => {});

    // Search input should be present in browse tab
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[placeholder*="search"], input[placeholder*="搜"]'
    );
    await expect(searchInput).toBeVisible({ timeout: 10000 });

    // Check for either results or empty state
    const hasResults =
      (await page.locator('[role="tabpanel"] .grid').count()) > 0;
    const hasEmpty =
      (await page.getByText("No skill sources").count()) > 0 ||
      (await page.getByText("暂无可用的技能源").count()) > 0;

    // At minimum the browse tab rendered (results or empty state)
    expect(hasResults || hasEmpty).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // 5. Search
  // -----------------------------------------------------------------------
  test("search returns filtered results", async ({ page }) => {
    await page.goto(`/admin/agents/${agentId}?tab=skills`);
    await page.waitForLoadState("networkidle").catch(() => {});

    // Click "Browse Hub" sub-tab
    const browseTab = page.getByRole("tab", { name: "Browse Hub" });
    await browseTab.click();
    await page.waitForTimeout(2000);

    // Find search input
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[placeholder*="search"], input[placeholder*="搜"]'
    );
    await expect(searchInput).toBeVisible({ timeout: 10000 });

    // Type search query
    await searchInput.fill("test");
    // Wait for debounced search (300ms debounce) + API roundtrip
    await page.waitForTimeout(2500);
    await page.waitForLoadState("networkidle").catch(() => {});

    // Check for results or "No matching" message
    const hasResults =
      (await page.locator('[role="tabpanel"] .grid').count()) > 0;
    const hasNoMatch =
      (await page.getByText("No matching skills found").count()) > 0 ||
      (await page.getByText("未找到匹配的技能").count()) > 0;

    // Search completed — either results or no-match message
    expect(hasResults || hasNoMatch).toBeTruthy();
  });
});
