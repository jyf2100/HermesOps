/**
 * E2E tests for the Create Agent page template selection flow.
 *
 * Covers: template dropdown loading, skills preview pills, SOUL.md pre-fill,
 * template_id in create request, switching templates, and manual SOUL.md
 * preservation across template switches.
 * All API responses are mocked -- no real backend needed.
 */
import { test, expect } from "@playwright/test";
import { loginAsAdminEn } from "./helpers";
import {
  VALID_ADMIN_KEY,
  mockEmptyAgentList,
  mockSettings,
  mockCreateAgentResponse,
} from "./fixtures/mock-data";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockTemplatesWithSkills = [
  {
    id: 1,
    name: "researcher",
    display_name: "Researcher",
    description: "Deep research and analysis template",
    config_overrides: {
      model: { default: "glm-4.7", provider: "custom" },
      skills: { install: ["web-search", "code-interpreter"] },
    },
    soul_md: "You are a professional research analyst.\nFocus on accuracy.",
    is_builtin: true,
    created_at: "2026-05-01T10:00:00Z",
    updated_at: "2026-05-01T10:00:00Z",
  },
  {
    id: 2,
    name: "writer",
    display_name: "Writer",
    description: "Content creation template",
    config_overrides: {
      model: { default: "glm-4.7", provider: "custom" },
      skills: { install: ["summarizer"] },
    },
    soul_md: "You are a professional content writer.\nBe creative.",
    is_builtin: true,
    created_at: "2026-05-01T10:00:00Z",
    updated_at: "2026-05-01T10:00:00Z",
  },
  {
    id: 3,
    name: "minimal",
    display_name: "Minimal",
    description: "Minimal template with no skills",
    config_overrides: {},
    soul_md: "You are a helpful assistant.",
    is_builtin: true,
    created_at: "2026-05-01T10:00:00Z",
    updated_at: "2026-05-01T10:00:00Z",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function goToCreateAgent(
  page: import("@playwright/test").Page,
  overrides?: { templates?: unknown }
) {
  const templates = overrides?.templates ?? mockTemplatesWithSkills;

  await page.route("**/admin/api/settings", (route) =>
    route.fulfill({ json: mockSettings })
  );
  await page.route("**/admin/api/agents", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: mockEmptyAgentList });
    }
    return route.fulfill({ json: mockCreateAgentResponse });
  });
  await page.route("**/admin/api/templates/soul", (route) =>
    route.fulfill({ json: { type: "soul", content: "Default SOUL.md content." } })
  );
  await page.route("**/admin/api/profile-templates**", (route) =>
    route.fulfill({ json: templates })
  );

  await page.goto("/admin/create");
  await expect(page.locator("text=/Confirm|确认/")).toBeVisible();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Create Agent - Template Selection", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  // ----- Template dropdown appears in Step 0 -----

  test("template dropdown appears in Step 0", async ({ page }) => {
    await goToCreateAgent(page);

    // Should find a label for Profile Template
    await expect(page.locator("text=Profile Template")).toBeVisible();

    // The select element should exist with "" as default
    const templateSelect = page.locator("select").first();
    await expect(templateSelect).toBeVisible();
    await expect(templateSelect).toHaveValue("");
  });

  // ----- Shows template options loaded from API -----

  test("shows template options loaded from API", async ({ page }) => {
    await goToCreateAgent(page);

    const templateSelect = page.locator("select").first();
    const options = templateSelect.locator("option");

    // Should have: None + 3 templates = 4 options
    await expect(options).toHaveCount(4);

    // Verify option text includes template display names
    await expect(options.nth(1)).toContainText("Researcher");
    await expect(options.nth(2)).toContainText("Writer");
    await expect(options.nth(3)).toContainText("Minimal");
  });

  // ----- Selecting template shows skills preview pills -----

  test("selecting template shows skills preview pills", async ({ page }) => {
    await goToCreateAgent(page);

    // No skills preview initially
    await expect(page.locator("text=Auto-install Skills")).toHaveCount(0);

    // Select Researcher template by value (id = 1)
    const templateSelect = page.locator("select").first();
    await templateSelect.selectOption("1");

    // Skills preview should appear
    await expect(page.locator("text=Auto-install Skills")).toBeVisible();

    // Should show skill pills
    await expect(page.locator("text=web-search")).toBeVisible();
    await expect(page.locator("text=code-interpreter")).toBeVisible();
  });

  // ----- Template with no skills shows "no skills" message -----

  test("selecting template with no skills shows no-skills message", async ({ page }) => {
    await goToCreateAgent(page);

    // Select Minimal template by value (id = 3)
    const templateSelect = page.locator("select").first();
    await templateSelect.selectOption("3");

    // Should show "No auto-install skills" text
    await expect(page.locator("text=No auto-install skills")).toBeVisible();
  });

  // ----- SOUL.md textarea pre-fills with template soul_md -----

  test("SOUL.md textarea pre-fills with template soul_md", async ({ page }) => {
    await goToCreateAgent(page);

    // Select Researcher template by value (id = 1)
    const templateSelect = page.locator("select").first();
    await templateSelect.selectOption("1");

    // Advance to Step 2 (SOUL.md step) -- skip through steps
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator("text=/API Key/")).toBeVisible();

    // Fill required LLM fields
    await page.fill('input[type="password"]', "sk-test-key");

    await page.getByRole("button", { name: "Confirm" }).click();

    // Now on SOUL.md step (Step 2)
    const soulTextarea = page.locator("textarea.font-mono");
    await expect(soulTextarea).toHaveValue(/professional research analyst/);
  });

  // ----- template_id included in create agent request body -----

  test("template_id included in create agent request body", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await page.route("**/admin/api/agents", (route) => {
      if (route.request().method() === "POST") {
        createBody = route.request().postDataJSON();
        return route.fulfill({ json: mockCreateAgentResponse });
      }
      return route.fulfill({ json: mockEmptyAgentList });
    });
    await page.route("**/admin/api/settings", (route) =>
      route.fulfill({ json: mockSettings })
    );
    await page.route("**/admin/api/templates/soul", (route) =>
      route.fulfill({ json: { type: "soul", content: "Default." } })
    );
    await page.route("**/admin/api/profile-templates**", (route) =>
      route.fulfill({ json: mockTemplatesWithSkills })
    );

    await page.goto("/admin/create");
    await expect(page.locator("text=/Confirm|确认/")).toBeVisible();

    // Select Researcher template by value (id = 1)
    const templateSelect = page.locator("select").first();
    await templateSelect.selectOption("1");

    // Step 0 -> Step 1
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator("text=/API Key/")).toBeVisible();

    // Fill required LLM fields
    await page.fill('input[type="password"]', "sk-test-key");

    // Step 1 -> Step 2
    await page.getByRole("button", { name: "Confirm" }).click();

    // Step 2 -> Step 3
    await page.getByRole("button", { name: "Confirm" }).click();

    // Step 3 -> Deploy
    await page.getByRole("button", { name: /Deploy|部署/ }).click();

    // Verify template_id in request
    await expect(() => {
      expect(createBody).toBeTruthy();
      expect(createBody!.template_id).toBe(1);
    }).toPass();
  });

  // ----- Switching template updates skills preview -----

  test("switching template updates skills preview", async ({ page }) => {
    await goToCreateAgent(page);

    const templateSelect = page.locator("select").first();

    // Select Researcher by value (id = 1)
    await templateSelect.selectOption("1");
    await expect(page.locator("text=web-search")).toBeVisible();
    await expect(page.locator("text=code-interpreter")).toBeVisible();

    // Switch to Writer by value (id = 2)
    await templateSelect.selectOption("2");
    await expect(page.locator("text=summarizer")).toBeVisible();
    // web-search and code-interpreter should no longer show as pills
    await expect(page.locator("text=code-interpreter")).toHaveCount(0);
  });

  // ----- Manual SOUL.md edit preserved on template switch -----

  test("manual SOUL.md edit is preserved on template switch", async ({ page }) => {
    await goToCreateAgent(page);

    // Select Researcher template by value (id = 1)
    const templateSelect = page.locator("select").first();
    await templateSelect.selectOption("1");

    // Advance to Step 2 (SOUL.md)
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator("text=/API Key/")).toBeVisible();
    await page.fill('input[type="password"]', "sk-test-key");
    await page.getByRole("button", { name: "Confirm" }).click();

    // Manually edit SOUL.md
    const soulTextarea = page.locator("textarea.font-mono");
    await soulTextarea.fill("My custom SOUL.md content that I wrote myself.");

    // Go back to Step 0
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Back" }).click();

    // Switch template to Writer by value (id = 2)
    await templateSelect.selectOption("2");

    // Go forward to Step 2 again
    await page.getByRole("button", { name: "Confirm" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();

    // SOUL.md should still contain the user's manual edit (not overwritten)
    const soulValue = await soulTextarea.inputValue();
    expect(soulValue).toBe("My custom SOUL.md content that I wrote myself.");
  });

  // ----- No templates available -----

  test("template dropdown works with no templates available", async ({ page }) => {
    await goToCreateAgent(page, { templates: [] });

    const templateSelect = page.locator("select").first();
    const options = templateSelect.locator("option");

    // Should only have "None" option
    await expect(options).toHaveCount(1);
  });

  // ----- Switching template back to None clears skills preview -----

  test("switching template back to None clears skills preview", async ({ page }) => {
    await goToCreateAgent(page);

    const templateSelect = page.locator("select").first();

    // Select a template by value (id = 1)
    await templateSelect.selectOption("1");
    await expect(page.locator("text=Auto-install Skills")).toBeVisible();

    // Switch back to None (empty value)
    await templateSelect.selectOption("");

    // Skills preview should be gone
    await expect(page.locator("text=Auto-install Skills")).toHaveCount(0);
  });
});
