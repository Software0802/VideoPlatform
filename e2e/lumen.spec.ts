import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Smoke for the single-page studio in mock mode:
 * empty state → text-to-video → `[fail]` retry → archive detail → first-frame upload → 30s harness.
 * Each generation is a real job through /api/jobs; the mock provider renders ffmpeg clips.
 */

const START_FRAME = path.resolve(__dirname, "../public/lumina/2e9cde0e2fb0803e.webp");
const TERMINAL = /失败|完成 \/ Done/;

type Health = { ok: boolean; mockMode: boolean; harnessRunnable: boolean };

async function health(page: Page): Promise<Health> {
  const res = await page.request.get("/api/health");
  expect(res.ok(), "健康检查应通过").toBeTruthy();
  return (await res.json()) as Health;
}

async function openTray(page: Page) {
  const summary = page.locator(".prompt__summary");
  if ((await summary.getAttribute("aria-expanded")) !== "true") await summary.click();
  await expect(page.getByRole("radiogroup", { name: "路径" })).toBeVisible();
}

async function submitPrompt(page: Page, prompt: string) {
  await page.getByRole("textbox", { name: "提示词" }).fill(prompt);
  await page.getByRole("button", { name: "Generate 生成" }).click();
  const readout = page.locator(".readout");
  await expect(readout).toBeVisible();
  return readout;
}

async function waitTerminal(page: Page) {
  await expect(page.locator(".readout__meta")).toContainText(TERMINAL, { timeout: 150_000 });
}

test.beforeEach(async ({ page }) => {
  const h = await health(page);
  test.skip(!h.mockMode, "冒烟只在 mock 模式跑，避免消耗上游额度");
  await page.goto("/");
  // Dev-mode hydration lags the HTML; the hero canvas is only mounted from a client effect,
  // so its presence means React owns the page and clicks will not be swallowed.
  await expect(page.locator(".hero canvas")).toHaveCount(1);
});

test("空态：首屏、三条路径、画廊与存档都在", async ({ page }) => {
  await expect(page).toHaveTitle(/流光|Lumen/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("写下一个镜头");
  await expect(page.getByRole("textbox", { name: "提示词" })).toBeVisible();
  await expect(page.locator(".prompt__top")).toContainText("Idle · 待机");
  await expect(page.locator(".readout")).toHaveCount(0);
  await expect(page.locator(".hero__legend")).toContainText("Mock · 模拟输出");

  await expect(page.locator(".path")).toHaveCount(3);
  await expect(page.locator(".path__title")).toHaveText(["文生视频", "图生视频", "文生图"]);
  await expect(page.locator("#gallery canvas")).toBeVisible();
  await expect(page.locator("#archive .plate").first()).toBeVisible();

  // Path card: sets the mode, opens the tray, scrolls back to the prompt box.
  await page.locator(".path", { hasText: "文生图" }).click();
  await expect(page.getByRole("radio", { name: "文生图" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radiogroup", { name: "时长" })).toHaveCount(0);
});

test("文生视频：提交 → 读数推进 → 成片区块出现", async ({ page }) => {
  await openTray(page);
  await page.getByRole("radio", { name: "4s" }).click();
  await page.getByRole("radio", { name: "9:16" }).click();
  await expect(page.locator(".prompt__summary")).toContainText("文生视频 · 4s · 9:16");

  const readout = await submitPrompt(page, "雨夜的外滩，一位穿深青色风衣的女人走向江边");
  await expect(readout.locator(".readout__id")).toContainText(/Job [0-9A-F]{4}/);
  await expect(page.locator(".prompt__top")).toContainText("Rendering · 渲染中");
  await expect(readout.getByRole("button", { name: /取消任务/ })).toBeVisible();

  await waitTerminal(page);
  await expect(readout.locator(".readout__meta")).toContainText("完成 / Done");
  await expect(readout.locator(".readout__pct")).toHaveText("100%");
  await expect(page.locator(".prompt__top")).toContainText("Done · 已完成");

  const output = page.locator(".output");
  await expect(output).toBeVisible();
  await expect(output.locator(".output__prompt")).toContainText("雨夜的外滩");
  await expect(output).toContainText("4s · 720p · 9:16");
  const video = output.locator("video");
  await expect(video).toHaveAttribute("src", /\/api\/media\/job_[0-9a-f]+\/video\.mp4/);
  await expect(video).toHaveAttribute("poster", /poster\.jpg$/);
  const media = await page.request.get((await video.getAttribute("src"))!, { headers: { Range: "bytes=0-1" } });
  expect(media.status()).toBe(206);
  await expect(page.locator(".output .link-accent")).toHaveAttribute("href", /download=1$/);

  // The new plate lands at the top of the archive.
  await expect(page.locator("#archive .plate").first()).toContainText("雨夜的外滩");
});

test("[fail] 标记：失败读数 → Retry 换新任务 → 取消", async ({ page }) => {
  const readout = await submitPrompt(page, "[fail] 模拟上游失败");
  await expect(readout.locator(".readout__meta")).toContainText("失败 / Failed", { timeout: 60_000 });
  await expect(readout.locator(".readout__err")).toContainText("模拟失败");
  const firstId = await readout.locator(".readout__id").textContent();
  const retry = readout.getByRole("button", { name: /重新生成/ });
  await expect(retry).toBeVisible();

  await retry.click();
  await expect(readout.locator(".readout__id")).not.toHaveText(firstId!);
  // The retry copies the prompt, so it fails the same way and the link comes back.
  await expect(readout.locator(".readout__meta")).toContainText("失败 / Failed", { timeout: 60_000 });
  await expect(retry).toBeVisible();

  // Cancel on a fresh job: the mock clip takes a moment, so the window is real.
  const cancelReadout = await submitPrompt(page, "雪后的胡同口，晨光斜照");
  const cancel = cancelReadout.getByRole("button", { name: /取消任务/ });
  await cancel.click();
  await expect(cancelReadout.locator(".readout__meta")).toContainText(/Canceled|完成 \/ Done/, { timeout: 60_000 });
});

test("存档 → 任务详情 → Reuse 回填提示词", async ({ page }) => {
  const plate = page.locator("#archive .plate").first();
  const prompt = (await plate.locator(".plate__prompt").textContent())!.trim();
  await plate.click();

  const detail = page.locator(".detail");
  await expect(detail).toBeVisible();
  await expect(detail.locator(".detail__prompt")).toHaveText(prompt);
  await expect(detail.locator(".facts__row")).toHaveCount(5);
  await expect(detail).toContainText("成本 / Cost");
  await expect(plate).toHaveAttribute("data-on", "true");

  await detail.getByRole("button", { name: /Reuse/ }).click();
  await expect(detail).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "提示词" })).toHaveValue(prompt);
  await expect(page.getByRole("textbox", { name: "提示词" })).toBeFocused();
});

test("图生视频：上传首帧自动切路径，请求带 startUploadId，任务完成", async ({ page }) => {
  await openTray(page);
  const upload = page.waitForResponse((r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST");
  await page.locator("input[type=file]").first().setInputFiles(START_FRAME);
  expect((await upload).ok()).toBeTruthy();

  await expect(page.getByRole("radio", { name: "图生视频" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".frame-btn").first()).toContainText("首帧 ✓");
  await expect(page.locator(".prompt__summary")).toContainText("首帧");

  const create = page.waitForRequest((r) => r.url().endsWith("/api/jobs") && r.method() === "POST");
  await submitPrompt(page, "镜头继续缓慢推进，雨滴在灯光中闪烁");
  const body = (await create).postDataJSON() as Record<string, unknown>;
  expect(body.mode).toBe("image_to_video");
  expect(body.startUploadId).toMatch(/^up_[0-9a-f]{16}$/);
  expect(body).not.toHaveProperty("model");

  await waitTerminal(page);
  await expect(page.locator(".output")).toContainText("图生视频");
});

test("长片：30s 走一致性管线，分镜读数推进到成片", async ({ page }) => {
  const h = await health(page);
  test.skip(!h.harnessRunnable, "HARNESS_ENABLED 未开启");
  await openTray(page);
  await page.getByRole("radio", { name: "30s 长片" }).click();
  await expect(page.locator(".prompt__summary")).toContainText("Grok · harness · 文生视频 · 长片 30s · ≈ $2.10");

  const readout = await submitPrompt(page, "清晨的山谷薄雾，镜头缓慢推进，一位登山者沿山脊行走");
  await expect(readout.locator(".readout__meta")).toContainText(/生成分镜 \/ Shots \d\/2/, { timeout: 60_000 });
  await waitTerminal(page);
  await expect(readout.locator(".readout__meta")).toContainText("完成 / Done");

  const output = page.locator(".output");
  await expect(output).toContainText("30s · 720p");
  const job = await page.request.get(`/api/jobs/${(await output.locator("video").getAttribute("src"))!.split("/")[3]}`);
  const json = (await job.json()) as { harness: { enabled: boolean }; shots: Array<{ status: string }>; output: { durationSec: number } };
  expect(json.harness.enabled).toBe(true);
  expect(json.shots.map((s) => s.status)).toEqual(["succeeded", "succeeded"]);
  expect(json.output.durationSec).toBeGreaterThan(29.5);
  expect(json.output.durationSec).toBeLessThan(30.6);
});
