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
  mockCreatedTemplate,
  mockClonedTemplate,
} from "./fixtures/mock-data";

/**
 * Register all base page.route() mocks required for AgentDetailPage to render.
 * Returns a cleanup function (not usually needed — page.routes reset between tests).
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
    route.fulfill({ json: overrides?.profiles ?? [] })
  );
  await page.route("**/admin/api/profile-templates", (route) =>
    route.fulfill({ json: mockProfileTemplates })
  );
}

// Navigate to agent detail profiles tab with all required mocks
async function goToProfiles(page) {
  await mockBaseRoutes(page);
  await page.goto("/admin/agents/1?tab=profiles");
  await page.waitForSelector('text="Profiles"');
}

test.describe("Profile Template Management", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("displays template list in profile editor dropdown", async ({ page }) => {
    await goToProfiles(page);

    // Open create profile editor (which shows template dropdown)
    await page.click('button:has-text("Create Profile")');

    // Template selector should show templates
    const selector = page.locator('[role="dialog"] select');
    const options = await selector.locator("option").allTextContents();
    expect(options.some((o) => o.includes("Researcher"))).toBe(true);
    expect(options.some((o) => o.includes("Writer"))).toBe(true);
    expect(options.some((o) => o.includes("My Custom"))).toBe(true);
  });

  test("built-in templates show (Built-in) label", async ({ page }) => {
    await goToProfiles(page);

    await page.click('button:has-text("Create Profile")');

    const selector = page.locator('[role="dialog"] select');
    const options = await selector.locator("option").allTextContents();
    expect(options.some((o) => o.includes("Built-in"))).toBe(true);
  });

  test("can select a template when creating profile", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await mockBaseRoutes(page);
    // Override profiles route to handle both GET and POST
    await page.route("**/admin/api/agents/1/profiles", async (route) => {
      if (route.request().method() === "POST") {
        createBody = route.request().postDataJSON();
        return route.fulfill({ json: { ...createBody, id: 200, sync_status: "pending", config_hash: "x" } });
      }
      return route.fulfill({ json: [] });
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    await page.click('button:has-text("Create Profile")');

    // Fill profile name
    await page.fill('input[placeholder="e.g. researcher"]', "my-profile");

    // Select template
    await page.locator('[role="dialog"] select').selectOption("1");

    // Submit
    await page.click('button:has-text("Save")');

    // Verify template_id was sent
    await expect(() => {
      expect(createBody).toBeTruthy();
      expect(createBody!.template_id).toBe(1);
    }).toPass();
  });

  test("template-less profile creation works", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await mockBaseRoutes(page);
    // Override profiles route to handle both GET and POST
    await page.route("**/admin/api/agents/1/profiles", async (route) => {
      if (route.request().method() === "POST") {
        createBody = route.request().postDataJSON();
        return route.fulfill({
          json: { ...createBody, id: 201, sync_status: "pending", config_hash: "y" },
        });
      }
      return route.fulfill({ json: [] });
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    await page.click('button:has-text("Create Profile")');
    await page.fill('input[placeholder="e.g. researcher"]', "standalone-profile");
    await page.click('button:has-text("Save")');

    await expect(() => {
      expect(createBody).toBeTruthy();
      expect(createBody!.template_id).toBeNull();
    }).toPass();
  });
});

test.describe("Profile Template CRUD (Backend Integration)", () => {
  // These tests verify the frontend correctly calls the template API endpoints
  // by checking mocked request patterns

  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("loads templates on profile tab open", async ({ page }) => {
    let templatesRequested = false;

    await mockBaseRoutes(page);
    // Override templates route to track that it was requested
    await page.route("**/admin/api/profile-templates", async (route) => {
      templatesRequested = true;
      return route.fulfill({ json: mockProfileTemplates });
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    expect(templatesRequested).toBe(true);
  });

  test("shows empty state when no profiles exist", async ({ page }) => {
    await goToProfiles(page);

    await expect(page.locator('text="No profiles"')).toBeVisible();
  });

  test("shows create button in profile header", async ({ page }) => {
    await goToProfiles(page);

    await expect(page.locator('button:has-text("Create Profile")')).toBeVisible();
  });

  test("editor modal opens and closes", async ({ page }) => {
    await goToProfiles(page);

    // Open
    await page.click('button:has-text("Create Profile")');
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Close via Cancel button (X button is outside viewport due to modal sizing)
    await page.locator('[role="dialog"] button:has-text("Cancel")').click();
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });

  test("editor closes on Escape key", async ({ page }) => {
    await goToProfiles(page);

    await page.click('button:has-text("Create Profile")');
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Press Escape to close
    await page.locator('[role="dialog"]').press("Escape");
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });

  test("editor closes on backdrop click", async ({ page }) => {
    await goToProfiles(page);

    await page.click('button:has-text("Create Profile")');
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Dispatch click directly on the backdrop overlay
    await page.dispatchEvent('[data-testid="modal-backdrop"]', 'click');
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });

  test("validates required profile name on create", async ({ page }) => {
    await goToProfiles(page);

    await page.click('button:has-text("Create Profile")');
    // Don't fill in profile name, just click Save
    await page.click('button:has-text("Save")');

    // Should show validation error
    await expect(page.locator('text="Profile name is required"')).toBeVisible();
  });

  test("validates JSON config overrides", async ({ page }) => {
    await goToProfiles(page);

    await page.click('button:has-text("Create Profile")');
    await page.fill('input[placeholder="e.g. researcher"]', "test-profile");

    // Enter invalid JSON in config textarea
    const configTextarea = page.locator("textarea").first();
    await configTextarea.fill("{invalid json}");
    await page.click('button:has-text("Save")');

    await expect(page.locator('text="Invalid JSON in config overrides"')).toBeVisible();
  });
});
