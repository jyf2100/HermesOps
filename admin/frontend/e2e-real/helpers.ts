import { Page } from "@playwright/test";

export const ADMIN_KEY = process.env.ADMIN_KEY || "Abcd@123";

export async function loginAsAdmin(page: Page) {
  await page.goto("/admin/login");
  await page.evaluate((key) => {
    localStorage.setItem("admin_api_key", key);
    localStorage.setItem("admin_mode", "admin");
  }, ADMIN_KEY);
  // Reload to apply auth — SPA reads localStorage on mount
  await page.reload();
  await page.waitForLoadState("networkidle").catch(() => {});
}

export async function navigateTo(page: Page, path: string) {
  await page.goto(`/admin${path}`);
  // Wait for SPA to fully render (React mount + API calls)
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);
}
