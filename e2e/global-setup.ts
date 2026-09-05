import type { FullConfig } from "@playwright/test";

/**
 * 冒烟用例会真实提交任务。复用外部服务（PLAYWRIGHT_BASE_URL）时必须确认它跑在 mock 模式，
 * 否则 `[fail]` 不再稳定失败，且每条用例都会消耗 xAI 额度。
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("playwright.config.ts 未设置 baseURL");
  const url = new URL("/api/health", baseURL).toString();
  let health: { mockMode?: unknown; grokKeyPresent?: unknown };
  try {
    const res = await fetch(url);
    health = (await res.json()) as typeof health;
  } catch (e) {
    throw new Error(`无法读取 ${url}：${e instanceof Error ? e.message : String(e)}`);
  }
  if (health.mockMode !== true) {
    throw new Error(
      `拒绝运行：${baseURL} 不是 mock 模式（mockMode=${String(health.mockMode)}，grokKeyPresent=${String(health.grokKeyPresent)}）。` +
        "冒烟会真实提交任务并消耗 xAI 额度；请用 LUMEN_FORCE_MOCK=1 启动服务，或去掉 PLAYWRIGHT_BASE_URL 让 Playwright 自起 mock 实例。",
    );
  }
}
