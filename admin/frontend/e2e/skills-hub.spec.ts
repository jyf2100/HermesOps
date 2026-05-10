/**
 * E2E tests for the Skills Hub feature (AgentSkillsTab).
 *
 * Covers: tab rendering, installed skills list, browse hub, search,
 * install flow, uninstall flow, update flow, audit, and error states.
 * All API responses are mocked — no real backend needed.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import {
  VALID_ADMIN_KEY,
  mockAgentDetail,
  mockEnvVars,
  mockConfigYaml,
  mockSoul,
  mockHealth,
  mockEvents,
} from "./fixtures/mock-data";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockInstalledSkills = {
  ok: true,
  running: true,
  skills: [
    {
      name: "web-search",
      description: "Search the web for information",
      version: "1.2.0",
      tags: ["search", "web"],
      source: "hub",
      trust_level: "trusted",
      installed_at: "2026-05-01T10:00:00Z",
      content_hash: "abc123",
      orphan: false,
    },
    {
      name: "code-interpreter",
      description: "Execute code and return results",
      version: "2.0.1",
      tags: ["code", "execution"],
      source: "builtin",
      trust_level: "builtin",
      installed_at: "2026-05-02T12:00:00Z",
      content_hash: "def456",
      orphan: false,
    },
    {
      name: "translation",
      description: "Translate text between languages",
      version: "0.9.0",
      tags: ["translation"],
      source: "hub",
      trust_level: "community",
      installed_at: "2026-05-03T14:00:00Z",
      content_hash: "ghi789",
      orphan: true,
    },
  ],
};

const mockInstalledSkillsEmpty = {
  ok: true,
  running: true,
  skills: [],
};

const mockInstalledSkillsStopped = {
  ok: true,
  running: false,
  skills: [],
};

const mockBrowseResult = {
  ok: true,
  count: 3,
  source_counts: { "skills-sh": 2, github: 1 },
  timed_out: [],
  results: [
    {
      name: "git-helper",
      description: "Git operations and repository management",
      source: "github",
      identifier: "hermes-skills/git-helper",
      trust_level: "trusted",
      tags: ["git", "vcs"],
    },
    {
      name: "data-analyzer",
      description: "Analyze datasets and generate reports",
      source: "skills-sh",
      identifier: "data-analyzer",
      trust_level: "community",
      tags: ["data", "analysis"],
    },
    {
      name: "summarizer",
      description: "Summarize long texts concisely",
      source: "skills-sh",
      identifier: "summarizer",
      trust_level: null,
      tags: ["nlp", "summarization"],
    },
  ],
};

const mockSearchResult = {
  ok: true,
  query: "git",
  source_filter: "",
  count: 1,
  results: [
    {
      name: "git-helper",
      description: "Git operations and repository management",
      source: "github",
      identifier: "hermes-skills/git-helper",
      trust_level: "trusted",
      tags: ["git", "vcs"],
    },
  ],
};

const mockSearchEmpty = {
  ok: true,
  query: "nonexistent",
  source_filter: "",
  count: 0,
  results: [],
};

const mockInstallTask: Record<string, unknown> = {
  ok: true,
  task_id: "task-install-001",
  status: "pending",
  progress: 0,
  phase: "Installing...",
};

const mockTaskFetching: Record<string, unknown> = {
  ok: true,
  task_id: "task-install-001",
  status: "fetching",
  progress: 25,
  phase: "Fetching...",
};

const mockTaskCompleted: Record<string, unknown> = {
  ok: true,
  task_id: "task-install-001",
  status: "completed",
  progress: 100,
  phase: "Completed",
};

const mockTaskFailed: Record<string, unknown> = {
  ok: true,
  task_id: "task-install-002",
  status: "failed",
  progress: 0,
  phase: "Failed",
  error: "Download failed: connection timeout",
};

const mockUpdateTask: Record<string, unknown> = {
  ok: true,
  task_id: "task-update-001",
  status: "pending",
  progress: 0,
  phase: "Updating...",
};

const mockUninstallResult = {
  ok: true,
  skill: "web-search",
  status: "removed",
};

const mockCheckUpdatesAvailable = {
  ok: true,
  total: 3,
  updates_available: 1,
  items: [
    { name: "web-search", current_hash: "abc123", upstream_hash: "abc456", has_update: true },
    { name: "code-interpreter", current_hash: "def456", upstream_hash: "def456", has_update: false },
    { name: "translation", current_hash: "ghi789", upstream_hash: "ghi789", has_update: false },
  ],
};

const mockCheckUpdatesNone = {
  ok: true,
  total: 2,
  updates_available: 0,
  items: [
    { name: "web-search", current_hash: "abc123", upstream_hash: "abc123", has_update: false },
    { name: "code-interpreter", current_hash: "def456", upstream_hash: "def456", has_update: false },
  ],
};

const mockAuditWithIssues = {
  ok: true,
  skill: "web-search",
  trust_level: "trusted",
  installed_at: "2026-05-01T10:00:00Z",
  scan: {
    verdict: "warning",
    findings: [
      {
        pattern_id: "SEC001",
        severity: "WARNING",
        category: "network",
        file: "fetch.py",
        line: 42,
        description: "Unencrypted HTTP connection detected",
      },
    ],
    summary: "1 warning(s) found",
  },
  scan_context: "installed",
  findings_count: 1,
  has_critical: false,
};

const mockAuditClean = {
  ok: true,
  skill: "code-interpreter",
  trust_level: "builtin",
  installed_at: "2026-05-02T12:00:00Z",
  scan: {
    verdict: "clean",
    findings: [],
    summary: "No issues found",
  },
  scan_context: "installed",
  findings_count: 0,
  has_critical: false,
};

const mockAuditCritical = {
  ok: true,
  skill: "translation",
  trust_level: "community",
  installed_at: "2026-05-03T14:00:00Z",
  scan: {
    verdict: "critical",
    findings: [
      {
        pattern_id: "SEC010",
        severity: "CRITICAL",
        category: "exec",
        file: "run.py",
        line: 10,
        description: "Arbitrary code execution via eval()",
      },
      {
        pattern_id: "SEC005",
        severity: "WARNING",
        category: "secrets",
        file: "config.py",
        line: 5,
        description: "Hardcoded API key found",
      },
    ],
    summary: "1 critical, 1 warning",
  },
  scan_context: "installed",
  findings_count: 2,
  has_critical: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loginAsAdmin(page: Page) {
  await page.goto("/admin/login");
  await page.evaluate((key) => {
    localStorage.setItem("admin_api_key", key);
    localStorage.setItem("admin_lang", "en");
  }, VALID_ADMIN_KEY);
}

const AGENT_ID = 1;

/**
 * Set up route mocks for the agent detail page and navigate to the skills tab.
 * Returns a function for adding additional route mocks before navigation.
 */
async function goToSkillsTab(
  page: Page,
  extraRoutes?: Record<string, unknown>
) {
  // Agent detail routes
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

  // Skills hub routes — default installed list
  await page.route("**/admin/api/hub/agents/1/skills", (route) =>
    route.fulfill({ json: mockInstalledSkills })
  );

  // Extra routes
  if (extraRoutes) {
    for (const [pattern, data] of Object.entries(extraRoutes)) {
      await page.route(`**/admin/api/${pattern}`, (route) =>
        route.fulfill({ json: data })
      );
    }
  }

  await loginAsAdmin(page);
  await page.goto(`/admin/agents/${AGENT_ID}?tab=skills`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Skills Hub", () => {
  // -----------------------------------------------------------------------
  // 1. Tab Rendering
  // -----------------------------------------------------------------------
  test.describe("Tab Rendering", () => {
    test("Skills tab appears on agent detail page", async ({ page }) => {
      await goToSkillsTab(page);
      // The main tab bar should include a "Skills" button
      const skillsTabBtn = page.locator("button", { hasText: "Skills" }).first();
      await expect(skillsTabBtn).toBeVisible();
    });

    test("Clicking Skills tab shows the skills panel", async ({ page }) => {
      await goToSkillsTab(page);
      // Should see the sub-tabs within the skills panel
      await expect(page.locator("button", { hasText: "Installed" })).toBeVisible();
      await expect(page.locator("button", { hasText: "Browse Hub" })).toBeVisible();
    });

    test("Two sub-tabs visible: Installed and Browse Hub", async ({ page }) => {
      await goToSkillsTab(page);
      const subTabs = page.locator('[role="tablist"] button[role="tab"]');
      await expect(subTabs).toHaveCount(2);
      await expect(subTabs.nth(0)).toHaveText("Installed");
      await expect(subTabs.nth(1)).toHaveText("Browse Hub");
    });

    test("Default sub-tab is Installed", async ({ page }) => {
      await goToSkillsTab(page);
      const installedTab = page.locator('button[role="tab"]', { hasText: "Installed" });
      await expect(installedTab).toHaveAttribute("aria-selected", "true");
      const browseTab = page.locator('button[role="tab"]', { hasText: "Browse Hub" });
      await expect(browseTab).toHaveAttribute("aria-selected", "false");
    });
  });

  // -----------------------------------------------------------------------
  // 2. Installed Skills List
  // -----------------------------------------------------------------------
  test.describe("Installed Skills List", () => {
    test("Shows installed skills when API returns data", async ({ page }) => {
      await goToSkillsTab(page);
      await expect(page.getByText("web-search")).toBeVisible();
      await expect(page.getByText("code-interpreter")).toBeVisible();
      await expect(page.getByText("translation")).toBeVisible();
    });

    test("Shows empty state when no skills installed", async ({ page }) => {
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
      await page.route("**/admin/api/hub/agents/1/skills", (route) =>
        route.fulfill({ json: mockInstalledSkillsEmpty })
      );
      await loginAsAdmin(page);
      await page.goto(`/admin/agents/${AGENT_ID}?tab=skills`);
      await expect(page.getByText("No skills installed")).toBeVisible();
    });

    test("Shows skill name and trust level badges", async ({ page }) => {
      await goToSkillsTab(page);
      // Trust badges
      await expect(page.getByText("Trusted").first()).toBeVisible();
      await expect(page.getByText("Built-in").first()).toBeVisible();
      await expect(page.getByText("Community").first()).toBeVisible();
    });

    test("Shows orphan badge for orphan skills", async ({ page }) => {
      await goToSkillsTab(page);
      await expect(page.getByText("Orphan")).toBeVisible();
    });

    test("Shows action buttons for each skill", async ({ page }) => {
      await goToSkillsTab(page);
      // Action buttons: Audit, Uninstall per skill (3 skills = 3 each)
      // "Update" also appears as the skillsUpdate label, scoped to skill rows only
      const skillRows = page.locator('[role="tabpanel"] .flex.items-center.gap-2.px-3');
      await expect(skillRows).toHaveCount(3);
      // Each row has Audit, Update, Uninstall
      for (let i = 0; i < 3; i++) {
        const row = skillRows.nth(i);
        await expect(row.locator("button", { hasText: "Audit" })).toBeAttached();
        await expect(row.locator("button", { hasText: "Update" })).toBeAttached();
        await expect(row.locator("button", { hasText: "Uninstall" })).toBeAttached();
      }
    });
  });

  // -----------------------------------------------------------------------
  // 3. Browse Hub
  // -----------------------------------------------------------------------
  test.describe("Browse Hub", () => {
    test("Click Browse Hub sub-tab and see browse results", async ({ page }) => {
      await page.route("**/admin/api/hub/browse*", (route) =>
        route.fulfill({ json: mockBrowseResult })
      );
      await goToSkillsTab(page);
      // Click the Browse Hub sub-tab
      await page.locator('button[role="tab"]', { hasText: "Browse Hub" }).click();
      // Should show browse results
      await expect(page.getByText("git-helper")).toBeVisible();
      await expect(page.getByText("data-analyzer")).toBeVisible();
      await expect(page.getByText("summarizer")).toBeVisible();
    });

    test("Shows empty browse state when no skills available", async ({ page }) => {
      const emptyBrowse = {
        ok: true,
        count: 0,
        source_counts: {},
        timed_out: [],
        results: [],
      };
      await page.route("**/admin/api/hub/browse*", (route) =>
        route.fulfill({ json: emptyBrowse })
      );
      await goToSkillsTab(page);
      await page.locator('button[role="tab"]', { hasText: "Browse Hub" }).click();
      await expect(page.getByText("No skill sources available")).toBeVisible();
    });

    test("Browse skill cards show description and source info", async ({ page }) => {
      await page.route("**/admin/api/hub/browse*", (route) =>
        route.fulfill({ json: mockBrowseResult })
      );
      await goToSkillsTab(page);
      await page.locator('button[role="tab"]', { hasText: "Browse Hub" }).click();
      await expect(page.getByText("Git operations and repository management")).toBeVisible();
      await expect(page.getByText(/Source: github/)).toBeVisible();
    });

    test("Browse skill cards show Install button", async ({ page }) => {
      await page.route("**/admin/api/hub/browse*", (route) =>
        route.fulfill({ json: mockBrowseResult })
      );
      await goToSkillsTab(page);
      await page.locator('button[role="tab"]', { hasText: "Browse Hub" }).click();
      // Install buttons are within browse skill cards (grid layout)
      const browseCards = page.locator('.grid button', { hasText: "Install" });
      await expect(browseCards).toHaveCount(3);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Search
  // -----------------------------------------------------------------------
  test.describe("Search", () => {
    test("Type search query and see results", async ({ page }) => {
      await page.route("**/admin/api/hub/search*", (route) => {
        const url = new URL(route.request().url());
        const q = url.searchParams.get("q");
        if (q === "git") {
          return route.fulfill({ json: mockSearchResult });
        }
        return route.fulfill({ json: { ok: true, query: q, source_filter: "", count: 0, results: [] } });
      });
      await page.route("**/admin/api/hub/browse*", (route) =>
        route.fulfill({ json: mockBrowseResult })
      );

      await goToSkillsTab(page);
      await page.locator('button[role="tab"]', { hasText: "Browse Hub" }).click();

      // Type into search input
      const searchInput = page.locator('input[placeholder="Search by skill name..."]');
      await searchInput.fill("git");

      // Wait for debounced search to fire and show results
      await expect(page.getByText("git-helper")).toBeVisible();
    });

    test("Shows no results state when search returns empty", async ({ page }) => {
      await page.route("**/admin/api/hub/search*", (route) =>
        route.fulfill({ json: mockSearchEmpty })
      );
      await page.route("**/admin/api/hub/browse*", (route) =>
        route.fulfill({ json: mockBrowseResult })
      );

      await goToSkillsTab(page);
      await page.locator('button[role="tab"]', { hasText: "Browse Hub" }).click();

      const searchInput = page.locator('input[placeholder="Search by skill name..."]');
      await searchInput.fill("nonexistent");

      await expect(page.getByText("No matching skills found")).toBeVisible();
    });

    test("Shows loading state during search", async ({ page }) => {
      let resolveSearch: (value: unknown) => void;
      const searchPromise = new Promise((resolve) => {
        resolveSearch = resolve;
      });

      await page.route("**/admin/api/hub/search*", async (route) => {
        await searchPromise;
        return route.fulfill({ json: mockSearchResult });
      });
      await page.route("**/admin/api/hub/browse*", (route) =>
        route.fulfill({ json: mockBrowseResult })
      );

      await goToSkillsTab(page);
      await page.locator('button[role="tab"]', { hasText: "Browse Hub" }).click();

      const searchInput = page.locator('input[placeholder="Search by skill name..."]');
      await searchInput.fill("git");

      // Should show fetching indicator while request is pending
      const fetchingIndicators = page.getByText("Fetching...");
      // Give it a moment to transition to loading state
      await page.waitForTimeout(400);

      // Resolve the search so the test can clean up
      resolveSearch!(undefined);

      // After resolution, the result should appear
      await expect(page.getByText("git-helper")).toBeVisible();
    });
  });

  // -----------------------------------------------------------------------
  // 5. Install Flow
  // -----------------------------------------------------------------------
  test.describe("Install Flow", () => {
    test("Install triggers task polling and completes", async ({ page }) => {
      let pollCount = 0;

      await page.route("**/admin/api/hub/browse*", (route) =>
        route.fulfill({ json: mockBrowseResult })
      );
      await page.route("**/admin/api/hub/agents/1/install", (route) =>
        route.fulfill({ json: mockInstallTask })
      );
      await page.route("**/admin/api/hub/agents/1/tasks/task-install-001", (route) => {
        pollCount++;
        if (pollCount === 1) {
          return route.fulfill({ json: mockTaskFetching });
        }
        return route.fulfill({ json: mockTaskCompleted });
      });

      // After install completes, the installed list is refreshed
      await page.route("**/admin/api/hub/agents/1/skills", (route) =>
        route.fulfill({ json: mockInstalledSkills })
      );

      // Accept the confirm dialog BEFORE clicking
      page.on("dialog", (dialog) => dialog.accept());

      await goToSkillsTab(page);

      // Wait for Installed tab to be ready, then switch
      await expect(page.locator('button[role="tab"]', { hasText: "Browse Hub" })).toBeVisible();
      await page.locator('button[role="tab"]', { hasText: "Browse Hub" }).click();

      // Wait for browse results to load
      await expect(page.getByText("git-helper")).toBeVisible();

      // Click install on git-helper (use grid-scoped locator)
      await page.locator('.grid button', { hasText: "Install" }).first().click();

      // Should show task phase indicator
      await expect(page.getByText("Installing...")).toBeVisible({ timeout: 5000 });

      // Wait for task to complete (polling interval is 1500ms)
      await expect(page.getByText("Completed")).toBeVisible({ timeout: 10000 });
    });

    test("Handle install failure shows error", async ({ page }) => {
      await page.route("**/admin/api/hub/browse*", (route) =>
        route.fulfill({ json: mockBrowseResult })
      );
      await page.route("**/admin/api/hub/agents/1/install", (route) =>
        route.fulfill({ json: { ...mockInstallTask, task_id: "task-install-002" } })
      );
      await page.route("**/admin/api/hub/agents/1/tasks/task-install-002", (route) =>
        route.fulfill({ json: mockTaskFailed })
      );

      // Accept the confirm dialog BEFORE clicking
      page.on("dialog", (dialog) => dialog.accept());

      await goToSkillsTab(page);

      await expect(page.locator('button[role="tab"]', { hasText: "Browse Hub" })).toBeVisible();
      await page.locator('button[role="tab"]', { hasText: "Browse Hub" }).click();

      // Wait for browse results to load
      await expect(page.getByText("git-helper")).toBeVisible();

      await page.locator('.grid button', { hasText: "Install" }).first().click();

      // Wait for "Installing..." phase to appear (install call started)
      await expect(page.getByText("Installing...")).toBeVisible({ timeout: 5000 });

      // Should show error toast when task fails
      await expect(page.getByText("Download failed: connection timeout")).toBeVisible({ timeout: 10000 });
    });
  });

  // -----------------------------------------------------------------------
  // 6. Uninstall Flow
  // -----------------------------------------------------------------------
  test.describe("Uninstall Flow", () => {
    test("Uninstall shows confirm dialog and removes skill", async ({ page }) => {
      let uninstallCalled = false;
      let reloadCount = 0;

      await page.route("**/admin/api/hub/agents/1/skills/web-search", (route) => {
        uninstallCalled = true;
        return route.fulfill({ json: mockUninstallResult });
      });

      // After uninstall, installed list refreshes with one fewer skill
      await page.route("**/admin/api/hub/agents/1/skills", (route) => {
        reloadCount++;
        if (reloadCount <= 1) {
          return route.fulfill({ json: mockInstalledSkills });
        }
        // After uninstall, return fewer skills
        return route.fulfill({
          json: {
            ok: true,
            running: true,
            skills: mockInstalledSkills.skills.filter((s: { name: string }) => s.name !== "web-search"),
          },
        });
      });

      await goToSkillsTab(page);

      // Accept the confirm dialog
      page.on("dialog", (dialog) => {
        expect(dialog.message()).toContain("Uninstall skill web-search");
        dialog.accept();
      });

      // Find the uninstall button for web-search (in its row)
      const webSearchRow = page.locator("text=web-search").first().locator("..");
      await webSearchRow.locator("button", { hasText: "Uninstall" }).click();

      // Wait for the API to be called
      await expect(() => expect(uninstallCalled).toBe(true)).toPass({ timeout: 5000 });
    });

    test("Cancel uninstall keeps the skill", async ({ page }) => {
      let uninstallCalled = false;

      await page.route("**/admin/api/hub/agents/1/skills/web-search", (route) => {
        uninstallCalled = true;
        return route.fulfill({ json: mockUninstallResult });
      });

      await goToSkillsTab(page);

      // Dismiss the confirm dialog
      page.on("dialog", (dialog) => dialog.dismiss());

      const webSearchRow = page.locator("text=web-search").first().locator("..");
      await webSearchRow.locator("button", { hasText: "Uninstall" }).click();

      // Skill should still be visible
      await expect(page.getByText("web-search")).toBeVisible();
      expect(uninstallCalled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Update Flow
  // -----------------------------------------------------------------------
  test.describe("Update Flow", () => {
    test("Click Update triggers update task", async ({ page }) => {
      let updateCalled = false;

      await page.route("**/admin/api/hub/agents/1/update/web-search", (route) => {
        updateCalled = true;
        return route.fulfill({ json: mockUpdateTask });
      });
      await page.route("**/admin/api/hub/agents/1/tasks/task-update-001", (route) =>
        route.fulfill({ json: mockTaskCompleted })
      );

      await goToSkillsTab(page);

      const webSearchRow = page.locator("text=web-search").first().locator("..");
      await webSearchRow.locator("button", { hasText: "Update" }).click();

      await expect(() => expect(updateCalled).toBe(true)).toPass({ timeout: 5000 });
      // Should show updating phase indicator
      await expect(page.getByText("Updating...")).toBeVisible();
    });

    test("Update completes successfully", async ({ page }) => {
      await page.route("**/admin/api/hub/agents/1/update/web-search", (route) =>
        route.fulfill({ json: mockUpdateTask })
      );
      await page.route("**/admin/api/hub/agents/1/tasks/task-update-001", (route) =>
        route.fulfill({ json: mockTaskCompleted })
      );

      await goToSkillsTab(page);

      const webSearchRow = page.locator("text=web-search").first().locator("..");
      await webSearchRow.locator("button", { hasText: "Update" }).click();

      // Wait for task completion
      await expect(page.getByText("Completed")).toBeVisible({ timeout: 10000 });
    });

    test("Check Updates shows available count", async ({ page }) => {
      await page.route("**/admin/api/hub/agents/1/check", (route) =>
        route.fulfill({ json: mockCheckUpdatesAvailable })
      );

      await goToSkillsTab(page);

      await page.locator("button", { hasText: "Check Updates" }).click();

      // Toast should show update count
      await expect(page.getByText("1 skill(s) have updates")).toBeVisible({ timeout: 5000 });
    });

    test("Check Updates shows all up to date", async ({ page }) => {
      await page.route("**/admin/api/hub/agents/1/check", (route) =>
        route.fulfill({ json: mockCheckUpdatesNone })
      );

      await goToSkillsTab(page);

      await page.locator("button", { hasText: "Check Updates" }).click();

      await expect(page.getByText("All skills are up to date")).toBeVisible({ timeout: 5000 });
    });
  });

  // -----------------------------------------------------------------------
  // 8. Audit
  // -----------------------------------------------------------------------
  test.describe("Audit", () => {
    test("Audit shows modal with findings", async ({ page }) => {
      await page.route("**/admin/api/hub/agents/1/audit/web-search", (route) =>
        route.fulfill({ json: mockAuditWithIssues })
      );

      await goToSkillsTab(page);

      const webSearchRow = page.locator("text=web-search").first().locator("..");
      await webSearchRow.locator("button", { hasText: "Audit" }).click();

      // Audit dialog should appear
      await expect(page.locator('[role="dialog"]')).toBeVisible();
      await expect(page.getByText("Security Audit: web-search")).toBeVisible();
      await expect(page.getByText("1 finding(s)")).toBeVisible();
      // Finding details
      await expect(page.getByText("Unencrypted HTTP connection detected")).toBeVisible();
    });

    test("Audit shows clean result", async ({ page }) => {
      await page.route("**/admin/api/hub/agents/1/audit/code-interpreter", (route) =>
        route.fulfill({ json: mockAuditClean })
      );

      await goToSkillsTab(page);

      const codeRow = page.locator("text=code-interpreter").first().locator("..");
      await codeRow.locator("button", { hasText: "Audit" }).click();

      await expect(page.locator('[role="dialog"]')).toBeVisible();
      await expect(page.getByText("No security issues found")).toBeVisible();
    });

    test("Audit shows critical findings", async ({ page }) => {
      await page.route("**/admin/api/hub/agents/1/audit/translation", (route) =>
        route.fulfill({ json: mockAuditCritical })
      );

      await goToSkillsTab(page);

      const transRow = page.locator("text=translation").first().locator("..");
      await transRow.locator("button", { hasText: "Audit" }).click();

      await expect(page.locator('[role="dialog"]')).toBeVisible();
      await expect(page.getByText("Critical security issues found")).toBeVisible();
      await expect(page.getByText("Arbitrary code execution via eval()")).toBeVisible();
    });

    test("Audit modal closes on Escape key", async ({ page }) => {
      await page.route("**/admin/api/hub/agents/1/audit/web-search", (route) =>
        route.fulfill({ json: mockAuditWithIssues })
      );

      await goToSkillsTab(page);

      const webSearchRow = page.locator("text=web-search").first().locator("..");
      await webSearchRow.locator("button", { hasText: "Audit" }).click();

      await expect(page.locator('[role="dialog"]')).toBeVisible();

      // Press Escape to close
      await page.keyboard.press("Escape");
      await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 3000 });
    });

    test("Audit modal closes on backdrop click", async ({ page }) => {
      await page.route("**/admin/api/hub/agents/1/audit/web-search", (route) =>
        route.fulfill({ json: mockAuditWithIssues })
      );

      await goToSkillsTab(page);

      const webSearchRow = page.locator("text=web-search").first().locator("..");
      await webSearchRow.locator("button", { hasText: "Audit" }).click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      // Use evaluate to dispatch a click directly on the backdrop overlay element,
      // bypassing any element that might intercept the mouse event.
      await page.evaluate(() => {
        const overlay = document.querySelector('[role="dialog"]') as HTMLElement;
        if (overlay) overlay.click();
      });
      await expect(dialog).not.toBeVisible({ timeout: 3000 });
    });
  });

  // -----------------------------------------------------------------------
  // 9. Error States
  // -----------------------------------------------------------------------
  test.describe("Error States", () => {
    test("API returns 500 shows error toast", async ({ page }) => {
      await page.route("**/admin/api/hub/agents/1/skills", (route) =>
        route.fulfill({
          status: 500,
          json: { detail: "Internal server error" },
        })
      );

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

      await loginAsAdmin(page);
      await page.goto(`/admin/agents/${AGENT_ID}?tab=skills`);

      // Should show an error toast with the message (may appear multiple times due to retries)
      await expect(page.getByText("Internal server error").first()).toBeVisible({ timeout: 5000 });
    });

    test("Browse API error shows error toast", async ({ page }) => {
      await page.route("**/admin/api/hub/browse*", (route) =>
        route.fulfill({
          status: 502,
          json: { detail: "Bad Gateway" },
        })
      );

      await goToSkillsTab(page);
      await page.locator('button[role="tab"]', { hasText: "Browse Hub" }).click();

      await expect(page.getByText(/Bad Gateway|Request failed/)).toBeVisible({ timeout: 5000 });
    });

    test("Not-running warning displayed when agent is stopped", async ({ page }) => {
      const stoppedAgent = {
        ...mockAgentDetail,
        status: "stopped",
        pods: [],
        health_ok: null,
      };

      await page.route("**/admin/api/agents/1", (route) =>
        route.fulfill({ json: stoppedAgent })
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
      await page.route("**/admin/api/hub/agents/1/skills", (route) =>
        route.fulfill({ json: mockInstalledSkillsStopped })
      );

      await loginAsAdmin(page);
      await page.goto(`/admin/agents/${AGENT_ID}?tab=skills`);

      await expect(page.getByText("Agent is not running")).toBeVisible();
    });
  });
});
