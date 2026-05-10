import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-real",
  testMatch: /skills-hub.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: false,
  retries: 1,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report-184" }]],
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
