import { defineConfig, devices } from "@playwright/test";

/**
 * Mock-mode smoke suite (docs/handoff.md §3). Runs against `pnpm dev` with the
 * provider forced to mock and the harness enabled, so no upstream key is used.
 * Next 16 allows one `next dev` per directory: an already running dev server on
 * the same port is reused, and the suite then works with whatever DATA_DIR it has.
 * Use `localhost`, not `127.0.0.1`: Next 16 dev rejects the client bundle from other origins (403).
 */
const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    video: "off",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `pnpm dev --port ${PORT}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      LUMEN_FORCE_MOCK: "1",
      HARNESS_ENABLED: "1",
    },
  },
});
