import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/**
 * 冒烟用例只跑 mock 模式，并把任务数据指到临时目录，避免污染 data/jobs 存档。
 * 设置 PLAYWRIGHT_BASE_URL 时复用已在跑的服务（例如 lumen-dev 的 3000 端口）；
 * 否则 build + start 一个独立的 3100 端口实例（Next 16 同目录不允许第二个 `next dev`）。
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";
const dataDir = path.join(__dirname, ".tmp", "e2e-data");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  outputDir: ".tmp/e2e-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // three.js 卷盘 / 环形画廊需要 WebGL，headless 下走 SwiftShader
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
      },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "pnpm build && pnpm start -p 3100",
        url: "http://localhost:3100/api/health",
        timeout: 240_000,
        reuseExistingServer: false,
        env: { LUMEN_FORCE_MOCK: "1", DATA_DIR: dataDir, JOB_CONCURRENCY: "2" },
      },
});
