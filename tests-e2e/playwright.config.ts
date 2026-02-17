import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.GRADE_NOTIFICATIONS_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "2022"}`;
const PORT =
  process.env.PORT ??
  (() => {
    try {
      const u = new URL(BASE_URL);
      return u.port || (u.protocol === "https:" ? "443" : "80");
    } catch {
      return "2022";
    }
  })();

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx cross-env PORT=${PORT} npm run dev:server`,
    url: `${BASE_URL.replace(/\/$/, "")}/health`,
    reuseExistingServer: !process.env.CI,
    cwd: "..",
    timeout: 60_000,
  },
});
