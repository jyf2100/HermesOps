/**
 * E2E tests for the TemplateEditor "Skills to Install" panel.
 *
 * Covers: displaying installed skills from config_overrides.skills.install,
 * search with debounce, adding/removing skills, duplicate prevention,
 * read-only mode for builtin templates, and dropdown close behaviors.
 * All API responses are mocked -- no real backend needed.
 */
import { test, expect } from "@playwright/test";
import { loginAsAdminEn } from "./helpers";
import {
  mockProfileTemplates,
  mockCreatedTemplate,
} from "./fixtures/mock-data";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockHubSearchResults = {
  results: [
    { identifier: "web-search", name: "Web Search", description: "Search the web" },
    { identifier: "code-interpreter", name: "Code Interpreter", description: "Run code" },
    { identifier: "summarizer", name: "Summarizer", description: "Summarize text" },
  ],
};

const mockHubSearchSingle = {
  results: [
    { identifier: "data-analyzer", name: "Data Analyzer", description: "Analyze data" },
  ],
};

const mockHubSearchEmpty = {
  results: [],
};

const templateWithSkills = {
  ...mockProfileTemplates[2],
  config_overrides: {
    skills: {
      install: ["web-search", "code-interpreter"],
    },
  },
};

const builtinTemplateWithSkills = {
  ...mockProfileTemplates[0],
  config_overrides: {
    model: { default: "glm-4.7", provider: "custom" },
    skills: {
      install: ["web-search"],
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function goToTemplatesAndOpenEditor(
  page: import("@playwright/test").Page,
  overrides?: { templates?: unknown[] }
) {
  const templates = overrides?.templates ?? mockProfileTemplates;

  await page.route("**/admin/api/profile-templates**", (route) => {
    return route.fulfill({ json: templates });
  });

  await page.goto("/admin/templates");
  await page.waitForSelector('text="Template Library"');
}

async function openCreateEditor(page: import("@playwright/test").Page) {
  await page.click('button:has-text("New Template")');
  await expect(page.locator('[role="dialog"]')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Template Skills Install Panel", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  // ----- Empty state -----

  test("shows empty state when no skills in install list", async ({ page }) => {
    await goToTemplatesAndOpenEditor(page);
    await openCreateEditor(page);

    // Config JSON defaults to {} which has no skills.install
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator('text="No auto-install skills configured"')).toBeVisible();
  });

  // ----- Shows installed skills from config -----

  test("shows installed skills parsed from config_overrides.skills.install", async ({ page }) => {
    const templates = mockProfileTemplates.map((t, i) =>
      i === 2 ? templateWithSkills : t
    );
    await goToTemplatesAndOpenEditor(page, { templates });

    // Edit the template that has skills
    const customCard = page.locator("article").nth(2);
    await customCard.locator('button:has-text("Edit")').click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    const dialog = page.locator('[role="dialog"]');
    // Scope to listitem to avoid matching text inside the config textarea
    await expect(dialog.locator("li").filter({ hasText: "web-search" })).toBeVisible();
    await expect(dialog.locator("li").filter({ hasText: "code-interpreter" })).toBeVisible();
  });

  // ----- Search input triggers API call after debounce -----

  test("search input triggers hub search API after debounce", async ({ page }) => {
    await goToTemplatesAndOpenEditor(page);
    await openCreateEditor(page);

    let searchCalled = false;
    let searchQuery = "";
    await page.route("**/admin/api/hub/search*", (route) => {
      searchCalled = true;
      const url = new URL(route.request().url());
      searchQuery = url.searchParams.get("q") ?? "";
      return route.fulfill({ json: mockHubSearchResults });
    });

    const dialog = page.locator('[role="dialog"]');
    const searchInput = dialog.locator('input[placeholder="Search Hub skills..."]');
    await searchInput.fill("web");

    // API should NOT be called immediately (300ms debounce)
    expect(searchCalled).toBe(false);

    // Wait for debounce to fire
    await page.waitForTimeout(400);

    expect(searchCalled).toBe(true);
    expect(searchQuery).toBe("web");
  });

  // ----- Search results dropdown shows results -----

  test("search results dropdown shows matching results", async ({ page }) => {
    await goToTemplatesAndOpenEditor(page);
    await openCreateEditor(page);

    await page.route("**/admin/api/hub/search*", (route) => {
      return route.fulfill({ json: mockHubSearchSingle });
    });

    const dialog = page.locator('[role="dialog"]');
    const searchInput = dialog.locator('input[placeholder="Search Hub skills..."]');
    await searchInput.fill("data");

    // Wait for debounce + rendering
    await page.waitForTimeout(400);

    // Dropdown should show the result
    await expect(dialog.locator("text=data-analyzer")).toBeVisible();
    await expect(dialog.locator("text=Analyze data")).toBeVisible();
  });

  // ----- Clicking search result adds skill to install list -----

  test("clicking search result adds skill to config JSON", async ({ page }) => {
    await goToTemplatesAndOpenEditor(page);
    await openCreateEditor(page);

    await page.route("**/admin/api/hub/search*", (route) => {
      return route.fulfill({ json: mockHubSearchSingle });
    });

    const dialog = page.locator('[role="dialog"]');
    const searchInput = dialog.locator('input[placeholder="Search Hub skills..."]');
    await searchInput.fill("data");
    await page.waitForTimeout(400);

    // Click the search result button in the dropdown
    const dropdown = dialog.locator("ul.absolute");
    const dropdownButton = dropdown.locator("button").filter({ hasText: "data-analyzer" });
    await dropdownButton.click();

    // Skill should now appear in the installed list
    await expect(dialog.locator("li").filter({ hasText: "data-analyzer" })).toBeVisible();

    // Verify config JSON textarea contains the skill
    // The config textarea is the one within the "Config Overrides" section
    const configSection = dialog.locator("div").filter({ hasText: /^Config Overrides/ });
    const configTextarea = configSection.locator("textarea");
    const configValue = await configTextarea.inputValue();
    const parsed = JSON.parse(configValue);
    expect(parsed.skills.install).toContain("data-analyzer");
  });

  // ----- Duplicate skill is not added -----

  test("duplicate skill is not added to install list", async ({ page }) => {
    // Open a template that already has web-search installed
    const templates = mockProfileTemplates.map((t, i) =>
      i === 2
        ? {
            ...t,
            config_overrides: {
              skills: { install: ["web-search"] },
            },
          }
        : t
    );
    await goToTemplatesAndOpenEditor(page, { templates });

    const customCard = page.locator("article").nth(2);
    await customCard.locator('button:has-text("Edit")').click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    await page.route("**/admin/api/hub/search*", (route) => {
      return route.fulfill({
        json: {
          results: [
            { identifier: "web-search", name: "Web Search", description: "Search the web" },
          ],
        },
      });
    });

    const dialog = page.locator('[role="dialog"]');
    const searchInput = dialog.locator('input[placeholder="Search Hub skills..."]');
    await searchInput.fill("web");
    await page.waitForTimeout(400);

    // Click the result button in dropdown (web-search is already installed)
    const dropdown = dialog.locator("ul.absolute");
    const searchResultBtn = dropdown.locator("button").filter({ hasText: "web-search" });
    await searchResultBtn.click();

    // Config should still have only one web-search
    const configSection = dialog.locator("div").filter({ hasText: /^Config Overrides/ });
    const configTextarea = configSection.locator("textarea");
    const configValue = await configTextarea.inputValue();
    const parsed = JSON.parse(configValue);
    const installCount = (parsed.skills.install as string[]).filter(
      (s: string) => s === "web-search"
    ).length;
    expect(installCount).toBe(1);
  });

  // ----- X button removes skill -----

  test("X button removes skill from install list", async ({ page }) => {
    const templates = mockProfileTemplates.map((t, i) =>
      i === 2
        ? {
            ...t,
            config_overrides: {
              skills: { install: ["web-search", "code-interpreter"] },
            },
          }
        : t
    );
    await goToTemplatesAndOpenEditor(page, { templates });

    const customCard = page.locator("article").nth(2);
    await customCard.locator('button:has-text("Edit")').click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    const dialog = page.locator('[role="dialog"]');

    // Both skills should be visible as list items
    await expect(dialog.locator("li").filter({ hasText: "web-search" })).toBeVisible();
    await expect(dialog.locator("li").filter({ hasText: "code-interpreter" })).toBeVisible();

    // Click X button to remove web-search using dispatchEvent to avoid
    // visibility issues in the scrollable dialog
    const webSearchItem = dialog.locator("li").filter({ hasText: "web-search" });
    const removeButton = webSearchItem.locator('button[aria-label="Remove web-search"]');
    await removeButton.dispatchEvent("click");

    // web-search should be gone, code-interpreter still present
    await expect(dialog.locator("li").filter({ hasText: "web-search" })).toHaveCount(0);
    await expect(dialog.locator("li").filter({ hasText: "code-interpreter" })).toBeVisible();

    // Verify config JSON reflects the removal
    const configSection = dialog.locator("div").filter({ hasText: /^Config Overrides/ });
    const configTextarea = configSection.locator("textarea");
    const configValue = await configTextarea.inputValue();
    const parsed = JSON.parse(configValue);
    expect(parsed.skills.install).not.toContain("web-search");
    expect(parsed.skills.install).toContain("code-interpreter");
  });

  // ----- Builtin template edit: read-only -----

  test("builtin template edit shows skills read-only, no search, no remove buttons", async ({ page }) => {
    const templates = mockProfileTemplates.map((t, i) =>
      i === 0 ? builtinTemplateWithSkills : t
    );
    await goToTemplatesAndOpenEditor(page, { templates });

    // Edit the builtin template
    const builtinCard = page.locator("article").first();
    await builtinCard.locator('button:has-text("Edit")').click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    const dialog = page.locator('[role="dialog"]');

    // Skill should be displayed as a list item
    await expect(dialog.locator("li").filter({ hasText: "web-search" })).toBeVisible();

    // No search input for builtin edit
    await expect(dialog.locator('input[placeholder="Search Hub skills..."]')).toHaveCount(0);

    // No remove button for installed skills
    await expect(dialog.locator('button[aria-label="Remove web-search"]')).toHaveCount(0);

    // Builtin notice should be visible
    await expect(dialog.locator("text=/Built-in/")).toBeVisible();
  });

  // ----- Click outside search dropdown closes it -----

  test("click outside search dropdown closes it", async ({ page }) => {
    await goToTemplatesAndOpenEditor(page);
    await openCreateEditor(page);

    await page.route("**/admin/api/hub/search*", (route) => {
      return route.fulfill({ json: mockHubSearchResults });
    });

    const dialog = page.locator('[role="dialog"]');
    const searchInput = dialog.locator('input[placeholder="Search Hub skills..."]');
    await searchInput.fill("test");
    await page.waitForTimeout(400);

    // Dropdown should be visible with results
    const dropdownItem = dialog.locator("button").filter({ hasText: "web-search" });
    await expect(dropdownItem).toBeVisible();

    // Dispatch a mousedown on the dialog title to trigger outside click handler
    // (the component uses document mousedown listener, not click)
    await dialog.locator("#template-editor-title").dispatchEvent("mousedown");

    // Dropdown results should be gone
    await expect(dropdownItem).toHaveCount(0);
  });

  // ----- Empty search query clears results -----

  test("empty search query clears results without API call", async ({ page }) => {
    await goToTemplatesAndOpenEditor(page);
    await openCreateEditor(page);

    let callCount = 0;
    await page.route("**/admin/api/hub/search*", (route) => {
      callCount++;
      return route.fulfill({ json: mockHubSearchResults });
    });

    const dialog = page.locator('[role="dialog"]');
    const searchInput = dialog.locator('input[placeholder="Search Hub skills..."]');

    // Type to trigger search
    await searchInput.fill("test");
    await page.waitForTimeout(400);
    expect(callCount).toBe(1);

    // Results should be visible in the dropdown
    const dropdownItem = dialog.locator("button").filter({ hasText: "web-search" });
    await expect(dropdownItem).toBeVisible();

    // Clear the search input
    await searchInput.clear();

    // Results should be cleared immediately (no debounce for empty)
    await expect(dropdownItem).toHaveCount(0);

    // Wait a bit more and verify no additional API calls
    await page.waitForTimeout(400);
    expect(callCount).toBe(1);
  });
});
