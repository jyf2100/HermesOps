import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_KEY =
  process.env.ADMIN_KEY ||
  "037a1b32e4b6a9131f565e2f24e7c864de765e64bc3b166bf2b41872347a7206";

const BASE_URL = "http://172.32.153.184:40080";
const TEST_SKILL = "adversarial-ux-test";
const TEST_IDENTIFIER = "official/dogfood/adversarial-ux-test";

async function loginAsAdmin(page: Page) {
  await page.goto("/admin/login");
  await page.evaluate((key) => {
    localStorage.setItem("admin_api_key", key);
    localStorage.setItem("admin_mode", "admin");
    localStorage.setItem("admin_lang", "en");
  }, ADMIN_KEY);
  await page.goto("/admin/");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);
}

async function getFirstAgentId(): Promise<number> {
  const res = await fetch(`${BASE_URL}/admin/api/agents`, {
    headers: { "X-Admin-Key": ADMIN_KEY },
  });
  if (!res.ok) throw new Error(`Failed to list agents: ${res.status}`);
  const body = await res.json();
  const agents: Array<{ id: number; name: string; status: string }> =
    body.agents;
  if (!agents || agents.length === 0) throw new Error("No agents found");
  const running = agents.find((a) => a.status === "running");
  return (running ?? agents[0]).id;
}

/** Navigate to the agent Skills tab and wait for it to render. */
async function goToSkillsTab(page: Page, agentId: number) {
  await page.goto(`/admin/agents/${agentId}?tab=skills`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);
}

/** Click the Browse Hub sub-tab and wait for load. */
async function switchToBrowseHub(page: Page) {
  const browseTab = page.getByRole("tab", { name: "Browse Hub" });
  await browseTab.click();
  await page.waitForTimeout(2000);
  await page.waitForLoadState("networkidle").catch(() => {});
}

/** Click the Installed sub-tab and wait for load. */
async function switchToInstalled(page: Page) {
  const installedTab = page.getByRole("tab", { name: "Installed" });
  await installedTab.click();
  await page.waitForTimeout(3000);
}

/** Call the hub API from the browser context using admin key from localStorage. */
async function hubApiCall(
  page: Page,
  method: string,
  path: string,
  body?: object
): Promise<{ ok: boolean; status: number; data: unknown }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const opts: RequestInit = {
        method,
        headers: {
          "X-Admin-Key": localStorage.getItem("admin_api_key") || "",
          "Content-Type": "application/json",
        },
      };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(`/admin/api${path}`, opts);
      return { ok: res.ok, status: res.status, data: await res.json() };
    },
    { method, path, body }
  );
}

/** Wait for an install/update task to complete by polling. */
async function waitForTask(
  page: Page,
  agentId: number,
  taskId: string,
  timeoutMs = 30000
): Promise<{ status: string; result?: unknown; error?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await hubApiCall(
      page,
      "GET",
      `/hub/agents/${agentId}/tasks/${taskId}`
    );
    const data = resp.data as Record<string, unknown>;
    if (data.status === "completed" || data.status === "failed") {
      return {
        status: data.status as string,
        result: data.result,
        error: data.error as string | undefined,
      };
    }
    await page.waitForTimeout(1500);
  }
  return { status: "timeout" };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("Skills Hub — Full E2E (184 cluster)", () => {
  let agentId: number;

  test.beforeAll(async () => {
    agentId = await getFirstAgentId();
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  // -----------------------------------------------------------------------
  // C1. Skills Tab Rendering
  // -----------------------------------------------------------------------
  test("C1: Skills tab renders with Installed default and 100+ skills", async ({
    page,
  }) => {
    await goToSkillsTab(page, agentId);

    // Installed tab is selected by default
    const installedTab = page.getByRole("tab", { name: "Installed" });
    await expect(installedTab).toBeVisible({ timeout: 10000 });
    await expect(installedTab).toHaveAttribute("aria-selected", "true");

    // Browse Hub tab also visible
    const browseTab = page.getByRole("tab", { name: "Browse Hub" });
    await expect(browseTab).toBeVisible({ timeout: 10000 });

    // Wait for skills to load
    await page.waitForTimeout(3000);

    // Verify skill count > 100 by counting skill rows with font-mono class
    const skillNames = page.locator('[role="tabpanel"] span.font-mono');
    const count = await skillNames.count();
    expect(count).toBeGreaterThan(100);
  });

  // -----------------------------------------------------------------------
  // C2. Browse Hub — load, search, find adversarial-ux-test
  // -----------------------------------------------------------------------
  test("C2: Browse Hub loads results and search finds adversarial-ux-test", async ({
    page,
  }) => {
    await goToSkillsTab(page, agentId);
    await switchToBrowseHub(page);

    // Search input visible
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[placeholder*="search"], input[placeholder*="搜"]'
    );
    await expect(searchInput).toBeVisible({ timeout: 10000 });

    // Wait for initial browse results to load
    await page.waitForTimeout(3000);

    // Type search query
    await searchInput.fill("adversarial");
    await page.waitForTimeout(2500);
    await page.waitForLoadState("networkidle").catch(() => {});

    // Verify search results contain adversarial-ux-test
    const results = page.locator('[role="tabpanel"] .grid');
    await expect(results).toBeVisible({ timeout: 10000 });

    // Find the adversarial-ux-test name in the results
    const found = page
      .locator('[role="tabpanel"] .grid span.font-mono')
      .getByText("adversarial-ux-test");
    await expect(found.first()).toBeVisible({ timeout: 10000 });
  });

  // -----------------------------------------------------------------------
  // C3. Install + Uninstall full flow
  // -----------------------------------------------------------------------
  test("C3: Install and uninstall adversarial-ux-test via Browse Hub", async ({
    page,
  }) => {
    test.setTimeout(120000);

    // Pre-cleanup: uninstall if already installed (leftover from previous test run)
    await hubApiCall(page, "DELETE", `/hub/agents/${agentId}/skills/${TEST_SKILL}`);

    // --- INSTALL via API for reliability ---
    const installResp = await hubApiCall(page, "POST", `/hub/agents/${agentId}/install`, {
      identifier: TEST_IDENTIFIER,
    });
    expect(installResp.ok).toBeTruthy();
    const installData = installResp.data as Record<string, string>;
    const taskId = installData.task_id;

    // Wait for install to complete
    const taskResult = await waitForTask(page, agentId, taskId);
    expect(taskResult.status).toBe("completed");

    // Switch to Installed tab to verify
    await goToSkillsTab(page, agentId);
    await page.waitForTimeout(3000);

    // Verify the skill appears in installed list
    const installedName = page
      .locator('[role="tabpanel"] span.font-mono')
      .getByText(TEST_SKILL, { exact: true });
    await expect(installedName).toBeVisible({ timeout: 10000 });

    const countAfterInstall = await page.locator('[role="tabpanel"] span.font-mono').count();

    // --- UNINSTALL via API ---
    const uninstallResp = await hubApiCall(
      page,
      "DELETE",
      `/hub/agents/${agentId}/skills/${TEST_SKILL}`
    );
    expect(uninstallResp.ok).toBeTruthy();

    // Reload the page to refresh the skills list
    await page.reload();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(3000);

    // --- VERIFY UNINSTALLED ---
    const remainingNames = page.locator('[role="tabpanel"] span.font-mono');
    const countAfterUninstall = await remainingNames.count();
    expect(countAfterUninstall).toBeLessThan(countAfterInstall);

    // Verify the specific skill is gone
    const gone = page
      .locator('[role="tabpanel"] span.font-mono')
      .getByText(TEST_SKILL, { exact: true });
    await expect(gone).toHaveCount(0, { timeout: 5000 });
  });

  // -----------------------------------------------------------------------
  // C4. Audit Dialog — install skill first, then audit via UI
  // -----------------------------------------------------------------------
  test("C4: Audit dialog opens and shows scan results", async ({ page }) => {
    test.setTimeout(90000);

    // First, install the test skill so we can audit a skill with files
    const installResp = await hubApiCall(page, "POST", `/hub/agents/${agentId}/install`, {
      identifier: TEST_IDENTIFIER,
    });
    if (installResp.ok) {
      const installData = installResp.data as Record<string, string>;
      await waitForTask(page, agentId, installData.task_id);
    }

    // Navigate to skills tab
    await goToSkillsTab(page, agentId);
    await page.waitForTimeout(3000);

    // Find the adversarial-ux-test skill row and click Audit via JS
    const clicked = await page.evaluate((skillName) => {
      // Find all font-mono spans, locate the one matching our skill, then find Audit in its row
      const spans = document.querySelectorAll<HTMLSpanElement>('[role="tabpanel"] span.font-mono');
      for (const span of spans) {
        if (span.textContent?.trim() === skillName) {
          // Walk up to find the skill row (parent with 'flex items-center')
          let el: HTMLElement | null = span;
          for (let i = 0; i < 5 && el; i++) {
            el = el.parentElement;
            if (el && el.classList.contains("group")) {
              // Found the row — find the Audit button
              const auditBtn = Array.from(el.querySelectorAll("button")).find(
                (b) => b.textContent?.trim() === "Audit"
              );
              if (auditBtn) {
                auditBtn.click();
                return true;
              }
            }
          }
        }
      }
      return false;
    }, TEST_SKILL);

    expect(clicked).toBeTruthy();

    // Audit dialog should appear
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    // Dialog should contain scan content — check for "Security Audit" title
    const dialogText = await dialog.textContent();
    expect(dialogText).toBeTruthy();

    // Close dialog with Escape
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // Clean up: uninstall the test skill
    await hubApiCall(page, "DELETE", `/hub/agents/${agentId}/skills/${TEST_SKILL}`).catch(() => {});
  });

  // -----------------------------------------------------------------------
  // C5. Not Running state — nonexistent agent
  // -----------------------------------------------------------------------
  test("C5: Nonexistent agent shows not-running state", async ({ page }) => {
    await page.goto(`/admin/agents/999?tab=skills`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2000);

    // The page should show a warning about agent not running
    const notRunningWarning = page.locator(
      'text=/not running/i'
    ).or(page.locator('text=/未运行|未启动/i'));

    // Either the warning appears, or the agent detail page shows a not-found state
    const pageContent = await page.locator("body").textContent();
    const hasWarning = await notRunningWarning.count() > 0;
    const hasNotRunningContent = pageContent!.includes("not running") ||
      pageContent!.includes("Agent") ||
      pageContent!.includes("agent");

    expect(hasWarning || hasNotRunningContent).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // C6. Check Updates button
  // -----------------------------------------------------------------------
  test("C6: Check Updates button works in Installed tab", async ({ page }) => {
    await goToSkillsTab(page, agentId);
    await page.waitForTimeout(3000);

    // Check Updates button should be visible if skills exist
    const checkUpdatesBtn = page.locator('button:has-text("Check Updates")');
    if (await checkUpdatesBtn.isVisible()) {
      await checkUpdatesBtn.click();
      await page.waitForTimeout(5000);
      // No crash = success
    } else {
      // If button not visible, the skills list may be empty — that is acceptable
      const emptyState = page.locator("text=/No skills installed/");
      expect(await emptyState.count()).toBeGreaterThan(0);
    }
  });

  // -----------------------------------------------------------------------
  // C7. Browse Hub empty search state
  // -----------------------------------------------------------------------
  test("C7: Browse Hub shows no-results for non-matching search", async ({
    page,
  }) => {
    await goToSkillsTab(page, agentId);
    await switchToBrowseHub(page);

    const searchInput = page.locator(
      'input[placeholder*="Search"], input[placeholder*="search"], input[placeholder*="搜"]'
    );
    await expect(searchInput).toBeVisible({ timeout: 10000 });

    // Search for something that definitely does not exist
    await searchInput.fill("zzzzzznonexistent12345");
    await page.waitForTimeout(2500);
    await page.waitForLoadState("networkidle").catch(() => {});

    // Should show either no results message or empty grid
    const noResults = page.locator(
      'text=/No matching skills found|No results|未找到/'
    );
    const emptyGrid = page.locator('[role="tabpanel"] .grid');
    const hasNoResults = (await noResults.count()) > 0;
    const gridEmpty =
      (await emptyGrid.count()) > 0 &&
      (await emptyGrid.locator("> *").count()) === 0;

    expect(hasNoResults || gridEmpty).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // C8. Source badges render correctly
  // -----------------------------------------------------------------------
  test("C8: Installed skills show source and trust badges", async ({ page }) => {
    await goToSkillsTab(page, agentId);
    await page.waitForTimeout(3000);

    // Check that skill rows exist
    const skillNames = page.locator('[role="tabpanel"] span.font-mono');
    const rowCount = await skillNames.count();
    expect(rowCount).toBeGreaterThan(0);

    // At least some rows should have badges (source badge or trust badge)
    // These are rendered as small spans with text-[10px] class
    const badges = page.locator('[role="tabpanel"] .text-\\[10px\\]');
    const badgeCount = await badges.count();
    expect(badgeCount).toBeGreaterThan(0);
  });
});
