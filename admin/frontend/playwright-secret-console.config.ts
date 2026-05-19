/**
 * Playwright config for secret-consistency and agent-console E2E tests.
 * Targets the 184 development cluster.
 *
 * Run:
 *   npx playwright test --config=playwright-secret-console.config.ts
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-real",
  testMatch: /secret-consistency\.spec\.ts|agent-console\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: false,
  retries: 1,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report-secret-console" }]],
  timeout: 60000,
  use: {
    baseURL: "http://172.32.153.184:40080/admin",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
