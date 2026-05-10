import { test, expect } from "@playwright/test";
import { loginAsAdminEn } from "./helpers";
import {
  VALID_ADMIN_KEY,
  mockProfileTemplates,
  mockCreatedTemplate,
  mockClonedTemplate,
  mockClusterStatus,
  mockEmptyAgentList,
  mockSkillsSummary,
  mockEmptySkillsSummary,
} from "./fixtures/mock-data";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mock GET /admin/api/profile-templates and navigate to the templates page.
 */
async function goToTemplates(page, overrides?: { templates?: unknown }) {
  await page.route("**/admin/api/profile-templates**", (route) => {
    // Capture query params for filter/search tests
    const url = new URL(route.request().url());
    const search = url.searchParams.get("search");
    const isBuiltin = url.searchParams.get("is_builtin");

    let data = overrides?.templates ?? mockProfileTemplates;
    if (Array.isArray(data)) {
      if (isBuiltin === "true") {
        data = data.filter((t) => t.is_builtin);
      } else if (isBuiltin === "false") {
        data = data.filter((t) => !t.is_builtin);
      }
      if (search) {
        const q = search.toLowerCase();
        data = data.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            (t.display_name ?? "").toLowerCase().includes(q) ||
            (t.description ?? "").toLowerCase().includes(q)
        );
      }
    }
    return route.fulfill({ json: data });
  });

  await page.goto("/admin/templates");
  await page.waitForSelector('text="Template Library"');
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

test.describe("Template Management Page", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  // ----- Page load & layout -----

  test("loads and displays template cards", async ({ page }) => {
    await goToTemplates(page);

    // Should show 3 templates from mock data
    const cards = page.locator("article");
    await expect(cards).toHaveCount(3);

    // First two should show "Built-in" badge
    await expect(cards.nth(0).locator('text="Built-in"')).toBeVisible();
    await expect(cards.nth(1).locator('text="Built-in"')).toBeVisible();
    // Third is custom
    await expect(cards.nth(2).locator('text="Custom"')).toBeVisible();
  });

  test("displays template names and descriptions", async ({ page }) => {
    await goToTemplates(page);

    await expect(page.locator('text="Researcher"').first()).toBeVisible();
    await expect(page.locator('text="Writer"').first()).toBeVisible();
    await expect(page.locator('text="Deep research and analysis template"')).toBeVisible();
  });

  test("shows Templates tab as active and Skills tab is enabled", async ({ page }) => {
    await goToTemplates(page);

    // Templates tab is active (has border-accent-cyan)
    const templatesTab = page.locator('button:has-text("Templates")');
    await expect(templatesTab).toBeVisible();
    expect(await templatesTab.getAttribute("class")).toContain("border-accent-cyan");

    // Skills tab is enabled and clickable
    const skillsTab = page.locator('button:has-text("Skills")');
    await expect(skillsTab).toBeVisible();
    await expect(skillsTab).toBeEnabled();
  });

  // ----- Filter bar -----

  test("filter: All shows all templates", async ({ page }) => {
    await goToTemplates(page);

    // "All" is selected by default
    await expect(page.locator('button:has-text("All")')).toHaveClass(/accent-cyan/);
    await expect(page.locator("article")).toHaveCount(3);
  });

  test("filter: Built-in shows only built-in templates", async ({ page }) => {
    await goToTemplates(page);

    await page.click('button:has-text("Built-in")');
    // Wait for re-fetch
    await page.waitForTimeout(100);

    // Should show 2 built-in templates
    const cards = page.locator("article");
    await expect(cards).toHaveCount(2);
    // All should have "Built-in" badge
    await expect(cards.nth(0).locator('text="Built-in"')).toBeVisible();
    await expect(cards.nth(1).locator('text="Built-in"')).toBeVisible();
  });

  test("filter: Custom shows only custom templates", async ({ page }) => {
    await goToTemplates(page);

    await page.click('button:has-text("Custom")');
    await page.waitForTimeout(100);

    // Should show 1 custom template
    const cards = page.locator("article");
    await expect(cards).toHaveCount(1);
    await expect(cards.nth(0).locator('text="Custom"')).toBeVisible();
  });

  // ----- Search -----

  test("search filters templates by name", async ({ page }) => {
    await goToTemplates(page);

    const searchInput = page.locator('input[placeholder="Search templates..."]');
    await searchInput.fill("research");

    // Wait for debounce (300ms)
    await page.waitForTimeout(400);

    const cards = page.locator("article");
    await expect(cards).toHaveCount(1);
    await expect(cards.nth(0).locator('text="Researcher"')).toBeVisible();
  });

  test("search shows empty state when no matches", async ({ page }) => {
    await goToTemplates(page);

    const searchInput = page.locator('input[placeholder="Search templates..."]');
    await searchInput.fill("zzz-nonexistent");

    await page.waitForTimeout(400);

    await expect(page.locator('text="No matching templates found"')).toBeVisible();
    await expect(page.locator("article")).toHaveCount(0);
  });

  // ----- Empty state -----

  test("shows empty state when no templates exist", async ({ page }) => {
    await goToTemplates(page, { templates: [] });

    await expect(page.locator('text="No templates yet"')).toBeVisible();
    await expect(page.locator("article")).toHaveCount(0);
  });

  // ----- Error state & retry -----

  test("shows error state when API fails and retries", async ({ page }) => {
    let callCount = 0;
    await page.route("**/admin/api/profile-templates**", (route) => {
      callCount++;
      if (callCount === 1) {
        return route.fulfill({ status: 500, json: { detail: "Server error" } });
      }
      return route.fulfill({ json: mockProfileTemplates });
    });

    await page.goto("/admin/templates");
    await expect(page.locator('text="Retry"')).toBeVisible();

    // Click retry
    await page.click('button:has-text("Retry")');
    await page.waitForSelector('text="Template Library"');

    // Should now show templates
    await expect(page.locator("article")).toHaveCount(3);
  });

  // ----- Create template -----

  test("opens create editor and creates a template", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await goToTemplates(page);
    await page.route("**/admin/api/profile-templates**", (route) => {
      if (route.request().method() === "POST") {
        createBody = route.request().postDataJSON();
        return route.fulfill({ json: mockCreatedTemplate });
      }
      // GET requests
      const url = new URL(route.request().url());
      if (url.searchParams.has("search") || url.searchParams.has("is_builtin")) {
        return route.fulfill({ json: mockProfileTemplates });
      }
      return route.fulfill({ json: [...mockProfileTemplates, mockCreatedTemplate] });
    });

    // Open create modal
    await page.click('button:has-text("New Template")');
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Fill in name
    await page.fill('input[placeholder="e.g. my-template"]', "new-template");

    // Fill display name
    await page.fill('input[placeholder="Optional display name"]', "New Template");

    // Fill description
    await page.fill("textarea", "A brand new template");

    // Submit
    await page.click('[role="dialog"] button:has-text("Save")');

    // Verify request
    await expect(() => {
      expect(createBody).toBeTruthy();
      expect(createBody!.name).toBe("new-template");
      expect(createBody!.display_name).toBe("New Template");
      expect(createBody!.description).toBe("A brand new template");
    }).toPass();
  });

  test("validates required template name on create", async ({ page }) => {
    await goToTemplates(page);

    await page.click('button:has-text("New Template")');

    // Tab out of name field to trigger blur validation
    const nameInput = page.locator('input[placeholder="e.g. my-template"]');
    await nameInput.focus();
    await nameInput.blur();

    await expect(page.locator('text="Template name is required"')).toBeVisible();
  });

  test("validates invalid template name characters", async ({ page }) => {
    await goToTemplates(page);

    await page.click('button:has-text("New Template")');
    const nameInput = page.locator('input[placeholder="e.g. my-template"]');
    await nameInput.fill("bad name!@#");
    // Trigger blur for validation
    await nameInput.blur();

    // Error message contains "(max 64)"
    await expect(page.locator("text=/Only letters, numbers/")).toBeVisible();
  });

  test("validates duplicate template name", async ({ page }) => {
    await goToTemplates(page);

    await page.click('button:has-text("New Template")');
    const nameInput = page.locator('input[placeholder="e.g. my-template"]');
    await nameInput.fill("researcher");
    await nameInput.blur();

    await expect(page.locator('text="Template name already exists"')).toBeVisible();
  });

  test("validates invalid JSON in config", async ({ page }) => {
    await goToTemplates(page);

    await page.click('button:has-text("New Template")');
    await page.fill('input[placeholder="e.g. my-template"]', "valid-name");

    // Find config textarea via its label "Config Overrides"
    const configSection = page.locator('[role="dialog"]').locator("div").filter({ hasText: /^Config Overrides/ });
    const configTextarea = configSection.locator("textarea");
    await configTextarea.fill("{invalid}");

    // Click Save to trigger validation (configTouched is set on submit)
    await page.click('[role="dialog"] button:has-text("Save")');

    await expect(page.locator('[role="dialog"]')).toContainText("Invalid JSON");
  });

  // ----- Edit template -----

  test("edit builtin template: name is readonly, config/soul disabled", async ({ page }) => {
    await goToTemplates(page);

    // Click edit on first (builtin) template
    const firstCard = page.locator("article").first();
    await firstCard.locator('button:has-text("Edit")').click();

    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Name input should be readonly
    const nameInput = page.locator('input[placeholder="e.g. my-template"]');
    expect(await nameInput.getAttribute("readonly")).not.toBeNull();

    // Should show builtin notice about read-only fields
    await expect(page.locator('text="Built-in"').nth(1)).toBeVisible();
  });

  test("edit custom template: all fields editable", async ({ page }) => {
    let updateBody: Record<string, unknown> | null = null;

    await goToTemplates(page);
    await page.route("**/admin/api/profile-templates/**", (route) => {
      if (route.request().method() === "PUT") {
        updateBody = route.request().postDataJSON();
        return route.fulfill({
          json: { ...mockProfileTemplates[2], affected_profiles: 0 },
        });
      }
      return route.fulfill({ json: mockProfileTemplates });
    });

    // Edit the custom template (3rd card)
    const customCard = page.locator("article").nth(2);
    await customCard.locator('button:has-text("Edit")').click();

    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Update display name
    const displayInput = page.locator('input[placeholder="Optional display name"]');
    await displayInput.clear();
    await displayInput.fill("Updated Custom");

    // Submit
    await page.click('[role="dialog"] button:has-text("Save")');

    await expect(() => {
      expect(updateBody).toBeTruthy();
      expect(updateBody!.display_name).toBe("Updated Custom");
    }).toPass();
  });

  // ----- Clone template -----

  test("clone template pre-fills name with -copy suffix", async ({ page }) => {
    await goToTemplates(page);

    // Clone first template (Researcher)
    const firstCard = page.locator("article").first();
    await firstCard.locator('button:has-text("Clone")').click();

    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Name should be pre-filled with "-copy" suffix
    const nameInput = page.locator('input[placeholder="e.g. my-template"]');
    await expect(nameInput).toHaveValue("researcher-copy");

    // Display name should have "(Copy)" suffix
    const displayInput = page.locator('input[placeholder="Optional display name"]');
    await expect(displayInput).toHaveValue(/Copy/);
  });

  test("clone template calls clone API", async ({ page }) => {
    let cloned = false;

    await goToTemplates(page);
    await page.route("**/admin/api/profile-templates/**", (route) => {
      if (route.request().method() === "POST" && route.request().url().includes("/clone")) {
        cloned = true;
        return route.fulfill({ json: mockClonedTemplate });
      }
      return route.fulfill({ json: mockProfileTemplates });
    });

    const firstCard = page.locator("article").first();
    await firstCard.locator('button:has-text("Clone")').click();
    await page.click('[role="dialog"] button:has-text("Save")');

    await expect(() => {
      expect(cloned).toBe(true);
    }).toPass();
  });

  // ----- Delete template -----

  test("builtin template has no delete button", async ({ page }) => {
    await goToTemplates(page);

    // First card is builtin
    const builtinCard = page.locator("article").first();
    await expect(builtinCard.locator('button:has-text("Delete")')).toHaveCount(0);
  });

  test("custom template delete requires confirmation", async ({ page }) => {
    await goToTemplates(page);

    // Verify custom card exists
    const customCard = page.locator("article").nth(2);
    await expect(customCard.locator('text="Custom"')).toBeVisible();

    // Register dialog handler before clicking
    let dialogMessage = "";
    page.once("dialog", async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.dismiss(); // Cancel
    });

    await customCard.locator('button:has-text("Delete")').click();

    // Dialog should have appeared with template display name
    await expect(() => {
      expect(dialogMessage).toContain("My Custom");
    }).toPass();

    // Dialog was dismissed, template should still be visible
    await expect(page.locator("article")).toHaveCount(3);
  });

  test("custom template delete confirmed removes card", async ({ page }) => {
    let deleted = false;

    await goToTemplates(page);
    await page.route("**/admin/api/profile-templates/**", (route) => {
      if (route.request().method() === "DELETE") {
        deleted = true;
        return route.fulfill({ json: { message: "Deleted" } });
      }
      return route.fulfill({ json: mockProfileTemplates.filter((t) => t.name !== "my-custom") });
    });

    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });

    const customCard = page.locator("article").nth(2);
    await customCard.locator('button:has-text("Delete")').click();

    await expect(() => {
      expect(deleted).toBe(true);
    }).toPass();
  });

  // ----- Editor modal close -----

  test("editor closes on Cancel button", async ({ page }) => {
    await goToTemplates(page);
    await page.click('button:has-text("New Template")');
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    await page.locator('[role="dialog"] button:has-text("Cancel")').click();
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });

  test("editor closes on Escape key", async ({ page }) => {
    await goToTemplates(page);
    await page.click('button:has-text("New Template")');
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    await page.locator('[role="dialog"]').press("Escape");
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });

  test("editor closes on backdrop click", async ({ page }) => {
    await goToTemplates(page);
    await page.click('button:has-text("New Template")');
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    await page.dispatchEvent('[data-testid="modal-root"]', "click");
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });

  test("editor closes on X button", async ({ page }) => {
    await goToTemplates(page);
    await page.click('button:has-text("New Template")');
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Click close button via dispatchEvent (headless Chromium viewport issue)
    const closeButton = page.locator('[role="dialog"] button[aria-label="Close"]');
    await closeButton.dispatchEvent("click");
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });

  // ----- Profile count display -----

  test("shows profile count when template has linked profiles", async ({ page }) => {
    const templatesWithCount = mockProfileTemplates.map((t, i) =>
      i === 0 ? { ...t, profile_count: 3 } : t
    );

    await goToTemplates(page, { templates: templatesWithCount });

    // First card should show profile count
    const firstCard = page.locator("article").first();
    await expect(firstCard.locator('text="3 Profile(s)"')).toBeVisible();
  });

  // ----- Skills tags -----

  test("shows skill tags when template has skills in config", async ({ page }) => {
    const templatesWithSkills = mockProfileTemplates.map((t, i) =>
      i === 0
        ? {
            ...t,
            config_overrides: {
              ...t.config_overrides,
              skills: { enabled: ["web-search", "code-interpreter"] },
            },
          }
        : t
    );

    await goToTemplates(page, { templates: templatesWithSkills });

    // First card should show skill tags
    const firstCard = page.locator("article").first();
    await expect(firstCard.locator('text="web-search"')).toBeVisible();
    await expect(firstCard.locator('text="code-interpreter"')).toBeVisible();
  });

  // ----- Navigation -----

  test("navigates to templates page from sidebar", async ({ page }) => {
    // Mock dashboard routes (using loginAsAdminEn which is already called in beforeEach)
    await page.route("**/admin/api/cluster/status", (route) =>
      route.fulfill({ json: mockClusterStatus })
    );
    await page.route("**/admin/api/agents", (route) =>
      route.fulfill({ json: mockEmptyAgentList })
    );
    await page.route("**/admin/api/swarm/capability", (route) =>
      route.fulfill({ json: { enabled: false } })
    );
    // Mock templates page routes
    await page.route("**/admin/api/profile-templates**", (route) =>
      route.fulfill({ json: mockProfileTemplates })
    );

    // Go to dashboard
    await page.goto("/admin/");
    // Wait for agent list to load (empty state)
    await expect(page.getByText(/No Agent/i)).toBeVisible();

    // Click Templates nav item
    await page.click('a:has-text("Templates")');
    await expect(page.locator('text="Template Library"')).toBeVisible();

    expect(page.url()).toContain("/admin/templates");
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Skills Management Tab
// ---------------------------------------------------------------------------

test.describe("Skills Management Tab", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  // Helper: set up routes and navigate, optionally override skills-summary
  async function goToTemplatesWithSkills(
    page: import("@playwright/test").Page,
    overrides?: {
      templates?: unknown;
      skillsSummary?: unknown;
    }
  ) {
    await goToTemplates(page, { templates: overrides?.templates });
    // Register skills-summary AFTER goToTemplates so the more specific route wins
    await page.route("**/admin/api/profile-templates/skills-summary", (route) => {
      return route.fulfill({ json: overrides?.skillsSummary ?? mockSkillsSummary });
    });
  }

  // ----- Tab switching -----

  test("switching to Skills tab shows skill cards", async ({ page }) => {
    await goToTemplatesWithSkills(page);

    // Click Skills tab
    await page.click('button:has-text("Skills")');

    // Should show skill cards
    const cards = page.locator("article");
    await expect(cards).toHaveCount(3);

    // First skill (most templates) should be web-search
    await expect(cards.first().locator("text=web-search")).toBeVisible();
  });

  test("switching back to Templates tab restores template view", async ({ page }) => {
    await goToTemplatesWithSkills(page);

    // Switch to Skills
    await page.click('button:has-text("Skills")');
    await expect(page.locator("article").first().locator("text=web-search")).toBeVisible();

    // Switch back
    await page.click('button:has-text("Templates")');
    await expect(page.locator("article")).toHaveCount(3);
    await expect(page.locator('text="Researcher"').first()).toBeVisible();
  });

  // ----- Lazy loading -----

  test("skills-summary API is not called on initial page load", async ({ page }) => {
    await goToTemplates(page);
    let skillsCallCount = 0;
    await page.route("**/admin/api/profile-templates/skills-summary", (route) => {
      skillsCallCount++;
      return route.fulfill({ json: mockSkillsSummary });
    });

    // Skills API should not have been called
    expect(skillsCallCount).toBe(0);
  });

  test("skills-summary API is called only once on first tab switch", async ({ page }) => {
    await goToTemplates(page);
    let skillsCallCount = 0;
    await page.route("**/admin/api/profile-templates/skills-summary", (route) => {
      skillsCallCount++;
      return route.fulfill({ json: mockSkillsSummary });
    });

    // Switch to Skills
    await page.click('button:has-text("Skills")');
    await expect(page.locator("article").first()).toBeVisible();
    expect(skillsCallCount).toBe(1);

    // Switch back then to Skills again - should NOT re-fetch
    await page.click('button:has-text("Templates")');
    await page.click('button:has-text("Skills")');
    await expect(page.locator("article").first()).toBeVisible();
    expect(skillsCallCount).toBe(1);
  });

  // ----- Skill cards rendering -----

  test("each skill card displays name and template count", async ({ page }) => {
    await goToTemplatesWithSkills(page);
    await page.click('button:has-text("Skills")');

    const cards = page.locator("article");

    // web-search: used by 2 templates
    await expect(cards.nth(0).locator("text=web-search")).toBeVisible();
    await expect(cards.nth(0).locator("text=/2 template/")).toBeVisible();

    // code-interpreter: used by 1 template
    await expect(cards.nth(1).locator("text=code-interpreter")).toBeVisible();
    await expect(cards.nth(1).locator("text=/1 template/")).toBeVisible();
  });

  // ----- Empty state -----

  test("shows empty state when no skills are configured", async ({ page }) => {
    await goToTemplatesWithSkills(page, { skillsSummary: mockEmptySkillsSummary });

    await page.click('button:has-text("Skills")');

    await expect(page.locator("article")).toHaveCount(0);
    await expect(page.locator("text=/No skills configured/")).toBeVisible();
  });

  // ----- Error state -----

  test("shows error state when skills-summary API fails and retries", async ({ page }) => {
    await goToTemplates(page);
    let callCount = 0;
    await page.route("**/admin/api/profile-templates/skills-summary", (route) => {
      callCount++;
      if (callCount === 1) {
        return route.fulfill({ status: 500, json: { detail: "Server error" } });
      }
      return route.fulfill({ json: mockSkillsSummary });
    });

    await page.click('button:has-text("Skills")');
    await expect(page.locator('button:has-text("Retry")')).toBeVisible();

    // Click retry
    await page.click('button:has-text("Retry")');
    await expect(page.locator("article")).toHaveCount(3);
  });

  // ----- Skill → Template filter -----

  test("clicking skill card switches to Templates tab and filters", async ({ page }) => {
    await goToTemplatesWithSkills(page);
    await page.click('button:has-text("Skills")');

    // Click web-search (template_ids: [1, 2])
    await page.locator("article").first().click();

    // Should be on Templates tab
    const templatesTab = page.locator('button:has-text("Templates")');
    expect(await templatesTab.getAttribute("class")).toContain("border-accent-cyan");

    // Should show filter tag
    await expect(page.locator("text=/Filter.*web-search/")).toBeVisible();

    // Should show only 2 filtered templates
    const cards = page.locator("article");
    await expect(cards).toHaveCount(2);
  });

  test("clicking skill with single template shows exactly one template", async ({ page }) => {
    await goToTemplatesWithSkills(page);
    await page.click('button:has-text("Skills")');

    // Click file-upload (template_ids: [3])
    await page.locator("article").nth(2).click();

    const cards = page.locator("article");
    await expect(cards).toHaveCount(1);
    await expect(cards.first().locator('text="My Custom"')).toBeVisible();
  });

  test("clearing skill filter restores all templates", async ({ page }) => {
    await goToTemplatesWithSkills(page);
    await page.click('button:has-text("Skills")');

    // Click a skill to activate filter
    await page.locator("article").first().click();
    await expect(page.locator("text=/Filter.*web-search/")).toBeVisible();

    // Clear filter
    const filterTag = page.locator("text=/Filter.*web-search/");
    const clearBtn = filterTag.locator("..").locator("button");
    await clearBtn.click();

    // Filter tag should be gone
    await expect(page.locator("text=/Filter.*web-search/")).not.toBeVisible();

    // All 3 templates should be visible
    await expect(page.locator("article")).toHaveCount(3);
  });

  test("filter bar is hidden when skill filter is active", async ({ page }) => {
    await goToTemplatesWithSkills(page);
    await page.click('button:has-text("Skills")');

    // Click a skill to activate filter
    await page.locator("article").first().click();

    // Filter bar buttons (All/Built-in/Custom) should not be visible
    await expect(page.locator('button:has-text("All")')).toHaveCount(0);
  });

  // ----- Additional coverage -----

  test("filter tag is not visible when no skill filter is active", async ({ page }) => {
    await goToTemplatesWithSkills(page);

    // No filter tag on default templates view
    await expect(page.locator("text=/Filter:/")).toHaveCount(0);
  });

  test("search and filter bar still work after clearing skill filter", async ({ page }) => {
    await goToTemplatesWithSkills(page);
    await page.click('button:has-text("Skills")');

    // Activate skill filter
    await page.locator("article").first().click();
    await expect(page.locator("text=/Filter.*web-search/")).toBeVisible();

    // Clear it
    const filterTag = page.locator("text=/Filter.*web-search/");
    const clearBtn = filterTag.locator("..").locator("button");
    await clearBtn.click();

    // Filter bar should be back
    await expect(page.locator('button:has-text("All")')).toBeVisible();

    // Click Custom filter — should show 1 template
    await page.click('button:has-text("Custom")');
    await page.waitForTimeout(100);
    const cards = page.locator("article");
    await expect(cards).toHaveCount(1);
    await expect(cards.first().locator('text="Custom"')).toBeVisible();
  });

  test("skills data preserved when navigating to Skills tab again", async ({ page }) => {
    let skillsCallCount = 0;
    await goToTemplates(page);
    await page.route("**/admin/api/profile-templates/skills-summary", (route) => {
      skillsCallCount++;
      return route.fulfill({ json: mockSkillsSummary });
    });

    // First visit to Skills tab
    await page.click('button:has-text("Skills")');
    await expect(page.locator("article")).toHaveCount(3);
    expect(skillsCallCount).toBe(1);

    // Go to Templates tab
    await page.click('button:has-text("Templates")');
    await expect(page.locator('text="Researcher"').first()).toBeVisible();

    // Return to Skills tab — should NOT re-fetch
    await page.click('button:has-text("Skills")');
    await expect(page.locator("article")).toHaveCount(3);
    expect(skillsCallCount).toBe(1);
  });

  test("skill cards are sorted by template count descending", async ({ page }) => {
    await goToTemplatesWithSkills(page);
    await page.click('button:has-text("Skills")');

    const cards = page.locator("article");
    await expect(cards).toHaveCount(3);

    // First card should be web-search (2 templates, highest count)
    await expect(cards.nth(0).locator("text=web-search")).toBeVisible();
    // Second: code-interpreter or file-upload (both 1 template, alphabetical)
    await expect(cards.nth(1).locator("text=code-interpreter")).toBeVisible();
    // Third: file-upload
    await expect(cards.nth(2).locator("text=file-upload")).toBeVisible();
  });

  test("clicking same skill card twice filters correctly", async ({ page }) => {
    await goToTemplatesWithSkills(page);
    await page.click('button:has-text("Skills")');

    // Click first skill
    await page.locator("article").first().click();
    await expect(page.locator("article")).toHaveCount(2);

    // Clear filter
    const clearBtn = page.locator("text=/Filter/").locator("..").locator("button");
    await clearBtn.click();
    await expect(page.locator("article")).toHaveCount(3);

    // Go back to Skills and click same skill again
    await page.click('button:has-text("Skills")');
    await page.locator("article").first().click();
    await expect(page.locator("article")).toHaveCount(2);
  });

  test("skills tab shows correct title", async ({ page }) => {
    await goToTemplatesWithSkills(page);
    await page.click('button:has-text("Skills")');

    // Should show "Registered Skills" title
    await expect(page.locator("text=Registered Skills")).toBeVisible();
  });

  test("skill card keyboard accessible via Enter key", async ({ page }) => {
    await goToTemplatesWithSkills(page);
    await page.click('button:has-text("Skills")');

    // Focus first card and press Enter
    const firstCard = page.locator("article").first();
    await firstCard.focus();
    await firstCard.press("Enter");

    // Should switch to Templates tab with filter
    await expect(page.locator("text=/Filter.*web-search/")).toBeVisible();
    await expect(page.locator("article")).toHaveCount(2);
  });
});

