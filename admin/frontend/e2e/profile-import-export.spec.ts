import { test, expect } from "@playwright/test";
import { loginAsAdminEn } from "./helpers";
import {
  mockAgentDetail,
  mockEnvVars,
  mockConfigYaml,
  mockSoul,
  mockHealth,
  mockEvents,
  mockWeixinStatusConnected,
  mockProfileTemplates,
  mockProfileList,
} from "./fixtures/mock-data";

// ---------------------------------------------------------------------------
// Shared helpers for this spec
// ---------------------------------------------------------------------------

async function mockBaseRoutes(
  page: import("@playwright/test").Page,
  overrides?: { profiles?: unknown }
) {
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

async function goToProfiles(
  page: import("@playwright/test").Page,
  profiles: unknown = mockProfileList
) {
  await mockBaseRoutes(page, { profiles });
  await page.goto("/admin/agents/1?tab=profiles");
  await page.waitForSelector('text="Profiles"');
}

// ---------------------------------------------------------------------------
// Profile Export
// ---------------------------------------------------------------------------

test.describe("Profile Export", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("exports profiles as JSON file", async ({ page }) => {
    await goToProfiles(page);

    const downloadPromise = page.waitForEvent("download");
    await page.click('button:has-text("Export")');
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toContain("profiles-agent-1");

    const readStream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of readStream) {
      chunks.push(chunk as Buffer);
    }
    const content = Buffer.concat(chunks).toString("utf-8");
    const parsed = JSON.parse(content);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].profile_name).toBe("default");
  });

  test("hides export button when no profiles", async ({ page }) => {
    await goToProfiles(page, []);

    await expect(
      page.locator('button:has-text("Export")')
    ).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Profile Import
// ---------------------------------------------------------------------------

test.describe("Profile Import", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminEn(page);
  });

  test("imports valid JSON profile file", async ({ page }) => {
    const validProfiles = [
      {
        profile_name: "imported-1",
        display_name: "Imported One",
        template_id: null,
        config_overrides: {},
        soul_md: null,
      },
      {
        profile_name: "imported-2",
        display_name: "Imported Two",
        template_id: 1,
        config_overrides: { model: { default: "glm-4.7" } },
        soul_md: "You are helpful.",
      },
    ];

    const postBodies: Record<string, unknown>[] = [];

    await mockBaseRoutes(page, { profiles: [] });
    // Override profiles route to capture POST requests
    await page.route("**/admin/api/agents/1/profiles", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        postBodies.push(body);
        return route.fulfill({
          json: {
            id: Date.now(),
            agent_number: 1,
            ...body,
            sync_status: "pending",
            sync_error: null,
            config_hash: "mock-hash",
            last_synced_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        });
      }
      return route.fulfill({ json: [] });
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    await page
      .locator('input[type="file"][accept=".json"]')
      .setInputFiles({
        name: "profiles.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(validProfiles)),
      });

    // Verify POST requests were sent
    await expect(() => {
      expect(postBodies).toHaveLength(2);
      expect(postBodies[0].profile_name).toBe("imported-1");
      expect(postBodies[1].profile_name).toBe("imported-2");
    }).toPass({ timeout: 10000 });

    // Verify success toast
    await expect(
      page.locator("#admin-toast-container >> text=Imported 2/2 profiles")
    ).toBeVisible();
  });

  test("rejects files larger than 1MB", async ({ page }) => {
    await goToProfiles(page);

    // Create a buffer larger than 1MB
    const largeContent = "x".repeat(1024 * 1024 + 1);
    await page
      .locator('input[type="file"][accept=".json"]')
      .setInputFiles({
        name: "large.json",
        mimeType: "application/json",
        buffer: Buffer.from(largeContent),
      });

    await expect(
      page.locator("#admin-toast-container >> text=File too large")
    ).toBeVisible();
  });

  test("rejects non-array JSON", async ({ page }) => {
    await goToProfiles(page);

    await page
      .locator('input[type="file"][accept=".json"]')
      .setInputFiles({
        name: "not-array.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ not: "array" })),
      });

    await expect(
      page.locator(
        "#admin-toast-container >> text=Invalid format: expected array"
      )
    ).toBeVisible();
  });

  test("rejects array exceeding 50 profiles", async ({ page }) => {
    await goToProfiles(page);

    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      profile_name: `profile-${i}`,
    }));

    await page
      .locator('input[type="file"][accept=".json"]')
      .setInputFiles({
        name: "too-many.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(tooMany)),
      });

    await expect(
      page.locator("#admin-toast-container >> text=Too many profiles (max 50)")
    ).toBeVisible();
  });

  test("rejects profiles missing profile_name", async ({ page }) => {
    await goToProfiles(page);

    const invalidProfiles = [{ display_name: "No Name" }];

    await page
      .locator('input[type="file"][accept=".json"]')
      .setInputFiles({
        name: "no-name.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(invalidProfiles)),
      });

    await expect(
      page.locator(
        "#admin-toast-container >> text=Each profile must have a valid profile_name"
      )
    ).toBeVisible();
  });

  test("shows partial success count on mixed results", async ({ page }) => {
    const mixedProfiles = [
      {
        profile_name: "good-1",
        display_name: "Good One",
        template_id: null,
        config_overrides: {},
        soul_md: null,
      },
      {
        profile_name: "good-2",
        display_name: "Good Two",
        template_id: null,
        config_overrides: {},
        soul_md: null,
      },
      {
        profile_name: "will-fail",
        display_name: "Will Fail",
        template_id: null,
        config_overrides: {},
        soul_md: null,
      },
    ];

    await mockBaseRoutes(page, { profiles: [] });
    // Override profiles route: succeed for first two, fail for third
    await page.route("**/admin/api/agents/1/profiles", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        if (body.profile_name === "will-fail") {
          return route.fulfill({
            status: 500,
            json: { detail: "Server error" },
          });
        }
        return route.fulfill({
          json: {
            id: Date.now(),
            agent_number: 1,
            ...body,
            sync_status: "pending",
            sync_error: null,
            config_hash: "mock-hash",
            last_synced_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        });
      }
      return route.fulfill({ json: [] });
    });

    await page.goto("/admin/agents/1?tab=profiles");
    await page.waitForSelector('text="Profiles"');

    await page
      .locator('input[type="file"][accept=".json"]')
      .setInputFiles({
        name: "mixed.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(mixedProfiles)),
      });

    // 2 succeeded out of 3
    await expect(
      page.locator("#admin-toast-container >> text=Imported 2/3 profiles")
    ).toBeVisible();
  });
});
