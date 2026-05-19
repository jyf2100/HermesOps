import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e-real",
  timeout: 60000,
  use: {
    baseURL: process.env.BASE_URL || "http://172.32.153.184:40080",
  },
});
