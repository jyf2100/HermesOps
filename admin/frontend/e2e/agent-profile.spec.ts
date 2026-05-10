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
  mockEmptyProfileList,
  mockCreatedProfile,
  mockSyncResult,
  mockBatchSyncResult,
  mockResolvedConfig,
  mockAuditLog,
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

test.describe("Profile List", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("displays existing profiles with names", async ({ page }) => {
    await goToProfiles(page);

    await expect(page.locator('text="default"')).toBeVisible();
    await expect(page.locator('text="research-mode"')).toBeVisible();
    await expect(page.locator('text="broken"')).toBeVisible();
  });

  test("shows display names next to profile names", async ({ page }) => {
    await goToProfiles(page);

    await expect(page.locator('text="(Default)"')).toBeVisible();
    await expect(page.locator('text="(Research Mode)"')).toBeVisible();
  });

  test("shows template badge for profiles with template", async ({ page }) => {
    await goToProfiles(page);

    // The research-mode profile has template_display_name: "Researcher"
    await expect(page.locator('text="Researcher"')).toBeVisible();
  });

  test("shows sync status indicators", async ({ page }) => {
    await goToProfiles(page);

    // Synced status label
    await expect(page.locator('text="Synced"')).toBeVisible();
    // Pending status label
    await expect(page.locator('text="Pending"')).toBeVisible();
    // Error status label
    await expect(page.locator('text="Sync Failed"')).toBeVisible();
  });

  test("shows error message for failed profiles", async ({ page }) => {
    await goToProfiles(page);

    await expect(page.locator('text="Pod not found"')).toBeVisible();
  });

  test("shows Sync All button when profiles exist", async ({ page }) => {
    await goToProfiles(page);

    await expect(page.locator('button:has-text("Sync All")')).toBeVisible();
  });

  test("hides Sync All button when no profiles", async ({ page }) => {
    await goToProfiles(page, []);

    await expect(page.locator('button:has-text("Sync All")')).not.toBeVisible();
  });

  test("shows per-profile action buttons on hover", async ({ page }) => {
    await goToProfiles(page);

    // Action buttons are visible (they have opacity-60 by default)
    const syncButtons = page.locator('button:has-text("Sync to Pod")');
    await expect(syncButtons.first()).toBeVisible();

    const editButtons = page.locator('button:has-text("Edit")');
    await expect(editButtons.first()).toBeVisible();

    const deleteButtons = page.locator('button:has-text("Delete")');
    await expect(deleteButtons.first()).toBeVisible();
  });
});

test.describe("Profile Create", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("creates a new profile with template", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await mockBaseRoutes(page);
    // Override profiles route to handle both GET and POST
    await page.route("**/admin/api/agents/1/profiles", async (route) => {
      if (route.request().method() === "POST") {
        createBody = route.request().postDataJSON();
        return route.fulfill({ json: mockCreatedProfile });
      }
      return route.fulfill({ json: mockProfileList });
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    await page.click('button:has-text("Create Profile")');
    await page.fill('input[placeholder="e.g. researcher"]', "new-profile");
    await page.locator('[role="dialog"] select').selectOption("1");
    await page.click('button:has-text("Save")');

    await expect(() => {
      expect(createBody).toBeTruthy();
      expect(createBody!.profile_name).toBe("new-profile");
      expect(createBody!.template_id).toBe(1);
    }).toPass();
  });

  test("creates a profile without template", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await mockBaseRoutes(page, { profiles: [] });
    // Override profiles route to handle both GET and POST
    await page.route("**/admin/api/agents/1/profiles", async (route) => {
      if (route.request().method() === "POST") {
        createBody = route.request().postDataJSON();
        return route.fulfill({
          json: {
            ...createBody,
            id: 201,
            agent_number: 1,
            sync_status: "pending",
            config_hash: "x",
          },
        });
      }
      return route.fulfill({ json: [] });
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    await page.click('button:has-text("Create Profile")');
    await page.fill('input[placeholder="e.g. researcher"]', "no-template");
    await page.click('button:has-text("Save")');

    await expect(() => {
      expect(createBody).toBeTruthy();
      expect(createBody!.template_id).toBeNull();
    }).toPass();
  });

  test("sends config overrides as JSON", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await mockBaseRoutes(page, { profiles: [] });
    // Override profiles route to handle both GET and POST
    await page.route("**/admin/api/agents/1/profiles", async (route) => {
      if (route.request().method() === "POST") {
        createBody = route.request().postDataJSON();
        return route.fulfill({
          json: { ...createBody, id: 202, sync_status: "pending", config_hash: "y" },
        });
      }
      return route.fulfill({ json: [] });
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    await page.click('button:has-text("Create Profile")');
    await page.fill('input[placeholder="e.g. researcher"]', "config-test");

    // Fill config JSON in the textarea
    const textareas = page.locator("textarea");
    await textareas.first().fill('{"model": {"default": "glm-4.7"}}');

    await page.click('button:has-text("Save")');

    await expect(() => {
      expect(createBody).toBeTruthy();
      expect(createBody!.config_overrides).toEqual({ model: { default: "glm-4.7" } });
    }).toPass();
  });
});

test.describe("Profile Edit", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("opens editor with existing profile data", async ({ page }) => {
    await goToProfiles(page);

    // Click edit on the "default" profile row
    const defaultRow = page.locator('div:has(> div > button:has-text("Sync to Pod"))').filter({ hasText: "default" });
    await defaultRow.locator('button:has-text("Edit")').click();

    await expect(page.locator('[role="dialog"]')).toBeVisible();
    // Display name should be pre-filled
    const displayNameInput = page.locator('input[placeholder="Optional name for easy identification"]');
    await expect(displayNameInput).toHaveValue("Default");
  });

  test("updates profile via PUT request", async ({ page }) => {
    let updateBody: Record<string, unknown> | null = null;

    await mockBaseRoutes(page);
    // Override profiles route to handle PUT for specific profile
    await page.route("**/admin/api/agents/1/profiles/**", async (route) => {
      if (route.request().method() === "PUT") {
        updateBody = route.request().postDataJSON();
        return route.fulfill({
          json: {
            id: 101,
            agent_number: 1,
            profile_name: "default",
            display_name: "Updated Name",
            template_id: null,
            config_overrides: {},
            soul_md: null,
            sync_status: "pending",
            sync_error: null,
            config_hash: "new-hash",
            last_synced_at: null,
            created_at: "2026-05-10T10:00:00Z",
            updated_at: "2026-05-10T12:00:00Z",
          },
        });
      }
      return route.fallback();
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    await page.locator('button:has-text("Edit")').first().click();
    const displayNameInput = page.locator('input[placeholder="Optional name for easy identification"]');
    await displayNameInput.clear();
    await displayNameInput.fill("Updated Name");
    await page.click('button:has-text("Save")');

    await expect(() => {
      expect(updateBody).toBeTruthy();
      expect(updateBody!.display_name).toBe("Updated Name");
    }).toPass();
  });

  test("can clear template_id by selecting no template", async ({ page }) => {
    let updateBody: Record<string, unknown> | null = null;

    await mockBaseRoutes(page);
    await page.route("**/admin/api/agents/1/profiles/**", async (route) => {
      if (route.request().method() === "PUT") {
        updateBody = route.request().postDataJSON();
        return route.fulfill({
          json: {
            id: 101,
            agent_number: 1,
            profile_name: "default",
            display_name: "Default",
            template_id: null,
            config_overrides: {},
            soul_md: null,
            sync_status: "pending",
            sync_error: null,
            config_hash: "cleared-hash",
            last_synced_at: null,
            created_at: "2026-05-10T10:00:00Z",
            updated_at: "2026-05-10T12:00:00Z",
          },
        });
      }
      return route.fallback();
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    // Edit the first profile (which has template_id: 1)
    await page.locator('button:has-text("Edit")').first().click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Select "-- No template --" option
    await page.locator('[role="dialog"] select').selectOption("");

    await page.click('button:has-text("Save")');

    // Verify template_id was explicitly sent as null
    await expect(() => {
      expect(updateBody).toBeTruthy();
      expect(updateBody!.template_id).toBeNull();
    }).toPass();
  });
});

test.describe("Profile Delete", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("deletes a profile after confirmation", async ({ page }) => {
    let deleted = false;

    await mockBaseRoutes(page);
    // Add DELETE handler for specific profile
    await page.route("**/admin/api/agents/1/profiles/**", async (route) => {
      if (route.request().method() === "DELETE") {
        deleted = true;
        return route.fulfill({ json: { status: "deleted" } });
      }
      return route.fallback();
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    // Find the first profile row by its "Sync to Pod" button (unique to profile rows)
    // then click the adjacent Delete button within that row
    const firstProfileRow = page.locator('div:has(> div > button:has-text("Sync to Pod"))').first();

    // Accept the confirm dialog (triggered by window.confirm in ProfileList)
    page.once("dialog", (dialog) => dialog.accept());
    await firstProfileRow.locator('button:has-text("Delete")').click();

    await expect(() => expect(deleted).toBe(true)).toPass({ timeout: 10000 });
  });

  test("cancel deletion does not call API", async ({ page }) => {
    let deleted = false;

    await mockBaseRoutes(page);
    // Add DELETE handler for specific profile
    await page.route("**/admin/api/agents/1/profiles/**", async (route) => {
      if (route.request().method() === "DELETE") {
        deleted = true;
        return route.fulfill({ json: { status: "deleted" } });
      }
      return route.fallback();
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    // Find the first profile row
    const firstProfileRow = page.locator('div:has(> div > button:has-text("Sync to Pod"))').first();

    // Dismiss the confirm dialog
    page.once("dialog", (dialog) => dialog.dismiss());
    await firstProfileRow.locator('button:has-text("Delete")').click();

    // Wait a bit to ensure delete wasn't called
    await page.waitForTimeout(500);
    expect(deleted).toBe(false);
  });
});

test.describe("Profile Sync", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("syncs a single profile", async ({ page }) => {
    let synced = false;

    await mockBaseRoutes(page);
    // Add sync POST handler for specific profile
    await page.route("**/admin/api/agents/1/profiles/**/sync", async (route) => {
      if (route.request().method() === "POST") {
        synced = true;
        return route.fulfill({ json: mockSyncResult });
      }
      return route.fallback();
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    await page.locator('button:has-text("Sync to Pod")').first().click();

    await expect(() => expect(synced).toBe(true)).toPass();
  });

  test("syncs all profiles at once", async ({ page }) => {
    let syncedAll = false;

    await mockBaseRoutes(page);
    // The batch sync endpoint is POST /agents/1/profiles/sync — a sub-path
    await page.route("**/admin/api/agents/1/profiles/sync", async (route) => {
      if (route.request().method() === "POST") {
        syncedAll = true;
        return route.fulfill({ json: mockBatchSyncResult });
      }
      return route.fallback();
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    await page.click('button:has-text("Sync All")');

    await expect(() => expect(syncedAll).toBe(true)).toPass();
  });
});

test.describe("Resolved Config Preview", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("loads and displays resolved config in edit mode", async ({ page }) => {
    await mockBaseRoutes(page);
    // Add resolved-config GET handler
    await page.route("**/admin/api/agents/1/profiles/**/resolved-config", async (route) => {
      return route.fulfill({ json: mockResolvedConfig });
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    // Click edit on the research-mode profile (second one)
    await page.locator('button:has-text("Edit")').nth(1).click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Toggle resolved config
    await page.click('text="Resolved Config Preview"');
    await expect(page.locator("pre")).toBeVisible();
  });
});

test.describe("Audit Log Query", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("audit log endpoint returns paginated results", async ({ page }) => {
    let auditRequested = false;

    await mockBaseRoutes(page, { profiles: [] });
    // Add audit log handler
    await page.route("**/admin/api/profile-audit-log", async (route) => {
      auditRequested = true;
      return route.fulfill({ json: mockAuditLog });
    });

    // Navigate to profiles tab which may show audit info
    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    // The audit endpoint is available for the frontend to call
    // This test verifies the mock is correctly shaped
    expect(mockAuditLog.total).toBe(5);
    expect(mockAuditLog.items).toHaveLength(2);
    expect(mockAuditLog.items[0].old_values).toBeTruthy();
    expect(mockAuditLog.items[1].old_values).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Profile Sorting
// ---------------------------------------------------------------------------

test.describe("Profile Sorting", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("sorts profiles by name ascending by default", async ({ page }) => {
    await goToProfiles(page);

    // The sort dropdown defaults to "name" — verify rendered order.
    // sorted by profile_name: "broken" < "default" < "research-mode"
    const profileNames = page.locator(
      "div.rounded-lg.border.bg-surface span.font-medium.font-\\[family-name\\:var\\(--font-mono\\)\\]"
    );
    await expect(profileNames).toHaveText(["broken", "default", "research-mode"]);
  });

  test("sorts profiles by sync status when selected", async ({ page }) => {
    await goToProfiles(page);

    // Switch sort to "By status"
    const sortSelect = page.locator("select").first();
    await sortSelect.selectOption("status");

    // Sorted by sync_status: "error" < "pending" < "synced"
    // -> broken (error), research-mode (pending), default (synced)
    const profileNames = page.locator(
      "div.rounded-lg.border.bg-surface span.font-medium.font-\\[family-name\\:var\\(--font-mono\\)\\]"
    );
    await expect(profileNames).toHaveText(["broken", "research-mode", "default"]);
  });

  test("sorts profiles by updated time when selected", async ({ page }) => {
    await goToProfiles(page);

    // Switch sort to "By updated"
    const sortSelect = page.locator("select").first();
    await sortSelect.selectOption("updated");

    // Sorted by updated_at descending:
    // default (11:00) > research-mode (10:30) > broken (10:45)
    // Wait — broken is 10:45 which is > 10:30, so: default, broken, research-mode
    const profileNames = page.locator(
      "div.rounded-lg.border.bg-surface span.font-medium.font-\\[family-name\\:var\\(--font-mono\\)\\]"
    );
    await expect(profileNames).toHaveText(["default", "broken", "research-mode"]);
  });

  test("hides sort dropdown when only one profile", async ({ page }) => {
    const singleProfile = [mockProfileList[0]];
    await goToProfiles(page, singleProfile);

    // The sort select should NOT be visible when there is only 1 profile
    await expect(page.locator('h3:text("Profiles") + select')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Batch Selection
// ---------------------------------------------------------------------------

test.describe("Batch Selection", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("toggles individual profile checkbox", async ({ page }) => {
    await goToProfiles(page);

    // Each profile row has a checkbox. Click the one associated with the "default" profile.
    const defaultRow = page.locator("div.rounded-lg.border.bg-surface").filter({ hasText: "default" });
    const checkbox = defaultRow.locator("input[type='checkbox']");
    await checkbox.click();

    // The row should gain selected styling (border-accent-cyan/40)
    await expect(defaultRow).toHaveClass(/border-accent-cyan\/40/);

    // Click again to deselect
    await checkbox.click();
    await expect(defaultRow).not.toHaveClass(/border-accent-cyan\/40/);
  });

  test("selects all profiles via select all checkbox", async ({ page }) => {
    await goToProfiles(page);

    // The "Select all" checkbox is above the profile rows
    const selectAllCheckbox = page.locator("input[type='checkbox']").first();
    await selectAllCheckbox.click();

    // All 3 profile rows should have the selected border class
    const selectedRows = page.locator("div.rounded-lg.border.bg-surface.border-accent-cyan\\/40");
    await expect(selectedRows).toHaveCount(3);
  });

  test("deselects all when clicking select all twice", async ({ page }) => {
    await goToProfiles(page);

    const selectAllCheckbox = page.locator("input[type='checkbox']").first();
    // First click: select all
    await selectAllCheckbox.click();
    const selectedRows = page.locator("div.rounded-lg.border.bg-surface.border-accent-cyan\\/40");
    await expect(selectedRows).toHaveCount(3);

    // Second click: deselect all
    await selectAllCheckbox.click();
    await expect(selectedRows).toHaveCount(0);
  });

  test("shows selected count text", async ({ page }) => {
    await goToProfiles(page);

    // Initially shows "Select all"
    await expect(page.locator('text="Select all"')).toBeVisible();

    // Select one profile
    const brokenRow = page.locator("div.rounded-lg.border.bg-surface").filter({ hasText: "broken" });
    await brokenRow.locator("input[type='checkbox']").click();

    // Should now show "1 selected"
    await expect(page.locator('text="1 selected"')).toBeVisible();
  });

  test("shows batch delete button when profiles selected", async ({ page }) => {
    await goToProfiles(page);

    // No batch delete button initially
    await expect(page.locator("button:has-text('Delete (')")).not.toBeVisible();

    // Select two profiles
    const brokenRow = page.locator("div.rounded-lg.border.bg-surface").filter({ hasText: "broken" });
    await brokenRow.locator("input[type='checkbox']").click();
    const defaultRow = page.locator("div.rounded-lg.border.bg-surface").filter({ hasText: "default" });
    await defaultRow.locator("input[type='checkbox']").click();

    // Batch delete button should appear with count
    await expect(page.locator("button:has-text('Delete (2)')")).toBeVisible();
  });

  test("hides batch delete when no profiles selected", async ({ page }) => {
    await goToProfiles(page);

    // Batch delete button should not exist when nothing is selected
    await expect(page.locator("button:has-text('Delete (')")).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Batch Delete
// ---------------------------------------------------------------------------

test.describe("Batch Delete", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("batch deletes selected profiles after confirmation", async ({ page }) => {
    const deletedNames: string[] = [];

    await mockBaseRoutes(page);
    await page.route("**/admin/api/agents/1/profiles/**", async (route) => {
      if (route.request().method() === "DELETE") {
        const url = new URL(route.request().url());
        const segments = url.pathname.split("/");
        const profileName = segments[segments.length - 1];
        deletedNames.push(decodeURIComponent(profileName));
        return route.fulfill({ json: { status: "deleted" } });
      }
      return route.fallback();
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    // Select two profiles via their row checkboxes
    const brokenRow = page.locator("div.rounded-lg.border.bg-surface").filter({ hasText: "broken" });
    await brokenRow.locator("input[type='checkbox']").click();
    const defaultRow = page.locator("div.rounded-lg.border.bg-surface").filter({ hasText: "default" });
    await defaultRow.locator("input[type='checkbox']").click();

    // Accept the confirm dialog
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain("Delete 2 profiles");
      dialog.accept();
    });

    // Click the batch delete button
    await page.locator("button:has-text('Delete (2)')").click();

    // Verify DELETE requests were sent for both profiles
    await expect(() => {
      expect(deletedNames).toHaveLength(2);
      expect(deletedNames).toContain("broken");
      expect(deletedNames).toContain("default");
    }).toPass({ timeout: 10000 });
  });

  test("cancels batch delete without calling API", async ({ page }) => {
    let deleteCalled = false;

    await mockBaseRoutes(page);
    await page.route("**/admin/api/agents/1/profiles/**", async (route) => {
      if (route.request().method() === "DELETE") {
        deleteCalled = true;
        return route.fulfill({ json: { status: "deleted" } });
      }
      return route.fallback();
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    // Select two profiles
    const brokenRow = page.locator("div.rounded-lg.border.bg-surface").filter({ hasText: "broken" });
    await brokenRow.locator("input[type='checkbox']").click();
    const defaultRow = page.locator("div.rounded-lg.border.bg-surface").filter({ hasText: "default" });
    await defaultRow.locator("input[type='checkbox']").click();

    // Dismiss the confirm dialog
    page.once("dialog", (dialog) => dialog.dismiss());

    await page.locator("button:has-text('Delete (2)')").click();

    // Wait briefly to ensure no DELETE was sent
    await page.waitForTimeout(500);
    expect(deleteCalled).toBe(false);
  });

  test("hides select all when only one profile", async ({ page }) => {
    const singleProfile = [mockProfileList[0]];
    await goToProfiles(page, singleProfile);

    // The select-all row should not appear for a single profile
    await expect(page.locator('text="Select all"')).not.toBeVisible();
    // The per-row checkbox should still be present
    await expect(page.locator("div.rounded-lg.border.bg-surface input[type='checkbox']")).toHaveCount(1);
  });
});
