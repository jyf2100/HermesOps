/**
 * Secret Consistency E2E Tests
 *
 * Validates that gateway API keys are consistent across K8s secrets,
 * admin panel, and agent deployments after the secret unification change:
 *   - gateway-1/2/3 now use hermes-gateway-{N}-secret (not hermes-db-secret)
 *   - webui-1 AUTH_TOKEN matches the gateway-1 secret api_key
 *   - Admin panel reveals the same key shown in masked form
 *   - Test API Connection succeeds with the revealed key
 */
import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_KEY =
  process.env.ADMIN_KEY ||
  "Abcd@123";

const BASE_URL = "http://172.32.153.184:40080";

interface AgentInfo {
  id: number;
  name: string;
  status: string;
  api_key_masked: string;
  api_server_url: string;
}

interface AgentDetailInfo {
  id: number;
  name: string;
  status: string;
  api_key_masked: string;
  api_server_url: string;
  webui_url: string | null;
}

async function loginAsAdmin(page: Page) {
  await page.goto("/admin/login");
  await page.evaluate((key) => {
    localStorage.setItem("admin_api_key", key);
    localStorage.setItem("admin_mode", "admin");
  }, ADMIN_KEY);
  await page.goto("/admin/");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);
}

/** Call admin API directly via fetch. */
async function adminApiCall<T>(
  method: string,
  path: string,
  body?: object
): Promise<{ status: number; data: T }> {
  const opts: RequestInit = {
    method,
    headers: {
      "X-Admin-Key": ADMIN_KEY,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}/admin/api${path}`, opts);
  let data: T;
  try {
    data = await res.json();
  } catch {
    data = {} as T;
  }
  return { status: res.status, data };
}

/** Get all agents from the admin API. */
async function getAllAgents(): Promise<AgentInfo[]> {
  const { status, data } = await adminApiCall<{ agents: AgentInfo[]; total: number }>(
    "GET",
    "/agents"
  );
  expect(status).toBe(200);
  expect(data.agents).toBeDefined();
  expect(data.agents.length).toBeGreaterThan(0);
  return data.agents;
}

/** Get detailed agent info. */
async function getAgentDetail(
  agentId: number
): Promise<AgentDetailInfo> {
  const { status, data } = await adminApiCall<AgentDetailInfo>(
    "GET",
    `/agents/${agentId}`
  );
  expect(status).toBe(200);
  return data;
}

/** Reveal the full API key for an agent. */
async function revealApiKey(
  agentId: number
): Promise<string> {
  const { status, data } = await adminApiCall<{ agent_number: number; api_key: string }>(
    "POST",
    `/agents/${agentId}/api-key`
  );
  expect(status).toBe(200);
  expect(data.api_key).toBeDefined();
  expect(data.api_key.length).toBeGreaterThan(10);
  return data.api_key;
}

/** Test the agent's API connection. */
async function testAgentApi(
  agentId: number
): Promise<{ success: boolean; status_code: number | null; latency_ms: number | null; error: string | null }> {
  const { status, data } = await adminApiCall<{
    agent_number: number;
    success: boolean;
    status_code: number | null;
    latency_ms: number | null;
    error: string | null;
  }>("POST", `/agents/${agentId}/test-api`);
  expect(status).toBe(200);
  return data;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("Secret Consistency — Gateway / WebUI / Admin", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  // -----------------------------------------------------------------------
  // 1. Admin API returns agents with non-empty masked API keys
  // -----------------------------------------------------------------------
  test("all running agents have non-empty masked API keys", async () => {
    const agents = await getAllAgents();
    const runningAgents = agents.filter((a) => a.status === "running");
    expect(
      runningAgents.length,
      "Expected at least one running agent on the cluster"
    ).toBeGreaterThan(0);

    for (const agent of runningAgents) {
      expect(
        agent.api_key_masked,
        `Agent ${agent.name} (id=${agent.id}) has empty api_key_masked — secret may be misconfigured`
      ).toBeTruthy();
      // Masked key should have format "xxx***yyy" (at least 8 chars)
      expect(
        agent.api_key_masked.length,
        `Agent ${agent.name} masked key too short: "${agent.api_key_masked}"`
      ).toBeGreaterThanOrEqual(7);
    }
  });

  // -----------------------------------------------------------------------
  // 2. Reveal API key returns a valid key for each agent
  // -----------------------------------------------------------------------
  test("reveal API key returns valid key for each running agent", async () => {
    const agents = await getAllAgents();
    const runningAgents = agents.filter((a) => a.status === "running");

    for (const agent of runningAgents) {
      const fullKey = await revealApiKey(agent.id);

      // Key should be a token_urlsafe(32) — base64url, ~43 chars
      expect(
        fullKey.length,
        `Agent ${agent.name} API key length ${fullKey.length} is unexpected (expected ~43 chars from token_urlsafe(32))`
      ).toBeGreaterThanOrEqual(30);

      // Key should only contain URL-safe base64 characters
      expect(
        fullKey,
        `Agent ${agent.name} API key contains invalid characters`
      ).toMatch(/^[A-Za-z0-9_-]+$/);

      console.log(`[SECRET] Agent ${agent.name}: masked="${agent.api_key_masked}" full_len=${fullKey.length}`);
    }
  });

  // -----------------------------------------------------------------------
  // 3. Masked key prefix/suffix matches the revealed full key
  // -----------------------------------------------------------------------
  test("masked key prefix and suffix match the revealed full key", async () => {
    const agents = await getAllAgents();
    const runningAgents = agents.filter((a) => a.status === "running");

    for (const agent of runningAgents) {
      const fullKey = await revealApiKey(agent.id);
      const masked = agent.api_key_masked;

      // Masked format is "xxx***yyy" — first 3 and last 3 chars
      if (masked.includes("***")) {
        const parts = masked.split("***");
        const prefix = parts[0];
        const suffix = parts[1];

        expect(
          fullKey.startsWith(prefix),
          `Agent ${agent.name}: masked prefix "${prefix}" does not match full key starting with "${fullKey.slice(0, 5)}..."`
        ).toBeTruthy();

        expect(
          fullKey.endsWith(suffix),
          `Agent ${agent.name}: masked suffix "${suffix}" does not match full key ending with "...${fullKey.slice(-5)}"`
        ).toBeTruthy();

        console.log(
          `[SECRET] Agent ${agent.name}: mask matches full key (prefix="${prefix}", suffix="${suffix}")`
        );
      }
    }
  });

  // -----------------------------------------------------------------------
  // 4. Test API Connection succeeds for running agents
  //    This proves the key stored in the K8s secret is accepted by the
  //    gateway, confirming secret consistency between K8s and the running
  //    deployment.
  // -----------------------------------------------------------------------
  test("Test API Connection succeeds for all running agents", async () => {
    const agents = await getAllAgents();
    const runningAgents = agents.filter((a) => a.status === "running");

    for (const agent of runningAgents) {
      const result = await testAgentApi(agent.id);

      console.log(
        `[SECRET] Agent ${agent.name} test-api: success=${result.success} latency=${result.latency_ms}ms error=${result.error}`
      );

      expect(
        result.success,
        `Agent ${agent.name} API test failed: ${result.error || "unknown error"} — secret key may not match between K8s secret and gateway deployment`
      ).toBeTruthy();
    }
  });

  // -----------------------------------------------------------------------
  // 5. Agent detail page shows correct masked key in the UI
  // -----------------------------------------------------------------------
  test("agent detail page shows consistent masked key", async ({ page }) => {
    const agents = await getAllAgents();
    const runningAgent = agents.find((a) => a.status === "running");
    test.skip(!runningAgent, "No running agent available");
    if (!runningAgent) return;

    // Navigate to agent detail
    await page.goto(`/admin/agents/${runningAgent.id}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2000);

    // The page should show the masked key
    const body = await page.textContent("body");

    // Check that API access section is visible
    expect(body).toMatch(/api|API|密钥|key/i);

    // Verify the masked key from API matches what is shown in the UI
    // The masked key pattern like "xxx***yyy" should appear in the page
    const maskedPattern = /\*{3}/;
    expect(
      body,
      `Agent detail page does not show a masked key (expected *** pattern)`
    ).toMatch(maskedPattern);

    await page.screenshot({
      path: "test-results/secret-consistency-agent-detail.png",
      fullPage: true,
    });
  });

  // -----------------------------------------------------------------------
  // 6. Agent detail page reveals the full key via the eye icon
  // -----------------------------------------------------------------------
  test("agent detail page can reveal full API key", async ({ page }) => {
    const agents = await getAllAgents();
    const runningAgent = agents.find((a) => a.status === "running");
    test.skip(!runningAgent, "No running agent available");
    if (!runningAgent) return;

    await page.goto(`/admin/agents/${runningAgent.id}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2000);

    // Find the reveal button (eye icon near the API key)
    // The button has title="显示密钥" or "Reveal Key"
    const eyeButton = page.locator('button[title*="eveal"], button[title*="显示"], button[title*="隐藏"]').first();
    const hasEyeButton = (await eyeButton.count()) > 0;

    if (hasEyeButton) {
      await eyeButton.click();
      await page.waitForTimeout(1000);

      // Now the full key should be visible (not masked with ***)
      const bodyAfter = await page.textContent("body");
      // The full key should contain characters from token_urlsafe
      const fullKey = await revealApiKey(runningAgent.id);
      // Check if the page now shows the beginning of the full key
      expect(
        bodyAfter,
        `After reveal, page should contain the start of the API key`
      ).toContain(fullKey.slice(0, 5));

      await page.screenshot({
        path: "test-results/secret-consistency-revealed-key.png",
        fullPage: true,
      });
    }
  });

  // -----------------------------------------------------------------------
  // 7. Cross-agent key uniqueness
  //    Each agent should have its own unique API key (hermes-gateway-{N}-secret).
  // -----------------------------------------------------------------------
  test("each agent has a unique API key", async () => {
    const agents = await getAllAgents();
    const keys = new Map<string, number>();

    for (const agent of agents) {
      if (agent.status !== "running") continue;
      const fullKey = await revealApiKey(agent.id);
      const existing = keys.get(fullKey);
      if (existing !== undefined) {
        throw new Error(
          `Agents ${existing} and ${agent.id} share the same API key — secrets are not properly isolated (hermes-gateway-{N}-secret should be unique per agent)`
        );
      }
      keys.set(fullKey, agent.id);
    }

    console.log(
      `[SECRET] ${keys.size} agents checked, all have unique API keys`
    );
    expect(keys.size).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 8. Verify secret naming convention
  //    The admin backend should look for secrets named hermes-gateway-{N}-secret.
  //    We verify this indirectly by confirming that each agent's key is
  //    successfully read (which means the secret exists with the correct name).
  // -----------------------------------------------------------------------
  test("all agents can have their keys read (correct secret naming)", async () => {
    const agents = await getAllAgents();

    for (const agent of agents) {
      const { status, data } = await adminApiCall<{ agent_number: number; api_key: string }>(
        "POST",
        `/agents/${agent.id}/api-key`
      );
      // For running agents, the key must be readable
      if (agent.status === "running") {
        expect(
          status,
          `Agent ${agent.name} (id=${agent.id}) API key reveal failed — secret hermes-gateway-${agent.id}-secret may not exist`
        ).toBe(200);
        expect(data.api_key).toBeTruthy();
      } else {
        // Stopped/failed agents may or may not have a readable secret
        console.log(
          `[SECRET] Agent ${agent.name} (status=${agent.status}): key reveal status=${status}`
        );
      }
    }
  });

  // -----------------------------------------------------------------------
  // 9. WebUI URL contains valid token (for agents with webui)
  // -----------------------------------------------------------------------
  test("agents with webui have valid token in webui_url", async () => {
    const agents = await getAllAgents();
    const runningAgents = agents.filter((a) => a.status === "running");

    for (const agent of runningAgents) {
      const detail = await getAgentDetail(agent.id);

      if (detail.webui_url) {
        console.log(
          `[SECRET] Agent ${agent.name}: webui_url="${detail.webui_url}"`
        );

        // webui_url should contain a token parameter
        expect(
          detail.webui_url,
          `Agent ${agent.name} webui_url should contain token parameter`
        ).toContain("token=");

        // Extract token from URL and verify it is non-trivial
        const tokenMatch = detail.webui_url.match(/token=([^&]+)/);
        expect(tokenMatch, `Agent ${agent.name} webui_url has malformed token`).not.toBeNull();

        const token = tokenMatch![1];
        expect(
          token.length,
          `Agent ${agent.name} webui token is too short (${token.length} chars) — may be an empty or default key`
        ).toBeGreaterThanOrEqual(20);

        // Token should be the same as the agent's API key
        const fullKey = await revealApiKey(agent.id);
        expect(
          token,
          `Agent ${agent.name} webui token does not match its API key — AUTH_TOKEN secret may be misconfigured`
        ).toBe(fullKey);

        console.log(
          `[SECRET] Agent ${agent.name}: webui token matches API key (length=${token.length})`
        );
      } else {
        console.log(
          `[SECRET] Agent ${agent.name}: no webui_url (webui not deployed for this agent)`
        );
      }
    }
  });
});
