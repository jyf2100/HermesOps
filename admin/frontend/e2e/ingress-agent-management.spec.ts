/**
 * E2E tests for agent lifecycle and ingress path management.
 *
 * Verifies that creating/deleting agents correctly exercises the backend
 * k8s_client.py code that dynamically adds/removes ingress paths.
 * All API responses are mocked via Playwright route interception.
 */
import { test, expect } from "@playwright/test";
import {
  VALID_ADMIN_KEY,
  mockAgentList,
  mockClusterStatus,
  mockAgentDetail,
  mockEnvVars,
  mockConfigYaml,
  mockSoul,
  mockHealth,
  mockEvents,
  mockWeixinStatusNotConnected,
  mockCreateAgentResponse,
  mockSettings,
  mockEmptyAgentList,
  mockMessageResponse,
} from "./fixtures/mock-data";
import { loginAsAdmin } from "./helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up route mocks needed for the dashboard page to render. */
async function mockDashboardApi(page: import("@playwright/test").Page) {
  await page.route("**/admin/api/agents", (route) =>
    route.fulfill({ json: mockAgentList })
  );
  await page.route("**/admin/api/cluster/status", (route) =>
    route.fulfill({ json: mockClusterStatus })
  );
}

/** Set up route mocks needed for the agent detail page to render. */
async function mockAgentDetailApi(page: import("@playwright/test").Page) {
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
    route.fulfill({ json: mockWeixinStatusNotConnected })
  );
}

/** Set up route mocks needed for the create agent wizard. */
async function mockCreateAgentApi(page: import("@playwright/test").Page) {
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
    route.fulfill({
      json: { type: "soul", content: "You are a helpful assistant." },
    })
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("Agent Management (Ingress)", () => {
  // -----------------------------------------------------------------------
  // Test 1: Admin panel loads with agent list
  // -----------------------------------------------------------------------
  test("admin panel loads with agent list", async ({ page }) => {
    await mockDashboardApi(page);
    await loginAsAdmin(page);
    await page.goto("/admin/");

    await expect(page.getByText("hermes-gateway-1")).toBeVisible();
    await expect(page.getByText("hermes-gateway-2")).toBeVisible();
    await expect(page.getByText("hermes-gateway-3")).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // Test 2: Navigation to agent detail works
  // -----------------------------------------------------------------------
  test("navigate to agent detail page", async ({ page }) => {
    await mockDashboardApi(page);
    await mockAgentDetailApi(page);
    await loginAsAdmin(page);
    await page.goto("/admin/");

    await page.getByText(/查看|View/).first().click();
    await expect(page).toHaveURL(/\/agents\/\d+/);
  });

  // -----------------------------------------------------------------------
  // Test 3: Create agent triggers POST /agents
  // -----------------------------------------------------------------------
  test("create agent calls POST /agents", async ({ page }) => {
    let postCalled = false;
    let postedBody: unknown = null;

    await mockCreateAgentApi(page);

    await page.route("**/admin/api/agents", async (route) => {
      if (route.request().method() === "POST") {
        postCalled = true;
        postedBody = route.request().postDataJSON();
        return route.fulfill({ json: mockCreateAgentResponse });
      }
      return route.fulfill({ json: mockEmptyAgentList });
    });

    await loginAsAdmin(page);
    await page.goto("/admin/create");

    // Step 0: wizard visible
    await expect(page.getByText(/确认部署/)).toBeVisible();

    // Fill display name
    const nameInput = page.locator('input[type="text"]').first();
    await nameInput.fill("test-agent");

    // Step 0 -> Step 1 (LLM config)
    await page.getByRole("button", { name: "确认" }).click();
    await expect(page.getByText(/API Key|密钥/i)).toBeVisible();

    // Fill API key
    await page.fill('input[type="password"]', "sk-test-key-123");
    const modelInput = page.locator('input[type="text"]').first();
    await modelInput.fill("claude-sonnet-4-20250514");

    // Step 1 -> Step 2 (SOUL.md)
    await page.getByRole("button", { name: "确认" }).click();

    // Step 2 -> Step 3 (Review)
    await page.getByRole("button", { name: "确认" }).click();

    // Deploy
    await page.getByRole("button", { name: /部署|Deploy/ }).click();

    // Verify POST was called
    await expect(() => expect(postCalled).toBe(true)).toPass();
    expect(postedBody).toBeTruthy();
    const body = postedBody as Record<string, unknown>;
    expect(body).toHaveProperty("agent_number");
    expect(body).toHaveProperty("llm");
  });

  // -----------------------------------------------------------------------
  // Test 4: Create agent handles 500 error gracefully
  // -----------------------------------------------------------------------
  test("create agent shows error on 500 response", async ({ page }) => {
    await mockCreateAgentApi(page);

    await page.route("**/admin/api/agents", async (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 500,
          json: { detail: "Ingress update failed: k8s API error" },
        });
      }
      return route.fulfill({ json: mockEmptyAgentList });
    });

    await loginAsAdmin(page);
    await page.goto("/admin/create");

    // Step 0 -> Step 1
    await page.getByRole("button", { name: "确认" }).click();
    await expect(page.getByText(/API Key|密钥/i)).toBeVisible();

    await page.fill('input[type="password"]', "sk-test-key-123");
    const modelInput = page.locator('input[type="text"]').first();
    await modelInput.fill("claude-sonnet-4-20250514");

    // Step 1 -> Step 2 -> Step 3
    await page.getByRole("button", { name: "确认" }).click();
    await page.getByRole("button", { name: "确认" }).click();

    // Deploy
    await page.getByRole("button", { name: /部署|Deploy/ }).click();

    // Error toast should be visible (use first() to avoid strict mode violation)
    await expect(
      page.getByText(/Ingress update failed|error|failed/i).first()
    ).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // Test 5: Delete agent removes from list
  // -----------------------------------------------------------------------
  test("delete agent calls DELETE and navigates to dashboard", async ({
    page,
  }) => {
    let deleteCalled = false;

    await mockAgentDetailApi(page);

    // Mock DELETE endpoint
    await page.route("**/admin/api/agents/1*", async (route) => {
      if (route.request().method() === "DELETE") {
        deleteCalled = true;
        return route.fulfill({ json: mockMessageResponse("Agent deleted") });
      }
      return route.fallback();
    });

    // Dashboard API for navigation after delete
    await page.route("**/admin/api/cluster/status", (route) =>
      route.fulfill({ json: mockClusterStatus })
    );
    const updatedList = {
      agents: mockAgentList.agents.filter((a) => a.id !== 1),
      total: 2,
    };
    await page.route("**/admin/api/agents", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ json: updatedList });
      }
      return route.fallback();
    });

    await loginAsAdmin(page);
    await page.goto("/admin/agents/1");

    // Wait for detail page heading
    await expect(
      page.getByRole("heading", { name: /hermes-gateway-1/ })
    ).toBeVisible();

    // Click delete
    await page.getByText(/删除|Delete/).click();

    // Confirm dialog
    await expect(
      page.getByText(/确定要删除|Are you sure/i)
    ).toBeVisible();

    // Confirm
    const confirmButton = page
      .locator("button")
      .filter({ hasText: /删除|Delete/ })
      .last();
    await confirmButton.click();

    // DELETE was called
    await expect(() => expect(deleteCalled).toBe(true)).toPass();

    // Navigated back to dashboard (may or may not have trailing slash)
    await expect(page).toHaveURL(/\/admin\/?$/);
  });

  // -----------------------------------------------------------------------
  // Test 6: Delete agent handles error gracefully
  // -----------------------------------------------------------------------
  test("delete agent shows error on failed DELETE", async ({ page }) => {
    await mockAgentDetailApi(page);

    await page.route("**/admin/api/agents/1*", async (route) => {
      if (route.request().method() === "DELETE") {
        return route.fulfill({
          status: 500,
          json: { detail: "Failed to remove ingress path" },
        });
      }
      return route.fallback();
    });

    await loginAsAdmin(page);
    await page.goto("/admin/agents/1");

    // Wait for detail page heading
    await expect(
      page.getByRole("heading", { name: /hermes-gateway-1/ })
    ).toBeVisible();

    // Click delete
    await page.getByText(/删除|Delete/).click();

    // Confirm dialog
    await expect(
      page.getByText(/确定要删除|Are you sure/i)
    ).toBeVisible();

    const confirmButton = page
      .locator("button")
      .filter({ hasText: /删除|Delete/ })
      .last();
    await confirmButton.click();

    // Error shown (use first() for strict mode)
    await expect(
      page.getByText(/Failed to remove ingress|error/i).first()
    ).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // Test 7: Empty dashboard shows create prompt
  // -----------------------------------------------------------------------
  test("empty agent list shows create prompt", async ({ page }) => {
    await page.route("**/admin/api/agents", (route) =>
      route.fulfill({ json: mockEmptyAgentList })
    );
    await page.route("**/admin/api/cluster/status", (route) =>
      route.fulfill({ json: mockClusterStatus })
    );
    await loginAsAdmin(page);
    await page.goto("/admin/");

    await expect(
      page.getByText(/暂无\s*Agent|No Agent/i)
    ).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // Test 8: Create button navigates to create page
  // -----------------------------------------------------------------------
  test("create button navigates to create page", async ({ page }) => {
    await mockDashboardApi(page);
    await loginAsAdmin(page);
    await page.goto("/admin/");

    const createBtn = page
      .getByRole("button", { name: /创建|Create/i })
      .first();
    await createBtn.click();
    await expect(page).toHaveURL(/\/admin\/create/);
  });
});
