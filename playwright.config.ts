import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import {
  E2E_ADMIN_TOKEN,
  E2E_ADMIN_USER_ID,
  E2E_PORT,
  E2E_SESSION_SECRET,
  STORAGE_STATE,
  e2eBaseUrl,
} from "./e2e/paths";

/**
 * Mock-mode smoke suite (docs/handoff.md §3). Runs against `pnpm dev` with the
 * provider forced to mock and the harness enabled, so no upstream key is used.
 * Next 16 allows one `next dev` per directory: an already running dev server on
 * the same port is reused, and the suite then works with whatever DATA_DIR it has.
 * Use `localhost`, not `127.0.0.1`: Next 16 dev rejects the client bundle from other origins (403).
 *
 * Gate semantics (R12): a reused server keeps its own env, so the spec skips when the server
 * is not in mock mode. Set `E2E_REQUIRE_MOCK=1` (CI does) to turn those skips into failures,
 * and `E2E_ISOLATED=1` to refuse reuse and start a fresh server on `E2E_DATA_DIR`.
 */
// 端口与地址的唯一推导在 `e2e/paths.ts`：调管理 CLI 的用例要拿同一个地址当
// `LUMEN_ADMIN_BASE_URL`，两边分家过一次就红了六个定时轮次（见该文件注释）。
const PORT = E2E_PORT;
const BASE_URL = e2eBaseUrl();
const ISOLATED = Boolean(process.env.CI || process.env.E2E_ISOLATED);
const DATA_DIR = process.env.E2E_DATA_DIR ?? path.resolve(__dirname, "test-results/e2e-data");

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
    // 多语言（2026-09-06）：站点按 Cookie / Accept-Language 选语言，Chromium 默认 en-US
    // 会把整站渲染成英文、打红全部中文选择器。固定成简体中文；英文由 e2e/i18n.spec.ts 显式切换验证。
    locale: "zh-CN",
    extraHTTPHeaders: { "accept-language": "zh-CN" },
  },
  projects: [
    // `/api/*` needs a session now (plan §4): this project registers/logs in a
    // throwaway account through the real endpoints and saves the cookie.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        storageState: STORAGE_STATE,
      },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: `pnpm dev --port ${PORT}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !ISOLATED,
    timeout: 120_000,
    env: {
      LUMEN_FORCE_MOCK: "1",
      HARNESS_ENABLED: "1",
      // The server refuses to start without a session secret (plan §3). Fixed
      // throwaway value: e2e never depends on cookies surviving a restart.
      // admin.spec.ts also forges a session cookie with this secret — a reused
      // dev server must run the same value (and LUMEN_ADMIN_USER_ID) or the spec skips.
      LUMEN_SESSION_SECRET: E2E_SESSION_SECRET,
      // auth.setup.ts funds the throwaway account through the admin HTTP API;
      // a reused dev server must have the same token in its own env.
      LUMEN_ADMIN_TOKEN: E2E_ADMIN_TOKEN,
      // admin.spec.ts seeds this fixed id's user.json into DATA_DIR and forges its session.
      LUMEN_ADMIN_USER_ID: E2E_ADMIN_USER_ID,
      // agent.spec.ts 的对话模型白名单：两个 mock 条目，第二轮价不同。
      AGENT_CHAT_MODELS: '[{"id":"mock-agent","name":"Mock 甲"},{"id":"mock-agent-b","name":"Mock 乙","turnCny":0.08}]',
      // Only honoured when Playwright starts the server itself; a reused dev server keeps its data dir.
      DATA_DIR,
    },
  },
});
