import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { serverDataDir } from "./invites";

/**
 * Smoke for the single-screen studio (Genius) in mock mode:
 * empty state → text-to-video → console fly-in → `[fail]` retry / cancel → works ring → reuse →
 * first-frame upload → 30s harness → mobile. Each generation is a real job through /api/jobs;
 * the mock provider renders ffmpeg clips.
 */

const START_FRAME = path.resolve(__dirname, "../public/lumina/2e9cde0e2fb0803e.webp");

type Health = { ok: boolean; mockMode: boolean; harnessRunnable: boolean };

async function health(page: Page): Promise<Health> {
  const res = await page.request.get("/api/health");
  expect(res.ok(), "健康检查应通过").toBeTruthy();
  return (await res.json()) as Health;
}

const promptBox = (page: Page) => page.getByRole("textbox", { name: "提示词" });
const exhibit = (page: Page) => page.locator(".exhibit");

/** 时长 / 画幅芯片是点击循环的：点到目标值为止 */
async function cycleChip(page: Page, attr: "data-dur" | "data-ratio", want: string) {
  const chip = page.locator(`.chip[${attr}]`);
  for (let i = 0; i < 8; i++) {
    if ((await chip.getAttribute(attr)) === want) return;
    await chip.click();
  }
  await expect(chip).toHaveAttribute(attr, want);
}

async function submitPrompt(page: Page, prompt: string) {
  await promptBox(page).fill(prompt);
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await expect(page.locator(".stage")).toHaveAttribute("data-studio", "true");
  await expect(exhibit(page)).toHaveAttribute("data-job-id", /^job_[0-9a-f]+$/);
  return exhibit(page);
}

async function waitTerminal(page: Page) {
  await expect(exhibit(page)).toHaveAttribute("data-state", /^(done|failed)$/, { timeout: 150_000 });
}

const REQUIRE_MOCK = Boolean(process.env.CI || process.env.E2E_REQUIRE_MOCK);

test.beforeEach(async ({ page }) => {
  const h = await health(page);
  if (REQUIRE_MOCK) {
    // A skipped smoke must not read as a green gate (R12): under CI / E2E_REQUIRE_MOCK it fails loudly.
    expect(h.mockMode, "门禁要求 mock 模式的服务器，当前不是").toBeTruthy();
    expect(h.harnessRunnable, "门禁要求 HARNESS_ENABLED=1").toBeTruthy();
  }
  test.skip(!h.mockMode, "冒烟只在 mock 模式跑，避免消耗上游额度");
  await page.goto("/");
  // Dev-mode hydration lags the HTML; data-ready is only set from a client effect,
  // so its presence means React owns the page and clicks will not be swallowed.
  await expect(page.locator(".app")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
});

test("空态：顶栏、标题、输入卡、最近成片；工作室与作品环未出现", async ({ page }) => {
  await expect(page).toHaveTitle(/Genius/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("创建你的世界");
  await expect(promptBox(page)).toBeVisible();
  await expect(page.locator(".stage")).toHaveAttribute("data-studio", "false");
  await expect(page.locator(".recent__item")).toHaveCount(6);
  await expect(page.getByRole("radio", { name: "文生视频" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".chip[data-dur]")).toHaveText(/8s/);
  await expect(page.locator(".chip[data-ratio]")).toHaveText(/16:9/);
  // mock 的 audioAvailable 是 true：芯片可切换、默认有声（不可用的实例会是「无声 · 暂不可用」）
  const audioChip = page.locator(".chip[data-audio]");
  await expect(audioChip).toHaveAttribute("data-audio", "on");
  await expect(audioChip).toHaveText("有声");
  // 有声是加价项：切到无声，「本次约」必须跟着降——估价读的是芯片状态，不再恒按有声算
  const quota = page.locator(".composer__quota");
  await expect(quota).toBeVisible();
  const estimate = async () => Number(/¥([\d.]+)/.exec((await quota.textContent()) ?? "")?.[1]);
  const withAudio = await estimate();
  expect(withAudio).toBeGreaterThan(0);
  await audioChip.click();
  await expect(audioChip).toHaveText("无声");
  expect(await estimate()).toBeLessThan(withAudio);
  await audioChip.click();
  await expect(audioChip).toHaveAttribute("data-audio", "on");
  await expect(page.locator(".composer__model")).toContainText("grok-imagine-video");
  // 未进工作室：操作台留在 DOM 里但透明、不可点、对读屏隐藏（Playwright 的 hidden 不看 opacity）
  await expect(page.locator(".console")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".console")).toHaveCSS("opacity", "0");
  await expect(page.locator(".works__canvas")).toHaveCount(0);

  // 文生图：时长 / 音轨芯片消失，模型名切换
  await page.getByRole("radio", { name: "文生图" }).click();
  await expect(page.locator(".chip[data-dur]")).toHaveCount(0);
  await expect(page.locator(".chip[data-audio]")).toHaveCount(0);
  await expect(page.locator(".composer__model")).toContainText("grok-imagine-image");

  // 空提示词提交：提示错误，不进入工作室
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await expect(page.locator(".composer__error")).toHaveAttribute("role", "alert");
  await expect(page.locator(".composer__error")).toContainText("需要提示词");
  await expect(page.locator(".stage")).toHaveAttribute("data-studio", "false");
});

test("文生视频：输入即进工作室 → 操作台飞入 → 读数推进 → 成片铺满展览区", async ({ page }) => {
  await cycleChip(page, "data-dur", "4");
  await cycleChip(page, "data-ratio", "9:16");

  await promptBox(page).fill("雨夜的外滩，一位穿深青色风衣的女人走向江边");
  await expect(page.locator(".stage")).toHaveAttribute("data-studio", "true");
  await expect(page.locator(".console")).toBeVisible();
  await expect(exhibit(page)).toHaveAttribute("data-state", "idle");
  await expect(exhibit(page)).toContainText("预览");

  // 操作台：每组单选，提示词以空行分段追加；再点同一项取消
  await page.getByRole("button", { name: "胶片" }).click();
  await expect(promptBox(page)).toHaveValue("雨夜的外滩，一位穿深青色风衣的女人走向江边\n\n胶片颗粒质感，轻微暗角，柔和高光");
  await expect(page.getByRole("button", { name: "胶片" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "暖调" }).click();
  await expect(promptBox(page)).toHaveValue(/整体暖色调，金色阳光氛围$/);
  await page.getByRole("button", { name: "冷调" }).click();
  await expect(promptBox(page)).toHaveValue(/蓝灰清晨氛围$/);
  await expect(promptBox(page)).not.toHaveValue(/金色阳光/);
  await page.getByRole("button", { name: "冷调" }).click();
  await expect(promptBox(page)).toHaveValue("雨夜的外滩，一位穿深青色风衣的女人走向江边\n\n胶片颗粒质感，轻微暗角，柔和高光");
  // 手动删掉某段后，对应选中态同步取消
  await promptBox(page).fill("雨夜的外滩，一位穿深青色风衣的女人走向江边");
  await expect(page.getByRole("button", { name: "胶片" })).toHaveAttribute("aria-pressed", "false");

  const create = page.waitForRequest((r) => r.url().endsWith("/api/jobs") && r.method() === "POST");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  const body = (await create).postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({ mode: "text_to_video", durationSec: 4, aspectRatio: "9:16", resolution: "720p", generateAudio: true });
  expect(body).not.toHaveProperty("model");

  await expect(exhibit(page)).toHaveAttribute("data-state", "busy");
  await expect(exhibit(page).locator(".exhibit__pct")).toHaveText(/\d+%/);
  await expect(exhibit(page).getByRole("button", { name: "取消" })).toBeVisible();
  await expect(page.locator(".composer__send")).toHaveAttribute("data-busy", "true");

  await waitTerminal(page);
  await expect(exhibit(page)).toHaveAttribute("data-state", "done");
  await expect(page.locator(".composer__send")).toHaveAttribute("data-busy", "false");
  const video = exhibit(page).locator("video");
  await expect(video).toHaveAttribute("src", /\/api\/media\/job_[0-9a-f]+\/video\.mp4/);
  await expect(video).toHaveAttribute("poster", /poster\.jpg$/);
  await expect(exhibit(page).locator(".exhibit__meta")).toContainText("文生视频 · 4s · 720p · 9:16");
  await expect(exhibit(page).locator(".exhibit__meta")).toContainText("雨夜的外滩");
  const media = await page.request.get((await video.getAttribute("src"))!, { headers: { Range: "bytes=0-1" } });
  expect(media.status()).toBe(206);
  await expect(exhibit(page).getByRole("link", { name: "下载" })).toHaveAttribute("href", /download=1$/);

  // 成片框在输入卡上方、且不压到顶栏
  const box = (await exhibit(page).boundingBox())!;
  const composer = (await page.locator(".composer").boundingBox())!;
  const top = (await page.locator(".top").boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(composer.y);
  expect(box.y).toBeGreaterThanOrEqual(top.y + top.height);

  // 作品页：新成片排在最前
  await page.getByRole("button", { name: "作品", exact: true }).click();
  await expect(page.locator(".works__canvas")).toBeVisible();
  await expect(page.locator(".works__prompt")).toContainText("雨夜的外滩");
  await expect(page.getByRole("tab", { name: /视频/ })).toHaveAttribute("aria-selected", "true");
});

test("[fail] 标记：失败态 → 重新生成换新任务 → 取消", async ({ page }) => {
  const box = await submitPrompt(page, "[fail] 模拟上游失败");
  await expect(box).toHaveAttribute("data-state", "failed", { timeout: 60_000 });
  await expect(box.locator(".exhibit__pct")).toHaveText("失败");
  await expect(box.locator(".exhibit__err")).toContainText("模拟失败");
  const firstId = await box.getAttribute("data-job-id");
  const retry = box.getByRole("button", { name: "重新生成" });
  await expect(retry).toBeVisible();

  await retry.click();
  await expect(box).not.toHaveAttribute("data-job-id", firstId!);
  // The retry copies the prompt, so it fails the same way and the link comes back.
  await expect(box).toHaveAttribute("data-state", "failed", { timeout: 60_000 });
  await expect(retry).toBeVisible();
  await box.getByRole("button", { name: "关闭" }).click();
  await expect(box).toHaveAttribute("data-state", "idle");

  // Cancel on a fresh job: the mock clip takes a moment, so the window is real.
  await submitPrompt(page, "雪后的胡同口，晨光斜照");
  await box.getByRole("button", { name: "取消" }).click();
  await expect(box).toHaveAttribute("data-status", /^(canceled|succeeded)$/, { timeout: 60_000 });
});

test("作品页：分栏切换、拖拽旋转、用这条提示词再生成回填", async ({ page }) => {
  await page.locator(".recent__item").first().click();
  await expect(page.locator(".works__canvas")).toBeVisible();
  const prompt = (await page.locator(".works__prompt").textContent())!.trim();
  expect(prompt.length).toBeGreaterThan(0);
  await expect(page.locator(".works__meta")).toContainText(/文生视频|图生视频|文生图/);
  await expect(page.getByRole("link", { name: "下载" })).toBeVisible();

  const before = await page.locator(".works__angle").textContent();
  const canvas = page.locator(".works__canvas");
  const b = (await canvas.boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".works__angle")).not.toHaveText(before!);

  await page.getByRole("tab", { name: /图片/ }).click();
  await expect(page.getByRole("tab", { name: /图片/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: /视频/ }).click();

  await page.getByRole("button", { name: "用这条提示词再生成" }).click();
  await expect(page.locator(".stage")).toHaveAttribute("data-studio", "true");
  const value = await promptBox(page).inputValue();
  expect(prompt.replace(/\s+/g, "")).toBe(value.replace(/\s+/g, ""));
  await expect(promptBox(page)).toBeFocused();

  // 顶栏「首页」退出工作室
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await expect(page.locator(".stage")).toHaveAttribute("data-studio", "false");
});

test("图生视频：回形针上传首帧自动切路径，请求带 startUploadId，任务完成", async ({ page }) => {
  const upload = page.waitForResponse((r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST");
  await page.locator("input[type=file]").setInputFiles(START_FRAME);
  expect((await upload).ok()).toBeTruthy();

  await expect(page.getByRole("radio", { name: "图生视频" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".composer__clip")).toHaveAttribute("data-on", "true");
  await expect(page.locator(".composer__clip")).toHaveAttribute("data-state", "ready");
  await expect(promptBox(page)).toHaveAttribute("placeholder", "已选首帧，提示词可选");

  const create = page.waitForRequest((r) => r.url().endsWith("/api/jobs") && r.method() === "POST");
  await submitPrompt(page, "镜头继续缓慢推进，雨滴在灯光中闪烁");
  const body = (await create).postDataJSON() as Record<string, unknown>;
  expect(body.mode).toBe("image_to_video");
  expect(body.startUploadId).toMatch(/^up_[0-9a-f]{16}$/);
  expect(body).not.toHaveProperty("model");

  await waitTerminal(page);
  await expect(exhibit(page)).toHaveAttribute("data-state", "done");
  await expect(exhibit(page).locator(".exhibit__meta")).toContainText("图生视频");
});

test("长片：30s 走一致性管线，分镜读数推进到成片", async ({ page }) => {
  const h = await health(page);
  test.skip(!h.harnessRunnable, "HARNESS_ENABLED 未开启");
  await cycleChip(page, "data-dur", "30");
  await expect(page.locator(".composer__model")).toContainText("≈ $2.10");

  const box = await submitPrompt(page, "清晨的山谷薄雾，镜头缓慢推进，一位登山者沿山脊行走");
  await expect(box.locator(".exhibit__stage")).toContainText(/生成分镜 \d\/2/, { timeout: 60_000 });
  await waitTerminal(page);
  await expect(box).toHaveAttribute("data-state", "done");
  await expect(box.locator(".exhibit__meta")).toContainText("30s · 720p");

  const id = await box.getAttribute("data-job-id");
  const job = await page.request.get(`/api/jobs/${id}`);
  const json = (await job.json()) as { harness: { enabled: boolean }; shots: Array<{ status: string }>; output: { durationSec: number } };
  expect(json.harness.enabled).toBe(true);
  expect(json.shots.map((s) => s.status)).toEqual(["succeeded", "succeeded"]);
  expect(json.output.durationSec).toBeGreaterThan(29.5);
  expect(json.output.durationSec).toBeLessThan(30.6);
});

/**
 * 留存清理（方案 §8）后的作品。清理由 runner 的每小时定时器按 DATA_RETENTION_DAYS
 * 触发，没有「立刻清理」的接口，所以这里直接写一条已清理的记录进服务器的 data 目录——
 * 天数边界由 `src/lib/jobs/retention.test.ts` 钉住，这条只验 UI 与重试出口。
 * createdAt 取当下，好让它稳定排在作品列表最前，不依赖前面用例留下了几条作品。
 */
test("已清理作品：环上是占位卡、无成片请求、重试被拒", async ({ page }) => {
  const me = await page.request.get("/api/me");
  expect(me.ok(), "需要已登录会话").toBeTruthy();
  const { userId } = (await me.json()) as { userId: string };

  const jobId = `job_${randomBytes(6).toString("hex")}`;
  const jobDir = path.join(await serverDataDir(), "jobs", jobId);
  const now = new Date().toISOString();
  await mkdir(jobDir, { recursive: true });
  await writeFile(
    path.join(jobDir, "job.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: jobId,
      ownerId: userId,
      // 清理只写 artifactsPurgedAt，status 仍是 succeeded：终态没有出边。
      status: "succeeded",
      artifactsPurgedAt: now,
      progress: 100,
      mode: "text_to_image",
      model: "grok-imagine-image-2.0",
      provider: "mock",
      prompt: "被清理的旧作品，海边的灯塔",
      durationSec: 0,
      aspectRatio: "16:9",
      resolution: null,
      imageResolution: "1k",
      generateAudio: false,
      lastFrameStored: false,
      lastFrameLocksOutput: false,
      harness: { enabled: false },
      costUsdEstimate: 0.02,
      costUsdActual: 0.02,
      error: null,
      // outputs/ 已被删，URL 还在记录里——UI 必须靠 artifactsPurgedAt 而不是靠 404 才知道。
      output: { kind: "image", imageUrl: `/api/media/${jobId}/image.jpg` },
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      bible: null,
      shots: null,
      assets: {},
    }),
  );

  try {
    const mediaHits: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes(`/api/media/${jobId}`)) mediaHits.push(r.url());
    });
    await page.reload();
    await expect(page.locator(".app")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });

    // 首页最近成片：占位态，且背景图不是被删掉的成片
    const purgedTile = page.locator('.recent__item[data-purged="true"]');
    await expect(purgedTile).toHaveCount(1);
    await expect(purgedTile).toHaveCSS("background-image", /purged\.svg/);

    await purgedTile.click();
    await expect(page.locator(".works__canvas")).toBeVisible();
    await expect(page.locator(".works__purged")).toContainText("作品已过期清理");
    await expect(page.locator(".works__prompt")).toContainText("海边的灯塔");
    // 没有播放 / 下载入口；「用这条提示词再生成」留着
    await expect(page.getByRole("link", { name: "下载" })).toHaveCount(0);
    await expect(page.locator('img[src^="/api/media/"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "用这条提示词再生成" })).toBeEnabled();
    expect(mediaHits, "已清理作品不该再去请求成片").toEqual([]);

    // 一键重试被服务端拒绝（方案 §8：输入已删，只能重新提交）
    const retry = await page.request.post(`/api/jobs/${jobId}/retry`);
    expect(retry.status()).toBe(409);
    expect(await retry.json()).toMatchObject({
      error: { code: "artifacts_purged", message: "作品已过期清理，请用这条提示词重新生成" },
    });

    await page.getByRole("button", { name: "用这条提示词再生成" }).click();
    await expect(promptBox(page)).toHaveValue(/海边的灯塔/);
  } finally {
    // 复用开发服务器时这条记录会落在真实 data/ 里，跑完带走。
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("手机端：文生图成片在输入卡上方，页面不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("radio", { name: "文生图", exact: true }).click();
  await submitPrompt(page, "晨光中的山谷");
  await waitTerminal(page);
  await expect(exhibit(page)).toHaveAttribute("data-state", "done");
  await expect(exhibit(page).locator("img")).toBeInViewport();
  const resultBox = (await exhibit(page).boundingBox())!;
  const composerBox = (await page.locator(".composer").boundingBox())!;
  expect(resultBox.y + resultBox.height).toBeLessThanOrEqual(composerBox.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
