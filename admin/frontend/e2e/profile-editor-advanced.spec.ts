import { test, expect } from "@playwright/test";
import { loginAsAdminEn } from "./helpers";
import {
  VALID_ADMIN_KEY,
  mockAgentDetail,
  mockEnvVars,
  mockConfigYaml,
  mockSoul,
  mockHealth,
  mockEvents,
  mockWeixinStatusConnected,
  mockProfileTemplates,
  mockProfileList,
  mockCreatedProfile,
  mockSyncResult,
  mockResolvedConfig,
} from "./fixtures/mock-data";

/**
 * Register all base page.route() mocks required for AgentDetailPage to render.
 */
async function mockBaseRoutes(page, overrides?: { profiles?: unknown }) {
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
  await page.route("**/admin/api/agents/1/weixin/status", (route) =>
    route.fulfill({ json: mockWeixinStatusConnected })
  );
  await page.route("**/admin/api/agents/1/profiles", (route) =>
    route.fulfill({ json: overrides?.profiles ?? mockProfileList })
  );
  await page.route("**/admin/api/profile-templates", (route) =>
    route.fulfill({ json: mockProfileTemplates })
  );
}

// Navigate to agent detail profiles tab with all required mocks
async function goToProfiles(page, profiles = mockProfileList) {
  await mockBaseRoutes(page, { profiles });
  await page.goto("/admin/agents/1?tab=profiles");
  await page.waitForSelector('text="Profiles"');
}

/**
 * Open the editor for an existing profile (edit mode).
 * Clicks "Edit" on the first profile row.
 */
async function openEditEditor(page) {
  await goToProfiles(page);
  await page.locator('button:has-text("Edit")').first().click();
  await expect(page.locator('[role="dialog"]')).toBeVisible();
}

/**
 * Open the editor for creating a new profile (create mode).
 */
async function openCreateEditor(page) {
  await goToProfiles(page);
  await page.click('button:has-text("Create Profile")');
  await expect(page.locator('[role="dialog"]')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

test.describe("SOUL.md Preview", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("toggles between edit and preview mode for SOUL.md", async ({
    page,
  }) => {
    await openCreateEditor(page);

    // The dialog has two textareas: first is config overrides, second is SOUL.md
    const textareas = page.locator("textarea");

    // Fill SOUL.md textarea (second one)
    await textareas.nth(1).fill("# My Soul");

    // Preview button should appear (soulMd is now non-empty)
    await expect(page.locator('button:has-text("Preview")')).toBeVisible();

    // Click Preview to switch to preview mode
    await page.locator('button:has-text("Preview")').click();

    // Verify pre element appears with soul content
    await expect(
      page.locator("pre").filter({ hasText: "My Soul" })
    ).toBeVisible();

    // Verify textarea is no longer visible (we're in preview mode)
    // The SOUL.md textarea should be replaced by the pre element
    await expect(textareas.nth(1)).not.toBeVisible();

    // Click "Edit Profile" button to switch back to edit mode
    // In preview mode, the toggle button shows t.profileEdit ("Edit Profile")
    await page.locator('button:has-text("Edit Profile")').click();

    // Verify textarea is back
    await expect(textareas.nth(1)).toBeVisible();
    await expect(textareas.nth(1)).toHaveValue("# My Soul");
  });

  test("hides preview button when soul is empty", async ({ page }) => {
    await openCreateEditor(page);

    // SOUL.md textarea is empty by default, so no Preview button
    await expect(
      page.locator('button:has-text("Preview")')
    ).not.toBeVisible();
  });
});

test.describe("Template Description", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("shows template description when a template is selected", async ({
    page,
  }) => {
    await openCreateEditor(page);

    // Select the "Researcher" template (id=1)
    await page.locator('[role="dialog"] select').selectOption("1");

    // Description from mockProfileTemplates: "Deep research and analysis template"
    await expect(
      page.locator("text=Deep research and analysis template")
    ).toBeVisible();
  });
});

test.describe("Editor Sync", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("syncs profile from within editor", async ({ page }) => {
    let syncRequested = false;

    await goToProfiles(page);

    // Mock sync endpoint for profile "default"
    await page.route(
      "**/admin/api/agents/1/profiles/**/sync",
      async (route) => {
        if (route.request().method() === "POST") {
          syncRequested = true;
          return route.fulfill({ json: mockSyncResult });
        }
        return route.fallback();
      }
    );

    // Open edit on the first profile ("default")
    await page.locator('button:has-text("Edit")').first().click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // "Sync to Pod" button should be visible in edit mode footer
    await expect(
      page
        .locator('[role="dialog"]')
        .locator('button:has-text("Sync to Pod")')
    ).toBeVisible();

    // Click Sync to Pod
    await page
      .locator('[role="dialog"]')
      .locator('button:has-text("Sync to Pod")')
      .click();

    // Verify POST sync was sent
    await expect(() => expect(syncRequested).toBe(true)).toPass();
  });
});

test.describe("Save Error", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("shows error when save fails", async ({ page }) => {
    await goToProfiles(page);

    // Override the profiles route to return 500 on POST (create)
    await page.route(
      "**/admin/api/agents/1/profiles",
      async (route) => {
        if (route.request().method() === "POST") {
          return route.fulfill({
            status: 500,
            json: { detail: "Server error" },
          });
        }
        return route.fulfill({ json: mockProfileList });
      }
    );

    // Open create editor
    await page.click('button:has-text("Create Profile")');
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Fill required fields
    await page.fill('input[placeholder="e.g. researcher"]', "fail-profile");
    await page.click('button:has-text("Save")');

    // Verify pink error box appears with the error message
    // adminFetch extracts body.detail for non-2xx responses
    await expect(
      page
        .locator('[role="dialog"]')
        .locator("div.bg-accent-pink\\/10")
    ).toBeVisible();
    await expect(
      page.locator('[role="dialog"]').locator("text=Server error")
    ).toBeVisible();
  });
});

test.describe("Editor Close", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("closes via X button in header", async ({ page }) => {
    await openCreateEditor(page);

    // The X button exists in the dialog header but is outside the viewport
    // in headless Chromium due to modal max-h-[85vh]. Use dispatchEvent to
    // trigger the React onClick handler directly, bypassing hit-testing.
    const closeButton = page.locator(
      '[role="dialog"] button[aria-label="Close"]'
    );
    await closeButton.dispatchEvent("click");

    // Dialog should be gone
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });

  test("hides profile name input in edit mode", async ({ page }) => {
    await openEditEditor(page);

    // In edit mode, profile name input should NOT be present
    await expect(
      page.locator('input[placeholder="e.g. researcher"]')
    ).not.toBeVisible();

    // Display name input should still be present
    await expect(
      page.locator(
        'input[placeholder="Optional name for easy identification"]'
      )
    ).toBeVisible();
  });
});

test.describe("Resolved Config", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("toggles resolved config section open and closed", async ({ page }) => {
    await goToProfiles(page);

    // Mock resolved config endpoint
    await page.route(
      "**/admin/api/agents/1/profiles/**/resolved-config",
      async (route) => {
        return route.fulfill({ json: mockResolvedConfig });
      }
    );

    // Open edit on the first profile
    await page.locator('button:has-text("Edit")').first().click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Click "Resolved Config Preview" to expand
    await page.click('text="Resolved Config Preview"');

    // Pre element should appear with resolved config content
    const resolvedPre = page
      .locator('[role="dialog"]')
      .locator("pre")
      .last();
    await expect(resolvedPre).toBeVisible();
    await expect(resolvedPre).toContainText("Resolved Config");

    // Click again to collapse
    await page.click('text="Resolved Config Preview"');

    // The resolved config pre should no longer be visible
    await expect(resolvedPre).not.toBeVisible();
  });
});

test.describe("List Error + Retry", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("shows error state when profiles fail to load", async ({ page }) => {
    // Set up all base routes except profiles — override it with 500
    await mockBaseRoutes(page);
    // Remove the default profiles route and add one that returns 500
    await page.route("**/admin/api/agents/1/profiles", (route) =>
      route.fulfill({ status: 500, body: "Internal Server Error" })
    );

    await page.goto("/admin/agents/1?tab=profiles");

    // adminFetch throws with "Request failed (500)" when detail can't be parsed
    // ProfileList shows error text in text-accent-pink
    await expect(
      page.locator(".text-accent-pink").filter({ hasText: "Request failed" })
    ).toBeVisible();

    // Retry button should be visible
    await expect(page.locator('button:has-text("Retry")')).toBeVisible();
  });

  test("retries loading on retry button click", async ({ page }) => {
    let failCount = 0;
    let requestCount = 0;

    await mockBaseRoutes(page);
    // Route that fails for the first N calls (handles React StrictMode double-mount),
    // then succeeds. We track total requests to verify retry re-fetches.
    await page.route(
      "**/admin/api/agents/1/profiles",
      async (route) => {
        requestCount++;
        failCount++;
        // React StrictMode fires useEffect twice in dev, so the component
        // mounts, unmounts, and remounts. Both mount cycles call loadProfiles.
        // Fail all initial requests, then succeed after retry click.
        if (failCount <= 2) {
          return route.fulfill({
            status: 500,
            body: "Internal Server Error",
          });
        }
        return route.fulfill({ json: mockProfileList });
      }
    );

    await page.goto("/admin/agents/1?tab=profiles");

    // Wait for error state to appear (either from first or second mount attempt)
    await expect(
      page.locator('button:has-text("Retry")')
    ).toBeVisible({ timeout: 10000 });

    // Verify we're in error state — profiles are not showing
    await expect(page.locator('text="default"')).not.toBeVisible();

    // Click Retry
    await page.locator('button:has-text("Retry")').click();

    // After retry, profiles should load and show profile names
    await expect(page.locator('text="default"')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator('text="research-mode"')).toBeVisible();

    // Verify that at least one retry request was made (requestCount should be > 2)
    expect(requestCount).toBeGreaterThanOrEqual(3);
  });
});
