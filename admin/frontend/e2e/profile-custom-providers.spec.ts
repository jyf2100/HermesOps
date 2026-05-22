/**
 * E2E tests for custom_providers injection functionality.
 *
 * Tests three backend injection features via frontend API interactions:
 * 1. Agent creation with provider=custom and base_url
 * 2. Profile sync API sends correct request path
 * 3. Profile delete API sends correct request path
 * 4. Profile create with custom provider config_overrides
 * 5. Resolved config preview with custom_providers
 */
import { test, expect } from "@playwright/test";
import { loginAsAdminEn } from "./helpers";
import {
  VALID_ADMIN_KEY,
  mockSettings,
  mockEmptyAgentList,
  mockAgentDetail,
  mockEnvVars,
  mockConfigYaml,
  mockSoul,
  mockHealth,
  mockEvents,
  mockWeixinStatusConnected,
  mockProfileTemplates,
  mockProfileList,
  mockCreateAgentResponse,
} from "./fixtures/mock-data";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Register all base page.route() mocks required for AgentDetailPage profiles tab. */
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
  // Catch-all for unresolved profile routes
  await page.route("**/admin/api/agents/1/profiles/**", (route) =>
    route.fallback()
  );
}

/** Navigate to agent detail profiles tab with all required mocks. */
async function goToProfiles(page, profiles = mockProfileList) {
  await mockBaseRoutes(page, { profiles });
  await page.goto("/admin/agents/1?tab=profiles");
  await page.waitForSelector('text="Profiles"');
}

// ---------------------------------------------------------------------------
// Test suite: Agent creation with custom provider
// ---------------------------------------------------------------------------

test.describe("Agent Creation with custom provider", () => {
  async function goToCreate(page) {
    await page.route("**/admin/api/settings", (route) =>
      route.fulfill({ json: mockSettings })
    );
    await page.route("**/admin/api/templates/soul", (route) =>
      route.fulfill({ json: { type: "soul", content: "You are a helpful assistant." } })
    );
    await page.route("**/admin/api/profile-templates", (route) =>
      route.fulfill({ json: mockProfileTemplates })
    );
    await loginAsAdminEn(page);
    await page.goto("/admin/create");
  }

  test("sends provider=custom and base_url in create request", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await page.route("**/admin/api/agents", async (route) => {
      if (route.request().method() === "POST") {
        createBody = route.request().postDataJSON();
        return route.fulfill({ json: mockCreateAgentResponse });
      }
      return route.fulfill({ json: mockEmptyAgentList });
    });

    await goToCreate(page);

    // Step 0 (Basic Info) is shown first. Click confirm to advance.
    await page.locator('button:has-text("Confirm")').click();

    // Step 1 (LLM Config) should now be visible
    // Select "OpenAI 兼容" (custom) provider
    const providerSelect = page.locator("select").first();
    await providerSelect.selectOption({ label: "OpenAI 兼容" });

    // Fill model name
    const modelInput = page.locator('input[type="text"]').first();
    await modelInput.fill("glm-4.7");

    // Fill API key (required for validation)
    await page.locator('input[type="password"]').fill("sk-test-custom-key");

    // Fill base URL -- find it as the last text input in the LLM step
    const allTextInputs = page.locator('input[type="text"]');
    const inputCount = await allTextInputs.count();
    // model input + base_url input in LLM step
    await allTextInputs.nth(inputCount - 1).fill("https://open.bigmodel.cn/api/paas/v4");

    // Advance to step 2 (SOUL.md)
    await page.locator('button:has-text("Confirm")').click();

    // Advance to step 3 (Review)
    await page.locator('button:has-text("Confirm")').click();

    // Deploy from step 3
    await page.locator('button:has-text("Deploy")').click();

    // Verify the request body contains custom provider config
    await expect(() => {
      expect(createBody).toBeTruthy();
      const body = createBody!;
      expect(body.llm).toBeTruthy();
      const llm = body.llm as Record<string, unknown>;
      expect(llm.provider).toBe("custom");
      expect(llm.model).toBe("glm-4.7");
      expect(llm.base_url).toBe("https://open.bigmodel.cn/api/paas/v4");
      expect(llm.api_key).toBe("sk-test-custom-key");
    }).toPass({ timeout: 10000 });
  });

  test("sends built-in base_url for openrouter provider", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await page.route("**/admin/api/agents", async (route) => {
      if (route.request().method() === "POST") {
        createBody = route.request().postDataJSON();
        return route.fulfill({ json: mockCreateAgentResponse });
      }
      return route.fulfill({ json: mockEmptyAgentList });
    });

    await goToCreate(page);

    // Step 0: advance
    await page.locator('button:has-text("Confirm")').click();

    // Step 1: OpenRouter is the default provider with base_url already set
    // Just fill API key
    await page.locator('input[type="password"]').fill("sk-or-test-key");

    // Advance through step 2 and 3
    await page.locator('button:has-text("Confirm")').click();
    await page.locator('button:has-text("Confirm")').click();

    // Deploy
    await page.locator('button:has-text("Deploy")').click();

    await expect(() => {
      expect(createBody).toBeTruthy();
      const body = createBody!;
      const llm = body.llm as Record<string, unknown>;
      expect(llm.provider).toBe("openrouter");
      expect(llm.base_url).toBe("https://openrouter.ai/api/v1");
    }).toPass({ timeout: 10000 });
  });
});

// ---------------------------------------------------------------------------
// Test suite: Profile sync API call correctness
// ---------------------------------------------------------------------------

test.describe("Profile Sync API", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("sync single profile calls correct API path", async ({ page }) => {
    let syncUrl: string | null = null;
    let syncMethod: string | null = null;

    await mockBaseRoutes(page);
    await page.route("**/admin/api/agents/1/profiles/*/sync", async (route) => {
      if (route.request().method() === "POST") {
        syncUrl = route.request().url();
        syncMethod = route.request().method();
        return route.fulfill({
          json: {
            profile_name: "research-mode",
            status: "synced",
            message: "Config synced to pod",
          },
        });
      }
      return route.fallback();
    });

    await goToProfiles(page);

    // Click sync on the research-mode profile row
    const researchRow = page
      .locator("div.rounded-lg.border.bg-surface")
      .filter({ hasText: "research-mode" });
    await researchRow.locator('button:has-text("Sync to Pod")').click();

    await expect(() => {
      expect(syncUrl).toBeTruthy();
      expect(syncMethod).toBe("POST");
      expect(syncUrl).toContain("/agents/1/profiles/");
      expect(syncUrl).toContain("/sync");
    }).toPass({ timeout: 10000 });
  });

  test("sync all profiles calls batch sync endpoint", async ({ page }) => {
    let batchSyncUrl: string | null = null;
    let batchSyncMethod: string | null = null;

    await mockBaseRoutes(page);
    await page.route("**/admin/api/agents/1/profiles/sync", async (route) => {
      if (route.request().method() === "POST") {
        batchSyncUrl = route.request().url();
        batchSyncMethod = route.request().method();
        return route.fulfill({
          json: {
            synced: 2,
            results: [
              { profile_name: "default", status: "synced", message: "OK" },
              { profile_name: "research-mode", status: "synced", message: "OK" },
            ],
          },
        });
      }
      return route.fallback();
    });

    await goToProfiles(page);

    await page.click('button:has-text("Sync All")');

    await expect(() => {
      expect(batchSyncUrl).toBeTruthy();
      expect(batchSyncMethod).toBe("POST");
      expect(batchSyncUrl).toContain("/agents/1/profiles/sync");
    }).toPass({ timeout: 10000 });
  });
});

// ---------------------------------------------------------------------------
// Test suite: Profile delete API path correctness
// ---------------------------------------------------------------------------

test.describe("Profile Delete API", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("delete profile sends correct DELETE request path", async ({ page }) => {
    const deletedNames: string[] = [];

    await mockBaseRoutes(page);
    await page.route("**/admin/api/agents/1/profiles/*", async (route) => {
      if (route.request().method() === "DELETE") {
        const url = new URL(route.request().url());
        const segments = url.pathname.split("/");
        const profileName = segments[segments.length - 1];
        deletedNames.push(decodeURIComponent(profileName));
        return route.fulfill({ json: { status: "deleted" } });
      }
      return route.fallback();
    });

    await goToProfiles(page);

    const defaultRow = page
      .locator("div.rounded-lg.border.bg-surface")
      .filter({ hasText: "default" });

    page.once("dialog", (dialog) => dialog.accept());
    await defaultRow.locator('button:has-text("Delete")').click();

    await expect(() => {
      expect(deletedNames).toHaveLength(1);
      expect(deletedNames[0]).toBe("default");
    }).toPass({ timeout: 10000 });
  });

  test("batch delete sends individual DELETE for each selected profile", async ({ page }) => {
    const deletedNames: string[] = [];

    await mockBaseRoutes(page);
    await page.route("**/admin/api/agents/1/profiles/*", async (route) => {
      if (route.request().method() === "DELETE") {
        const url = new URL(route.request().url());
        const segments = url.pathname.split("/");
        const profileName = segments[segments.length - 1];
        deletedNames.push(decodeURIComponent(profileName));
        return route.fulfill({ json: { status: "deleted" } });
      }
      return route.fallback();
    });

    await goToProfiles(page);

    const brokenRow = page
      .locator("div.rounded-lg.border.bg-surface")
      .filter({ hasText: "broken" });
    await brokenRow.locator("input[type='checkbox']").click();

    const defaultRow = page
      .locator("div.rounded-lg.border.bg-surface")
      .filter({ hasText: "default" });
    await defaultRow.locator("input[type='checkbox']").click();

    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain("Delete 2 profiles");
      dialog.accept();
    });

    await page.locator("button:has-text('Delete (2)')").click();

    await expect(() => {
      expect(deletedNames).toHaveLength(2);
      expect(deletedNames).toContain("broken");
      expect(deletedNames).toContain("default");
    }).toPass({ timeout: 10000 });
  });
});

// ---------------------------------------------------------------------------
// Test suite: Profile create with custom provider config overrides
// ---------------------------------------------------------------------------

test.describe("Profile Create with custom provider config", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("creates profile with model.provider=custom and model.base_url in config_overrides", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await goToProfiles(page, []);

    // Register POST handler AFTER goToProfiles so it takes priority (last registered wins)
    await page.route("**/admin/api/agents/1/profiles", async (route) => {
      if (route.request().method() === "POST") {
        createBody = route.request().postDataJSON();
        return route.fulfill({
          json: {
            id: 201,
            agent_number: 1,
            profile_name: "custom-llm",
            display_name: "Custom LLM",
            template_id: 1,
            config_overrides: createBody?.config_overrides ?? {},
            soul_md: null,
            sync_status: "pending",
            sync_error: null,
            config_hash: "hash-xyz",
            last_synced_at: null,
            created_at: "2026-05-22T10:00:00Z",
            updated_at: "2026-05-22T10:00:00Z",
          },
        });
      }
      return route.fulfill({ json: [] });
    });

    await page.click('button:has-text("Create Profile")');
    await page.fill('input[placeholder="e.g. researcher"]', "custom-llm");

    // Select the Researcher template (id=1) which has provider: "custom"
    await page.locator('[role="dialog"] select').selectOption("1");

    // Fill config JSON with custom provider and base_url
    const textareas = page.locator("textarea");
    await textareas.first().fill(
      JSON.stringify({
        model: {
          default: "glm-4.7",
          provider: "custom",
          base_url: "https://open.bigmodel.cn/api/paas/v4",
        },
      })
    );

    await page.click('button:has-text("Save")');

    await expect(() => {
      expect(createBody).toBeTruthy();
      expect(createBody!.profile_name).toBe("custom-llm");
      expect(createBody!.template_id).toBe(1);
      const config = createBody!.config_overrides as Record<string, unknown>;
      expect(config.model).toBeTruthy();
      const model = config.model as Record<string, unknown>;
      expect(model.provider).toBe("custom");
      expect(model.base_url).toBe("https://open.bigmodel.cn/api/paas/v4");
    }).toPass({ timeout: 10000 });
  });

  test("creates profile without base_url for non-custom provider", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;

    await goToProfiles(page, []);

    // Register POST handler AFTER goToProfiles so it takes priority
    await page.route("**/admin/api/agents/1/profiles", async (route) => {
      if (route.request().method() === "POST") {
        createBody = route.request().postDataJSON();
        return route.fulfill({
          json: {
            id: 202,
            agent_number: 1,
            profile_name: "openai-profile",
            display_name: "OpenAI Profile",
            template_id: null,
            config_overrides: createBody?.config_overrides ?? {},
            soul_md: null,
            sync_status: "pending",
            sync_error: null,
            config_hash: "hash-abc",
            last_synced_at: null,
            created_at: "2026-05-22T10:00:00Z",
            updated_at: "2026-05-22T10:00:00Z",
          },
        });
      }
      return route.fulfill({ json: [] });
    });

    await page.click('button:has-text("Create Profile")');
    await page.fill('input[placeholder="e.g. researcher"]', "openai-profile");

    const textareas = page.locator("textarea");
    await textareas.first().fill(
      JSON.stringify({
        model: {
          default: "anthropic/claude-sonnet-4-20250514",
          provider: "openrouter",
        },
      })
    );

    await page.click('button:has-text("Save")');

    await expect(() => {
      expect(createBody).toBeTruthy();
      const config = createBody!.config_overrides as Record<string, unknown>;
      const model = config.model as Record<string, unknown>;
      expect(model.provider).toBe("openrouter");
      expect(model.base_url).toBeUndefined();
    }).toPass({ timeout: 10000 });
  });
});

// ---------------------------------------------------------------------------
// Test suite: Resolved config preview with custom_providers
// ---------------------------------------------------------------------------

test.describe("Resolved Config Preview with custom_providers", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("resolved config shows provider=custom from template overrides", async ({ page }) => {
    await mockBaseRoutes(page);
    await page.route(
      "**/admin/api/agents/1/profiles/*/resolved-config",
      async (route) => {
        return route.fulfill({
          json: {
            profile_name: "research-mode",
            template_id: 1,
            template_overrides: {
              model: { default: "glm-4.7", provider: "custom" },
            },
            profile_overrides: {
              model: { default: "glm-4.7" },
            },
            resolved_config: {
              model: {
                default: "glm-4.7",
                provider: "custom",
              },
            },
            soul_md: "You are a professional research analyst.",
          },
        });
      }
    );

    await goToProfiles(page);

    // Click edit on research-mode profile (second row)
    await page.locator('button:has-text("Edit")').nth(1).click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Toggle resolved config preview
    await page.click('text="Resolved Config Preview"');
    await expect(page.locator("pre")).toBeVisible();

    // Verify the resolved config content shows custom provider
    const preContent = await page.locator("pre").textContent();
    expect(preContent).toContain('"provider": "custom"');
    expect(preContent).toContain('"glm-4.7"');
  });
});
