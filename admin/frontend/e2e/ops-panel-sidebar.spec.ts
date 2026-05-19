import { test, expect } from "@playwright/test";
import {
  mockAgentList,
  mockClusterStatus,
  mockAgentDetail,
} from "./fixtures/mock-data";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Locator for the desktop sidebar (first <aside> with Sidebar navigation).
 * We scope to the desktop aside because both desktop and mobile drawers render
 * a <nav aria-label="Main navigation">, which causes strict-mode violations.
 */
function desktopSidebar(page: import("@playwright/test").Page) {
  return page.locator("aside[aria-label='Sidebar navigation']");
}

/**
 * Log in as user mode with a bound agent ID.
 * Sets the required localStorage keys for user-mode authentication.
 */
async function loginAsUser(
  page: import("@playwright/test").Page,
  agentId: string = "3"
) {
  await page.goto("/admin/login");
  await page.evaluate((id) => {
    localStorage.setItem("admin_mode", "user");
    localStorage.setItem("admin_user_token", "mock-user-token");
    localStorage.setItem("admin_user_agent_id", id);
    localStorage.setItem("admin_user_display_name", "Test User");
  }, agentId);
}

/**
 * Log in as user mode with English locale.
 */
async function loginAsUserEn(
  page: import("@playwright/test").Page,
  agentId: string = "3"
) {
  await page.goto("/admin/login");
  await page.evaluate((id) => {
    localStorage.setItem("admin_mode", "user");
    localStorage.setItem("admin_user_token", "mock-user-token");
    localStorage.setItem("admin_user_agent_id", id);
    localStorage.setItem("admin_user_display_name", "Test User");
    localStorage.setItem("admin_lang", "en");
  }, agentId);
}

/**
 * Log in as admin mode (standard admin key auth).
 */
async function loginAsAdmin(page: import("@playwright/test").Page) {
  await page.goto("/admin/login");
  await page.evaluate(() => {
    localStorage.setItem("admin_api_key", "test-admin-key-1234");
    // Ensure no user-mode keys leak from prior tests
    localStorage.removeItem("admin_mode");
    localStorage.removeItem("admin_user_token");
    localStorage.removeItem("admin_user_agent_id");
    localStorage.removeItem("admin_email_token");
  });
}

/**
 * Mock the common dashboard API routes and navigate to the dashboard.
 */
async function goToDashboard(page: import("@playwright/test").Page) {
  await page.route("**/admin/api/agents", (route) =>
    route.fulfill({ json: mockAgentList })
  );
  await page.route("**/admin/api/cluster/status", (route) =>
    route.fulfill({ json: mockClusterStatus })
  );
  await page.route("**/admin/api/agents/3", (route) =>
    route.fulfill({ json: { ...mockAgentDetail, id: 3, url_path: "/agent3", webui_url: "http://agent3.172-32-153-184.nip.io:40080" } })
  );
  await page.route("**/admin/api/agents/1", (route) =>
    route.fulfill({ json: { ...mockAgentDetail, id: 1, url_path: "/agent1", webui_url: "http://agent1.172-32-153-184.nip.io:40080" } })
  );
  await page.route("**/admin/api/user/me", (route) =>
    route.fulfill({
      json: {
        user_id: 1,
        email: "test@example.com",
        display_name: "Test User",
        role: "user",
        agent_id: 3,
      },
    })
  );
  await page.goto("/admin/");
}

// ---------------------------------------------------------------------------
// Ops Panel Sidebar — User mode with bound agent
// ---------------------------------------------------------------------------

test.describe("Ops Panel Sidebar — user with bound agent", () => {
  test("shows Agent Console link in sidebar (English)", async ({ page }) => {
    await loginAsUserEn(page, "3");
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    await expect(sidebar.getByText("Agent Console")).toBeVisible();
  });

  test("shows Agent Console link in sidebar (Chinese)", async ({ page }) => {
    await loginAsUser(page, "3");
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    await expect(sidebar.getByText("Agent 控制台")).toBeVisible();
  });

  test("Agent Console link href contains nip.io domain", async ({ page }) => {
    await loginAsUserEn(page, "3");
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    const opsLink = sidebar.locator("a[target='_blank']");
    const href = await opsLink.getAttribute("href");
    expect(href).toContain("agent3.172-32-153-184.nip.io:40080");
  });

  test("Agent Console link opens in new tab", async ({ page }) => {
    await loginAsUserEn(page, "3");
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    const opsLink = sidebar.locator("a[target='_blank']");
    await expect(opsLink).toBeVisible();

    // Verify target attribute
    const target = await opsLink.getAttribute("target");
    expect(target).toBe("_blank");

    // Verify rel attribute for security
    const rel = await opsLink.getAttribute("rel");
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  test("Agent Console link includes external-link icon", async ({ page }) => {
    await loginAsUserEn(page, "3");
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    const opsLink = sidebar.locator("a[target='_blank']");
    // The external-link icon is the second <svg> inside the <a>
    const iconSvg = opsLink.locator("svg").last();
    await expect(iconSvg).toBeVisible();
  });

  test("uses different agent ID when bound to another agent", async ({ page }) => {
    await loginAsUserEn(page, "1");
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    const opsLink = sidebar.locator("a[target='_blank']");
    const href = await opsLink.getAttribute("href");
    expect(href).toContain("agent1.172-32-153-184.nip.io:40080");
    expect(href).not.toContain("agent3.");
  });
});

// ---------------------------------------------------------------------------
// Ops Panel Sidebar — user without bound agent
// ---------------------------------------------------------------------------

test.describe("Ops Panel Sidebar — user without bound agent", () => {
  test("hides Agent Console when agent ID is 0", async ({ page }) => {
    await loginAsUserEn(page, "0");
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    await expect(sidebar.getByText(/Agent Console|Agent 控制台/)).toHaveCount(0);
    // No external links in the nav area
    await expect(sidebar.locator("a[target='_blank']")).toHaveCount(0);
  });

  test("hides Agent Console when agent ID is not set", async ({ page }) => {
    await page.goto("/admin/login");
    await page.evaluate(() => {
      localStorage.setItem("admin_mode", "user");
      localStorage.setItem("admin_user_token", "mock-user-token");
      // Deliberately omit admin_user_agent_id
      localStorage.removeItem("admin_user_agent_id");
      localStorage.setItem("admin_user_display_name", "Test User");
      localStorage.setItem("admin_lang", "en");
    });
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    await expect(sidebar.getByText(/Agent Console|Agent 控制台/)).toHaveCount(0);
  });

  test("hides Agent Console when agent ID is empty string", async ({ page }) => {
    await page.goto("/admin/login");
    await page.evaluate(() => {
      localStorage.setItem("admin_mode", "user");
      localStorage.setItem("admin_user_token", "mock-user-token");
      localStorage.setItem("admin_user_agent_id", "");
      localStorage.setItem("admin_user_display_name", "Test User");
      localStorage.setItem("admin_lang", "en");
    });
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    await expect(sidebar.getByText(/Agent Console|Agent 控制台/)).toHaveCount(0);
  });

  test("hides Agent Console when agent ID is negative", async ({ page }) => {
    await loginAsUserEn(page, "-1");
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    await expect(sidebar.getByText(/Agent Console|Agent 控制台/)).toHaveCount(0);
  });

  test("still shows other user nav items (Dashboard, Files, Chat)", async ({ page }) => {
    await loginAsUserEn(page, "0");
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    // English locale: nav labels are "Dashboard", "Files", "Chat"
    await expect(sidebar.getByText("Dashboard")).toBeVisible();
    await expect(sidebar.getByText("Files")).toBeVisible();
    await expect(sidebar.getByText("Chat")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Ops Panel Sidebar — navigation order
// ---------------------------------------------------------------------------

test.describe("Ops Panel Sidebar — navigation order", () => {
  test("Agent Console appears after Chat in sidebar order", async ({ page }) => {
    await loginAsUserEn(page, "3");
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    // Wait for async webuiUrl to load and Agent Console to appear
    await expect(sidebar.getByText("Agent Console")).toBeVisible();

    const nav = sidebar.locator("nav[aria-label='Main navigation']");
    // All nav items are rendered as <a> tags (internal <Link> or external <a>)
    const navLinks = nav.locator("a");

    const texts: string[] = [];
    const count = await navLinks.count();
    for (let i = 0; i < count; i++) {
      const text = await navLinks.nth(i).textContent();
      if (text) texts.push(text.trim());
    }

    // Find indices of each nav item
    const dashboardIdx = texts.findIndex((t) => /Dashboard/.test(t));
    const filesIdx = texts.findIndex((t) => /Files/.test(t));
    const chatIdx = texts.findIndex((t) => /Chat/.test(t));
    const consoleIdx = texts.findIndex((t) => /Agent Console/.test(t));

    // All should be found
    expect(dashboardIdx).toBeGreaterThanOrEqual(0);
    expect(filesIdx).toBeGreaterThanOrEqual(0);
    expect(chatIdx).toBeGreaterThanOrEqual(0);
    expect(consoleIdx).toBeGreaterThanOrEqual(0);

    // Order: Dashboard < Files < Chat < Agent Console
    expect(dashboardIdx).toBeLessThan(filesIdx);
    expect(filesIdx).toBeLessThan(chatIdx);
    expect(chatIdx).toBeLessThan(consoleIdx);
  });
});

// ---------------------------------------------------------------------------
// Ops Panel Sidebar — admin mode
// ---------------------------------------------------------------------------

test.describe("Ops Panel Sidebar — admin mode", () => {
  test("does not show Agent Console link for admin user", async ({ page }) => {
    await loginAsAdmin(page);
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    await expect(sidebar.getByText(/Agent Console|Agent 控制台/)).toHaveCount(0);
  });

  test("admin sidebar shows expected admin nav items", async ({ page }) => {
    await loginAsAdmin(page);
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);
    // Default locale is zh; admin nav includes 仪表盘 and 设置
    await expect(sidebar.getByText(/仪表盘|Dashboard/)).toBeVisible();
    await expect(sidebar.getByText(/设置|Settings/)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Ops Panel Sidebar — i18n verification
// ---------------------------------------------------------------------------

test.describe("Ops Panel Sidebar — i18n", () => {
  test("switching language updates Agent Console label", async ({ page }) => {
    await loginAsUserEn(page, "3");
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);

    // Initially English
    await expect(sidebar.getByText("Agent Console")).toBeVisible();

    // Switch language to Chinese via the toggle button (shows "中文" when English is active)
    const langToggle = sidebar.locator("button", { hasText: "中文" });
    await langToggle.click();

    // Should now show Chinese label
    await expect(sidebar.getByText("Agent 控制台")).toBeVisible();
    await expect(sidebar.getByText("Agent Console")).toHaveCount(0);
  });

  test("switching from Chinese to English shows Agent Console", async ({ page }) => {
    await loginAsUser(page, "3");
    await goToDashboard(page);

    const sidebar = desktopSidebar(page);

    // Initially Chinese
    await expect(sidebar.getByText("Agent 控制台")).toBeVisible();

    // Switch language to English via the toggle button (shows "English" when Chinese is active)
    const langToggle = sidebar.locator("button", { hasText: "English" });
    await langToggle.click();

    // Should now show English label
    await expect(sidebar.getByText("Agent Console")).toBeVisible();
    await expect(sidebar.getByText("Agent 控制台")).toHaveCount(0);
  });
});
