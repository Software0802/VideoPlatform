import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { serverDataDir } from "./invites";

/**
 * Smoke suite for the Genius App shell (docs/plan-ui-genius-app.md §7 DOM contract:
 * sidebar + five views + floating composer). Written *against the contract* while
 * two coders build `src/components/genius/**` in parallel — the selectors below are
 * the frozen interface both sides agreed on, not something read off running code.
 *
 * Replaces `e2e/lumen.spec.ts` (the old single-screen Genius home). Same mock-mode
 * gate, same funded account: `auth.setup.ts` registers through the real API and
 * tops it up ¥1000 = 100000 积分 (¥1 = 100, AGENTS.md hard rule) before any test
 * here runs, so the very first test can assert an exact credits figure.
 *
 * Where §7's table doesn't pin a detail, the choice is corroborated against
 * `design_handoff/design_handoff_genius_app/Genius App.dc.html` (the prototype's own
 * `openSpecs` toggle, its `res/ratio/dur` fields, the "个人" account-chip filler that
 * pushed identity into the avatar menu) and called out below and in the handoff
 * report so coder and tester can align on the same reading.
 */

const START_FRAME = path.resolve(__dirname, "../public/lumina/2e9cde0e2fb0803e.webp");

type Health = { ok: boolean; mockMode: boolean; harnessRunnable: boolean };

async function health(page: Page): Promise<Health> {
  const res = await page.request.get("/api/health");
  expect(res.ok(), "健康检查应通过").toBeTruthy();
  return (await res.json()) as Health;
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
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
});

// ---------------------------------------------------------------------------
// Shared locators / actions (§7 selectors only — nothing invented that isn't in
// the contract table, except where a comment says so and flags it as a guess).
// ---------------------------------------------------------------------------

const promptBox = (page: Page) => page.getByRole("textbox", { name: "提示词" });
const composer = (page: Page) => page.locator(".composer");
const sendButton = (page: Page) => page.getByRole("button", { name: "创作", exact: true });
const topCredits = (page: Page) => page.locator(".top__credits");

function taskById(page: Page, jobId: string): Locator {
  return page.locator(`.task[data-job-id="${jobId}"]`);
}

/** `.top__credits`'s `aria-label="积分 n"` (§7) — a structured read, never a full-string compare. */
async function creditsNow(page: Page): Promise<number> {
  const label = await topCredits(page).getAttribute("aria-label");
  const n = Number(/^积分 (\d+)$/.exec(label ?? "")?.[1]);
  expect(Number.isFinite(n), `.top__credits 的 aria-label 应形如"积分 n"，实际 "${label}"`).toBeTruthy();
  return n;
}

/** The estimate shown inside the send button (§7: `button.composer__send` 含 `.composer__credits`). */
async function pendingCredits(page: Page): Promise<number> {
  const text = (await sendButton(page).locator(".composer__credits").textContent()) ?? "";
  const n = Number(text.replace(/\D+/g, ""));
  expect(Number.isFinite(n), `.composer__credits 应包含数字，实际 "${text}"`).toBeTruthy();
  return n;
}

/**
 * Home's collapsed bar → expanded panel. Composer state lives in ShellContext, shared
 * by every shell route (plan §3), so a panel already open from an earlier client-side
 * navigation must not be re-collapsed by clicking the bar again.
 */
async function ensureComposerOpen(page: Page) {
  if ((await composer(page).getAttribute("data-open")) === "true") return;
  await page.getByRole("button", { name: "描述你想创作的内容" }).click();
  await expect(composer(page)).toHaveAttribute("data-open", "true");
}

/**
 * ASSUMPTION (flagged in the handoff report): `.composer__specs` is a toggle button,
 * not a plain dropdown trigger — mirrored from the prototype's own
 * `openSpecs: () => setState({ pop: s.pop === 'specs' ? null : 'specs' })`. Clicking it
 * a second time is expected to close `.specs-pop` again.
 */
async function withSpecsPop(page: Page, fn: (pop: Locator) => Promise<void>) {
  await page.locator(".composer__specs").click();
  const pop = page.locator(".specs-pop");
  await expect(pop).toBeVisible();
  await fn(pop);
  await page.locator(".composer__specs").click();
  await expect(pop).toBeHidden();
}

async function setSpecs(page: Page, opts: { res?: string; ratio?: string; dur?: number }) {
  await withSpecsPop(page, async (pop) => {
    for (const [attr, value] of [
      ["data-res", opts.res],
      ["data-ratio", opts.ratio],
      ["data-dur", opts.dur],
    ] as const) {
      if (value === undefined) continue;
      const btn = pop.locator(`button[${attr}="${value}"]`);
      await btn.click();
      await expect(btn).toHaveAttribute("aria-pressed", "true");
    }
  });
}

async function waitTerminal(task: Locator) {
  await expect(task).toHaveAttribute("data-state", /^(done|failed)$/, { timeout: 150_000 });
}

// ---------------------------------------------------------------------------

test("空态：壳水合、侧栏五项、顶栏标题与积分、收起态输入条、瀑布流空态", async ({ page }) => {
  await expect(page).toHaveTitle(/Genius/);

  // 侧栏：五个导航项，当前在主页（§7：nav 内 link 名，当前项 aria-current="page"）
  const nav = page.locator("nav");
  await expect(nav.getByRole("link")).toHaveCount(5);
  for (const name of ["主页", "创作", "智能体", "画布", "订阅"]) {
    await expect(nav.getByRole("link", { name })).toBeVisible();
  }
  await expect(nav.getByRole("link", { name: "主页" })).toHaveAttribute("aria-current", "page");

  // 顶栏标题 + 积分。账号是 auth.setup.ts 用 grant-balance.mjs 充值的 ¥1000，
  // 按 ¥1=100 积分（AGENTS.md 硬约束）换算就是 100000——这是本文件第一条用例，
  // 后面的用例才开始真的花钱，所以这里可以断言精确值而不是宽松的 ">0"。
  await expect(page.locator(".top__title")).toHaveText("主页");
  await expect(topCredits(page)).toHaveAttribute("aria-label", "积分 100000");

  // 瀑布流空态（composer 还没打开，"视频/图片"这两个 tab 名不会跟面板内的同名 tab 冲突）
  const main = page.getByRole("main");
  await expect(main.getByRole("tab", { name: "视频" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".masonry__item")).toHaveCount(0);
  await main.getByRole("tab", { name: "图片" }).click();
  await expect(page.locator(".masonry__item")).toHaveCount(0);

  // 主页收起态输入条：composer 留在 DOM 里但未展开
  await expect(composer(page)).toHaveAttribute("data-open", "false");
  await expect(page.getByRole("button", { name: "描述你想创作的内容" })).toBeVisible();

  // 空提示词提交：本地校验拦下，不发请求、不跳转（ASSUMPTION：新壳仍然拦，见报告）
  await ensureComposerOpen(page);
  await sendButton(page).click();
  await expect(page.locator(".composer__error")).toHaveAttribute("role", "alert");
  await expect(page).toHaveURL(/\/$/);
});

test("文生视频：规格弹层选参数 → 创作 → 跳转 /create → 成片可见 → 按估价扣积分", async ({ page }) => {
  await ensureComposerOpen(page);
  await expect(composer(page).getByRole("tab", { name: "视频" })).toHaveAttribute("aria-selected", "true");
  await expect(composer(page).getByRole("radio", { name: "图文" })).toHaveAttribute("aria-checked", "true");

  await setSpecs(page, { res: "720p", ratio: "9:16", dur: 8 });
  const specs = page.locator(".composer__specs");
  await expect(specs).toContainText("720P");
  await expect(specs).toContainText("9:16");
  await expect(specs).toContainText("8s");

  // mock 模式的诚实标注（方案 §4）：模型芯片必须带出处，不能看起来像真的 Grok 出片
  await expect(page.locator(".composer__model")).toContainText("模拟");

  // 有声是加价项：关掉应让预估积分变少（方向性断言，不写死具体数字——见 README 图 6
  // "积分 50→40" 那是原型的静态样例，接了真后端后基价单位是人民币分，不是那两个数）
  const audioSwitch = page.locator('.composer__audio[role="switch"]');
  await expect(audioSwitch).toHaveAttribute("aria-checked", "true");
  const creditsWithAudio = await pendingCredits(page);
  await audioSwitch.click();
  await expect(audioSwitch).toHaveAttribute("aria-checked", "false");
  expect(await pendingCredits(page)).toBeLessThan(creditsWithAudio);
  await audioSwitch.click();
  await expect(audioSwitch).toHaveAttribute("aria-checked", "true");
  expect(await pendingCredits(page)).toBe(creditsWithAudio);

  await promptBox(page).fill("雨夜的外滩，一位穿深青色风衣的女人走向江边");

  const creditsBefore = await creditsNow(page);
  const willCharge = await pendingCredits(page);
  expect(willCharge).toBeGreaterThan(0);

  const created = page.waitForResponse((r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST");
  await sendButton(page).click();
  const res = await created;
  const body = res.request().postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({
    mode: "text_to_video",
    durationSec: 8,
    aspectRatio: "9:16",
    resolution: "720p",
    generateAudio: true,
  });
  // AGENTS.md 硬约束：createJobBodySchema 是 .strict()，没有 model 字段，模型由服务端按 mode 决定。
  expect(body).not.toHaveProperty("model");

  const jobId = ((await res.json()) as { id: string }).id;
  await expect(page).toHaveURL(/\/create$/);

  const task = taskById(page, jobId);
  await expect(task).toHaveAttribute("data-state", "busy");
  await expect(task.locator(".task__pct")).toContainText(/\d/);
  await expect(task.getByRole("button", { name: "取消" })).toBeVisible();

  await waitTerminal(task);
  await expect(task).toHaveAttribute("data-state", "done");

  const video = task.locator("video");
  await expect(video).toHaveAttribute("src", new RegExp(`/api/media/${jobId}/video\\.mp4`));
  await expect(video).toHaveAttribute("poster", /poster\.jpg$/);

  const src = (await video.getAttribute("src"))!;
  const media = await page.request.get(src, { headers: { Range: "bytes=0-1" } });
  expect(media.status()).toBe(206);
  // AGENTS.md 硬约束：媒体缓存必须是 private,no-cache，不能改成 max-age/immutable——
  // 产物字节不变但"谁能读"会变（同浏览器换账号登录），长缓存会让浏览器绕过 owner 校验直接吃缓存。
  expect(media.headers()["cache-control"]).toBe("private, no-cache");

  await expect(task.getByRole("link", { name: "下载" })).toHaveAttribute("href", /download=1$/);

  // 扣款：先扣后写终态（AGENTS.md 硬约束）。UI 上体现为"提交前积分 − 送出时显示的预估 = 提交后积分"，
  // 不硬编码具体数字，直接把这条链路的两头对上。
  expect(await creditsNow(page)).toBe(creditsBefore - willCharge);

  // 作品详情浮层（§7：.work[role="dialog"]）：主页瀑布流里能找到这条成片并打开详情
  await page.locator("nav").getByRole("link", { name: "主页" }).click();
  await expect(page).toHaveURL(/\/$/);
  const card = page.getByRole("main").locator('.masonry__item[data-kind="video"]').first();
  await expect(card).toBeVisible();
  await card.click();
  const dialog = page.locator('.work[role="dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("video")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "下载" })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toBeHidden();
});

test("[fail] 标记：失败态不扣款 → 重新生成换新任务 → 取消", async ({ page }) => {
  await ensureComposerOpen(page);
  await promptBox(page).fill("[fail] 模拟上游失败");
  const creditsBeforeFail = await creditsNow(page);

  const created1 = page.waitForResponse((r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST");
  await sendButton(page).click();
  const firstId = ((await (await created1).json()) as { id: string }).id;
  await expect(page).toHaveURL(/\/create$/);

  const task1 = taskById(page, firstId);
  await waitTerminal(task1);
  await expect(task1).toHaveAttribute("data-state", "failed");
  // §7 没有给"失败原因"专门的类名（只列了 .task__pct / .task__stage），所以对整个
  // task 容器做包含性文本检查，而不是猜一个 .task__err 之类的选择器。
  await expect(task1).toContainText("模拟失败");
  // 失败不扣钱（AGENTS.md：失败/取消/过期不扣钱，预留随终态消失）。
  expect(await creditsNow(page)).toBe(creditsBeforeFail);

  const retryBtn1 = task1.getByRole("button", { name: "重新生成" });
  await expect(retryBtn1).toBeVisible();
  const retried = page.waitForResponse((r) => /\/api\/jobs\/[^/]+\/retry$/.test(r.url()) && r.request().method() === "POST");
  await retryBtn1.click();
  const secondId = ((await (await retried).json()) as { id: string }).id;
  expect(secondId).not.toBe(firstId);

  const task2 = taskById(page, secondId);
  await waitTerminal(task2);
  await expect(task2).toHaveAttribute("data-state", "failed");
  // 重试复制了同一条 [fail] 提示词，所以还是同样的失败，「重新生成」按钮还在（可以无限重试）。
  await expect(task2.getByRole("button", { name: "重新生成" })).toBeVisible();
  expect(await creditsNow(page)).toBe(creditsBeforeFail);

  // 提交一条正常任务并取消：mock 出片要几秒，取消窗口是真实的（不是靠运气）。
  await ensureComposerOpen(page);
  await promptBox(page).fill("雪后的胡同口，晨光斜照");
  const created3 = page.waitForResponse((r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST");
  await sendButton(page).click();
  const thirdId = ((await (await created3).json()) as { id: string }).id;
  const task3 = taskById(page, thirdId);
  await expect(task3).toHaveAttribute("data-state", "busy");
  await task3.getByRole("button", { name: "取消" }).click();
  await expect(task3).toHaveAttribute("data-status", /^(canceled|succeeded)$/, { timeout: 60_000 });
});

test("图生视频：上传首帧切换 data-mode，请求体带 startUploadId", async ({ page }) => {
  await ensureComposerOpen(page);
  await expect(composer(page).getByRole("radio", { name: "图文" })).toHaveAttribute("aria-checked", "true");

  const upload = page.waitForResponse((r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST");
  await page.getByLabel("上传图片").setInputFiles(START_FRAME);
  expect((await upload).ok()).toBeTruthy();

  await expect(page.locator(".composer__slot")).toHaveAttribute("data-state", "ready");
  await expect(composer(page)).toHaveAttribute("data-mode", "image_to_video");

  await promptBox(page).fill("镜头继续缓慢推进，雨滴在灯光中闪烁");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST");
  await sendButton(page).click();
  const res = await created;
  const body = res.request().postDataJSON() as Record<string, unknown>;
  expect(body.mode).toBe("image_to_video");
  expect(body.startUploadId).toMatch(/^up_[0-9a-f]{16}$/);
  expect(body).not.toHaveProperty("model");

  const jobId = ((await res.json()) as { id: string }).id;
  const task = taskById(page, jobId);
  await waitTerminal(task);
  await expect(task).toHaveAttribute("data-state", "done");
  await expect(task.locator("video")).toBeVisible();
});

test("图片页：文生图产出静态图", async ({ page }) => {
  await ensureComposerOpen(page);
  await composer(page).getByRole("tab", { name: "图片" }).click();
  await expect(composer(page)).toHaveAttribute("data-tab", "image");
  // README §4：图片页模式行换成静态的「默认」标签（ASSUMPTION，见报告）。
  await expect(composer(page).getByRole("radio", { name: "默认" })).toHaveAttribute("aria-checked", "true");

  await promptBox(page).fill("晨光中的山谷");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST");
  await sendButton(page).click();
  const res = await created;
  const body = res.request().postDataJSON() as Record<string, unknown>;
  expect(body.mode).toBe("text_to_image");
  expect(body).not.toHaveProperty("model");

  const jobId = ((await res.json()) as { id: string }).id;
  const task = taskById(page, jobId);
  await waitTerminal(task);
  await expect(task).toHaveAttribute("data-state", "done");
  await expect(task.locator("img")).toBeVisible();
});

test("长片：30s 走一致性管线，分镜读数推进到成片", async ({ page }) => {
  const h = await health(page);
  test.skip(!h.harnessRunnable, "HARNESS_ENABLED 未开启");

  await ensureComposerOpen(page);
  await setSpecs(page, { dur: 30 });
  await expect(page.locator(".composer__specs")).toContainText("30s");

  await promptBox(page).fill("清晨的山谷薄雾，镜头缓慢推进，一位登山者沿山脊行走");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST");
  await sendButton(page).click();
  const res = await created;
  const jobId = ((await res.json()) as { id: string }).id;
  const task = taskById(page, jobId);

  await expect(task.locator(".task__stage")).toContainText(/生成分镜 \d\/2/, { timeout: 60_000 });
  await waitTerminal(task);
  await expect(task).toHaveAttribute("data-state", "done");

  const job = await page.request.get(`/api/jobs/${jobId}`);
  const json = (await job.json()) as {
    harness: { enabled: boolean };
    shots: Array<{ status: string }>;
    output: { durationSec: number };
  };
  expect(json.harness.enabled).toBe(true);
  expect(json.shots.map((s) => s.status)).toEqual(["succeeded", "succeeded"]);
  expect(json.output.durationSec).toBeGreaterThan(29.5);
  expect(json.output.durationSec).toBeLessThan(30.6);
});

/**
 * 留存清理（方案 §8）后的作品。清理由 runner 的每小时定时器按 DATA_RETENTION_DAYS
 * 触发，没有「立刻清理」的接口，所以直接写一条已清理的记录进服务器的 data 目录——
 * 天数边界由 `src/lib/jobs/retention.test.ts` 钉住，这里只验 UI 出口与重试拒绝。
 */
test("已清理作品：瀑布流占位卡、无成片请求、一键重试被拒", async ({ page }) => {
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
    await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });

    // 这条记录是 text_to_image → kind "image"，瀑布流按 kind 分标签页（§7），得先切过去。
    await page.getByRole("main").getByRole("tab", { name: "图片" }).click();
    const purgedTile = page.locator('.masonry__item[data-purged="true"]');
    await expect(purgedTile).toHaveCount(1);

    await purgedTile.click();
    const dialog = page.locator('.work[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/过期清理/);
    await expect(dialog).toContainText("海边的灯塔");
    // 没有播放 / 下载入口；「用这条提示词再生成」留着
    await expect(dialog.getByRole("link", { name: "下载" })).toHaveCount(0);
    await expect(dialog.locator('img[src^="/api/media/"]')).toHaveCount(0);
    const reuseBtn = dialog.getByRole("button", { name: "用这条提示词再生成" });
    await expect(reuseBtn).toBeEnabled();
    expect(mediaHits, "已清理作品不该再去请求成片字节").toEqual([]);

    // 一键重试被服务端拒绝（方案 §8：输入已删，只能重新提交）
    const retry = await page.request.post(`/api/jobs/${jobId}/retry`);
    expect(retry.status()).toBe(409);
    expect(await retry.json()).toMatchObject({
      error: { code: "artifacts_purged", message: "作品已过期清理，请用这条提示词重新生成" },
    });

    await reuseBtn.click();
    await expect(promptBox(page)).toHaveValue(/海边的灯塔/);
  } finally {
    // 复用开发服务器时这条记录会落在真实 data/ 里，跑完带走。
    await rm(jobDir, { recursive: true, force: true });
  }
});

/**
 * uncertain_submit 只由崩溃恢复路径写入（src/lib/jobs/recover.ts /
 * src/lib/harness/shot-recover.ts）：进程在 provider.submit 返回、remoteId 落盘之间
 * 崩溃。mock provider 没有对应的提示词触发标记（只有 MOCK_FAIL_MARKER = "[fail]"，
 * 对应的是另一种、上游明确拒绝的失败），真要触发得真的杀掉 dev server 的进程，e2e
 * 里不现实。跟"已清理作品"用例同样的手法：直接在服务器数据目录写一条终态记录，
 * 只验 UI/API 对 retryBlocked 的处理，不去真的制造一次崩溃。
 */
test("retryBlocked：uncertain_submit 阻断一键重试", async ({ page }) => {
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
      status: "failed",
      progress: 0,
      mode: "text_to_video",
      model: "grok-imagine-video-1.0",
      provider: "mock",
      prompt: "中断测试：提交后、远端 id 落盘前崩溃",
      durationSec: 8,
      aspectRatio: "16:9",
      resolution: "720p",
      imageResolution: null,
      generateAudio: true,
      lastFrameStored: false,
      lastFrameLocksOutput: false,
      harness: { enabled: false },
      costUsdEstimate: 0.1,
      costUsdActual: null,
      // retryBlock() 对 job 级 uncertain_submit 只看 code，message 是固定文案，
      // 与这里写的字符串无关（见下面的断言）。
      error: { code: "uncertain_submit", message: "占位，UI 不会显示这句" },
      output: null,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      bible: null,
      shots: null,
      assets: {},
    }),
  );

  try {
    // 后端契约：不管前端怎么展示，一键重试必须被拒——这条与 UI 实现无关，先钉住。
    // 注意 wire 上的 error.code 是 "retry_blocked"（create.ts 里 `throw new
    // ProviderHttpError(409, "retry_blocked", block.message)` 硬编码的字面量），
    // 不是 job.retryBlocked.code 那个 "uncertain_submit"——两个字段服务不同用途：
    // 前者是这次 HTTP 请求被拒的通用原因码，后者是任务记录上供 UI 判断是否常驻显示
    // 阻断横幅的标记。第一次写这条用例时把两者搞混了，读 create.ts 源码才发现。
    const retry = await page.request.post(`/api/jobs/${jobId}/retry`);
    expect(retry.status()).toBe(409);
    const retryJson = (await retry.json()) as { error: { code: string; message: string } };
    expect(retryJson.error.code).toBe("retry_blocked");
    // 文案固定来自 src/lib/jobs/retry-guard.ts 的 JOB_UNCERTAIN_SUBMIT_MESSAGE；
    // retryBlock() 对 job 级 uncertain_submit 恒定返回这句，不看 job.json 里 error.message 写的什么。
    expect(retryJson.error.message).toBe(
      "任务中断在提交后、远端 id 落盘前，上游可能已接单，为避免重复计费不再自动重试",
    );

    // UI 契约（§7）：/create 上这条任务应显示阻断提示，且没有「重新生成」按钮。
    // ASSUMPTION（见交接报告）：`.task[data-job-id]` 对账号下任意一条任务都渲染，
    // 不只是"当前正在追踪"的那一条——如果 coder 把"当前任务"和"最近任务"做成两种
    // 不共享类名的标记，这条会找不到元素而超时，需要跟着调整选择器。
    await page.goto("/create");
    await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    const task = taskById(page, jobId);
    await expect(task).toHaveAttribute("data-state", "failed");
    await expect(task.locator(".task__blocked")).toHaveAttribute("role", "alert");
    await expect(task.locator(".task__blocked")).toContainText("上游可能已接单");
    await expect(task.getByRole("button", { name: "重新生成" })).toHaveCount(0);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("五视图导航：标题与 aria-current 联动，画布不横向溢出", async ({ page }) => {
  const views: { name: string; path: RegExp }[] = [
    { name: "主页", path: /\/$/ },
    { name: "创作", path: /\/create$/ },
    { name: "智能体", path: /\/agent$/ },
    { name: "画布", path: /\/canvas$/ },
    { name: "订阅", path: /\/subscription$/ },
  ];

  for (const view of views) {
    await page.locator("nav").getByRole("link", { name: view.name }).click();
    await expect(page).toHaveURL(view.path);
    await expect(page.locator(".top__title")).toHaveText(view.name);
    await expect(page.locator("nav").getByRole("link", { name: view.name })).toHaveAttribute("aria-current", "page");
    // 同一时刻只有一个当前项
    await expect(page.locator('nav [aria-current="page"]')).toHaveCount(1);

    if (view.name === "画布") {
      // 方案 §2："画布视图把 .col 标 data-view="canvas"，main 改 overflow:hidden"。
      await expect(page.locator(".col")).toHaveAttribute("data-view", "canvas");
      const overflowing = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflowing, "画布视图不应横向溢出").toBe(false);
    }
  }
});

test("手机端 375 宽：五个视图都不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const p of ["/", "/create", "/agent", "/canvas", "/subscription"]) {
    await page.goto(p);
    await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    const overflowing = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflowing, `${p} 在 375 宽不应横向溢出`).toBe(false);
  }
});
