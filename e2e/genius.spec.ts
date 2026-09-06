import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { newInviteCode, serverDataDir, writeInvite } from "./invites";

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

/**
 * 阶段 A：面板的可选项来自 `GET /api/models`（产品目录），不再是一组写死的枚举。
 * 用例读同一个接口来决定「该点哪个产品、该出现哪些芯片」——把断言钉在服务端事实上，
 * 而不是把 `docs/plan-ui-genius-app.md` 里的默认目录抄进测试。
 *
 * 返回体是**白名单**（`src/app/api/models/route.ts`）：`provider` 与上游 `model` 根本不
 * 出网，界面上只允许出现 `name`——「不露供应商」是用户 2026-09-06 的决定，下面有专门的
 * 用例守着接口与下拉两侧。
 */
type ApiProduct = {
  id: string;
  name: string;
  kind: "video" | "image";
  modes: string[];
  resolutions: string[];
  aspectRatios: string[];
  durations?: number[];
  audio: "off" | "native" | "uncontrolled";
  supportsLastFrame: boolean;
  maxReferenceImages: number;
  imageResolutions?: string[];
  samplePriceCny: number;
};

async function apiProducts(page: Page): Promise<ApiProduct[]> {
  const res = await page.request.get("/api/models");
  expect(res.ok(), "GET /api/models 应可读").toBeTruthy();
  const list = ((await res.json()) as { products: ApiProduct[] }).products;
  expect(list.length, "mock 实例应至少有一个可用产品").toBeGreaterThan(0);
  return list;
}

/**
 * 时长连续的那一档（`durations` 省略 = 1–15 秒都收）。30 / 45 / 60 秒长片只有它接得下，
 * 画幅 / 分辨率也最全，所以「随便选个参数提交」的用例都先切到它。
 */
function flexibleVideo(list: ApiProduct[]): ApiProduct {
  const hit = list.find((p) => p.kind === "video" && !p.durations);
  expect(hit, "应有一个时长连续的视频产品（长片与自由档位用例依赖它）").toBeTruthy();
  return hit!;
}

/** 打开模型下拉，选中一个产品，等芯片文案换过来。 */
async function pickProduct(page: Page, product: ApiProduct) {
  await page.locator(".composer__model").click();
  const item = page.locator(`.model-pop button[data-product-id="${product.id}"]`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator(".model-pop")).toBeHidden();
  await expect(page.locator(".composer__model")).toContainText(product.name);
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
  const flexible = flexibleVideo(await apiProducts(page));
  await ensureComposerOpen(page);
  await expect(composer(page).getByRole("tab", { name: "视频" })).toHaveAttribute("aria-selected", "true");
  await expect(composer(page).getByRole("radio", { name: "图文" })).toHaveAttribute("aria-checked", "true");

  // 阶段 A：芯片按**选中产品**的能力收窄。默认产品的时长是按档计费的枚举（没有 8s、
  // 也没有音轨开关），所以先切到时长连续、自带音轨的那一档再选参数。
  await pickProduct(page, flexible);
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
    // 阶段 A：请求体的 `model` 是**产品 id**（不是上游模型名），由模型下拉选出。
    model: flexible.id,
  });

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
  await expect.poll(() => creditsNow(page), { timeout: 10_000 }).toBe(creditsBeforeFail);

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
  await expect.poll(() => creditsNow(page), { timeout: 10_000 }).toBe(creditsBeforeFail);

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
  // 没手动切模型时也要带上默认选中的产品 id（阶段 A：面板恒定报出它选的那一档）
  expect(typeof body.model).toBe("string");

  const jobId = ((await res.json()) as { id: string }).id;
  const task = taskById(page, jobId);
  await waitTerminal(task);
  await expect(task).toHaveAttribute("data-state", "done");
  await expect(task.locator("video")).toBeVisible();
});

/**
 * 首尾帧（阶段 A）：两槽都放图 → `image_to_video` + `lastUploadId`，分辨率被抬到 1080p。
 *
 * mock 实例上这条路径同样要通：mock 是所有 provider 的替身（`capabilities()` 声明
 * `supportsLastFrameLock`），否则开发机与 CI 上首尾帧会是唯一一条走不通的路径。它的
 * submit 拿到尾帧只是忽略——出的本来就是占位片。
 *
 * 1080p 不是面板自己挑的：带尾帧的图生视频上游只在 1080p 接受，服务端按抬完的档计价
 * （AGENTS.md 后端约定），所以规格弹层只留这一档，请求体与落盘记录也必须是它。
 */
test("首尾帧：两槽上传 → image_to_video + lastUploadId，分辨率锁 1080p", async ({ page }) => {
  const products = await apiProducts(page);
  test.skip(
    !products.some((p) => p.kind === "video" && p.supportsLastFrame),
    "这台实例没有支持首尾帧的视频产品",
  );

  await ensureComposerOpen(page);
  // 当前产品不支持首尾帧时面板会自动换到支持的那一档（ShellContext.pickMode）
  await composer(page).getByRole("radio", { name: "首尾帧" }).click();
  await expect(composer(page).getByRole("radio", { name: "首尾帧" })).toHaveAttribute("aria-checked", "true");

  const uploads = page.waitForResponse((r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST");
  await page.getByLabel("上传图片").setInputFiles(START_FRAME);
  expect((await uploads).ok()).toBeTruthy();
  const lastUpload = page.waitForResponse((r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST");
  await page.getByLabel("上传尾帧图片").setInputFiles(START_FRAME);
  expect((await lastUpload).ok()).toBeTruthy();

  await expect(page.locator('.composer__slot[data-slot="start"]')).toHaveAttribute("data-state", "ready");
  await expect(page.locator('.composer__slot[data-slot="last"]')).toHaveAttribute("data-state", "ready");
  await expect(composer(page)).toHaveAttribute("data-mode", "image_to_video");
  // 首尾帧只剩 1080p 一档（720p 会被上游抬上去、还按 1080p 收钱，留着就是骗人）
  await expect(page.locator(".composer__specs")).toContainText("1080P");

  await promptBox(page).fill("从第一帧过渡到最后一帧，镜头缓慢右移");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST");
  await sendButton(page).click();
  const res = await created;
  const body = res.request().postDataJSON() as Record<string, unknown>;
  expect(body.mode).toBe("image_to_video");
  expect(body.startUploadId).toMatch(/^up_[0-9a-f]{16}$/);
  expect(body.lastUploadId).toMatch(/^up_[0-9a-f]{16}$/);
  expect(body.lastUploadId).not.toBe(body.startUploadId);
  expect(body.resolution).toBe("1080p");

  const jobId = ((await res.json()) as { id: string }).id;
  const record = (await (await page.request.get(`/api/jobs/${jobId}`)).json()) as {
    resolution: string;
    lastFrameStored: boolean;
  };
  expect(record.resolution).toBe("1080p");
  expect(record.lastFrameStored).toBe(true);

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
  expect(typeof body.model).toBe("string");

  const jobId = ((await res.json()) as { id: string }).id;
  const task = taskById(page, jobId);
  await waitTerminal(task);
  await expect(task).toHaveAttribute("data-state", "done");
  await expect(task.locator("img")).toBeVisible();
});

test("长片：30s 走一致性管线，分镜读数推进到成片", async ({ page }) => {
  const h = await health(page);
  test.skip(!h.harnessRunnable, "HARNESS_ENABLED 未开启");

  const flexible = flexibleVideo(await apiProducts(page));
  await ensureComposerOpen(page);
  // 30 / 45 / 60 只挂在时长连续的那条通道上：按档计费的产品选了会被服务端 400
  // （product-choice.ts「所选模型不支持 30 / 45 / 60 秒长片」），面板也就不给这几个芯片。
  await pickProduct(page, flexible);
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

test("模型下拉：列出产品、只露产品名、切换后规格芯片跟着收窄", async ({ page }) => {
  const list = await apiProducts(page);
  const videos = list.filter((p) => p.kind === "video");
  test.skip(videos.length < 2, "这台实例只有一个视频产品，无从切换");

  await ensureComposerOpen(page);
  await page.locator(".composer__model").click();
  const pop = page.locator(".model-pop");
  await expect(pop).toBeVisible();
  // 视频页只列视频产品（图片产品在图片页）
  await expect(pop.locator("button[data-product-id]")).toHaveCount(videos.length);
  for (const p of videos) await expect(pop.locator(`button[data-product-id="${p.id}"]`)).toContainText(p.name);

  // 用户 2026-09-06 的决定：只显示产品名，不露供应商。第一道防线在接口——白名单挑
  // 字段，`provider` 与上游 `model` 压根不下发，浏览器里没有可泄露的东西。
  for (const p of list) {
    expect(p, "GET /api/models 不该下发 provider").not.toHaveProperty("provider");
    expect(p, "GET /api/models 不该下发上游 model").not.toHaveProperty("model");
  }
  // 第二道：下拉里也不该出现上游模型名。
  const popText = (await pop.textContent()) ?? "";
  for (const leak of ["kling-", "minimax", "gpt-image", "grok-imagine"]) {
    expect(popText.toLowerCase(), `模型下拉泄露了上游模型名 ${leak}`).not.toContain(leak);
  }
  await page.locator(".composer__model").click();
  await expect(pop).toBeHidden();

  // 切换产品 → 分辨率 / 时长芯片按新产品的能力重列（阶段 A §1）
  const withRes = videos.filter((p) => p.resolutions.length > 0);
  const a = withRes[0];
  const b = withRes.find((p) => p.resolutions.join() !== a.resolutions.join());
  test.skip(!b, "所有视频产品的分辨率档位相同，切换看不出差别");

  for (const product of [a, b!]) {
    await pickProduct(page, product);
    await withSpecsPop(page, async (specs) => {
      await expect(specs.locator("button[data-res]")).toHaveCount(product.resolutions.length);
      for (const r of product.resolutions) await expect(specs.locator(`button[data-res="${r}"]`)).toBeVisible();
      await expect(specs.locator("button[data-ratio]")).toHaveCount(product.aspectRatios.length);
      // 按档计费的产品：时长芯片就是它声明的那几档，没有别的（长片档也不会混进来）
      if (product.durations) {
        await expect(specs.locator("button[data-dur]")).toHaveCount(product.durations.length);
        for (const d of product.durations) await expect(specs.locator(`button[data-dur="${d}"]`)).toBeVisible();
      }
    });
    // 选中的档位必须落在新产品的能力里，否则提交必被 400
    const specsText = (await page.locator(".composer__specs").textContent()) ?? "";
    const [resLabel] = specsText.split("|").map((s) => s.trim());
    expect(product.resolutions.map((r) => r.toUpperCase())).toContain(resLabel);
  }
});

test("礼品码：兑换到账、重复兑换被拒、账单记录能看到这一笔", async ({ page }) => {
  // 铸码没有 HTTP 入口（和邀请码一样是管理员动作），照 auth.setup.ts 的做法直接调 CLI，
  // 顺带在每次 e2e 里验证这个脚本还能跑。stdout 每行一个码，统计信息走 stderr。
  const dataDir = await serverDataDir();
  const script = path.resolve(__dirname, "../scripts/mint-gift-codes.mjs");
  const { stdout } = await promisify(execFile)(process.execPath, [script, "1", "20", "--note", "playwright e2e"], {
    env: { ...process.env, DATA_DIR: dataDir },
  });
  const code = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  expect(code, "mint-gift-codes.mjs 应在 stdout 打印一个礼品码").toMatch(/^[0-9A-Z]{12}$/);

  await page.locator("nav").getByRole("link", { name: "订阅" }).click();
  await expect(page).toHaveURL(/\/subscription$/);
  const before = await creditsNow(page);

  const openRedeem = async () => {
    await page.getByRole("button", { name: "兑换礼品码" }).click();
    const dialog = page.locator('.redeem[role="dialog"]');
    await expect(dialog).toBeVisible();
    return dialog;
  };

  const dialog = await openRedeem();
  await dialog.getByLabel("礼品码", { exact: true }).fill(code);
  await dialog.getByRole("button", { name: "兑换", exact: true }).click();
  await expect(dialog).toBeHidden();

  // ¥20 × 100 = 2000 积分（AGENTS.md 硬约束的换算口径）。顶栏读数来自重拉的 /api/me。
  await expect(topCredits(page)).toHaveAttribute("aria-label", `积分 ${before + 2000}`, { timeout: 20_000 });

  // 同一张码第二次：服务端 409 gift_code_used，弹窗留在原地并给出理由
  const again = await openRedeem();
  await again.getByLabel("礼品码", { exact: true }).fill(code);
  await again.getByRole("button", { name: "兑换", exact: true }).click();
  await expect(again.locator(".redeem__err")).toContainText("已被使用");
  await again.getByRole("button", { name: "取消" }).click();
  await expect(again).toBeHidden();

  // 账单记录抽屉只看 kind=grant，这一笔应在最前
  await page.getByRole("button", { name: "账单记录" }).click();
  const ledger = page.locator('.ledger[role="dialog"]');
  await expect(ledger).toBeVisible();
  const first = ledger.locator(".ledger__item").first();
  await expect(first).toHaveAttribute("data-kind", "grant");
  await expect(first.locator(".ledger__amount")).toHaveText("+2000");
  await ledger.getByRole("button", { name: "关闭" }).click();
  await expect(ledger).toBeHidden();
});

// ---------------------------------------------------------------------------
// 阶段 B：作品分页 / 标签 / 删除 / 分享 / 模板 / 改密
//
// 造数据的手法与上面两条「直接写 job.json」的用例一致：`data/jobs/index.json` 是**派生
// 索引**，`listJobIndex` 每次读之前都会拿目录名集合对一遍，对不上就重建（见
// `src/lib/jobs/index.ts` 的三条纪律），所以绕过 store 写盘造出来的记录一样能被列表看见。
// 真跑一遍 mock 出片要十几秒 × 45 条，那是把「分页对不对」的用例变成一次压测。
// ---------------------------------------------------------------------------

type SeedOpts = {
  kind?: "video" | "image";
  prompt?: string;
  tags?: string[];
  /** 相对现在往前推多少毫秒，用来排出稳定的先后顺序 */
  ageMs?: number;
};

/** 写一条已完成的作品记录，返回它的 id 与目录（调用方负责在 finally 里删掉）。 */
async function seedJob(userId: string, dataDir: string, opts: SeedOpts = {}) {
  const kind = opts.kind ?? "video";
  const id = `job_${randomBytes(6).toString("hex")}`;
  const dir = path.join(dataDir, "jobs", id);
  const at = new Date(Date.now() - (opts.ageMs ?? 0)).toISOString();
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "job.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      ownerId: userId,
      status: "succeeded",
      progress: 100,
      mode: kind === "image" ? "text_to_image" : "text_to_video",
      model: kind === "image" ? "grok-imagine-image-2.0" : "grok-imagine-video-1.0",
      provider: "mock",
      prompt: opts.prompt ?? "阶段 B 造的样本",
      tags: opts.tags ?? [],
      durationSec: kind === "image" ? 0 : 5,
      aspectRatio: "16:9",
      resolution: kind === "image" ? null : "720p",
      imageResolution: kind === "image" ? "1k" : null,
      generateAudio: false,
      lastFrameStored: false,
      lastFrameLocksOutput: false,
      harness: { enabled: false },
      priceCny: 2,
      costUsdEstimate: 0.02,
      costUsdActual: 0.02,
      error: null,
      output:
        kind === "image"
          ? { kind: "image", imageUrl: `/api/media/${id}/image.jpg` }
          : { kind: "video", videoUrl: `/api/media/${id}/video.mp4`, posterUrl: `/api/media/${id}/poster.jpg`, durationSec: 5 },
      createdAt: at,
      updatedAt: at,
      completedAt: at,
      bible: null,
      shots: null,
      assets: {},
    }),
  );
  return { id, dir };
}

async function reloadHome(page: Page) {
  await page.goto("/");
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
}

async function currentUserId(page: Page): Promise<string> {
  const me = await page.request.get("/api/me");
  expect(me.ok(), "需要已登录会话").toBeTruthy();
  return ((await me.json()) as { userId: string }).userId;
}

const card = (page: Page, jobId: string) => page.locator(`.masonry__item[data-job-id="${jobId}"]`);
const workDialog = (page: Page) => page.locator('.work[role="dialog"]');

test("主页分页：SSR 首屏 40 条，加载更多按 kind 续页", async ({ page }) => {
  const userId = await currentUserId(page);
  const dataDir = await serverDataDir();
  // 45 条，全部比现有任务新（ageMs 从 0 起往前推 1 秒一条），所以首屏那 40 条一定是它们。
  const seeds: { id: string; dir: string }[] = [];
  for (let i = 0; i < 45; i += 1) {
    seeds.push(await seedJob(userId, dataDir, { prompt: `分页样本 ${i}`, ageMs: i * 1000 }));
  }
  const oldest = seeds[seeds.length - 1];

  try {
    await reloadHome(page);
    const items = page.locator('.masonry__item[data-kind="video"]');
    // 首屏正好是 `(shell)/layout.tsx` 的 INITIAL_JOBS，最老的那几条还没下来
    await expect(items).toHaveCount(40);
    await expect(card(page, oldest.id)).toHaveCount(0);

    const more = page.getByRole("button", { name: /加载更多/ });
    await expect(more).toBeVisible();

    /*
      「加载更多」按钮与触底哨兵触发的是**同一个动作**（`loadMoreJobs(kind)`），而点按钮
      本身要先把它滚进视口——那一滚往往顺手把哨兵也带进来了。所以：先挂好响应等待再点，
      点的时候按钮可能已经被自动加载摘掉（这一类没有第三页了），那不是失败。
      真正要证明的是「第二页确实被拉下来了」，下面三条断言说了算。
    */
    const paged = page.waitForResponse(
      (r) => r.url().includes("/api/jobs?") && r.request().method() === "GET" && r.ok(),
    );
    await more.click({ timeout: 10_000 }).catch(() => undefined);
    const res = await paged;
    // 视频页签必须带 kind=video：不带的话第二页会混进图片作品，页签就是假的
    expect(new URL(res.url()).searchParams.get("kind")).toBe("video");
    const body = (await res.json()) as { jobs: unknown[]; nextBefore?: string };
    expect(Array.isArray(body.jobs), "GET /api/jobs 应回 { jobs, nextBefore? }").toBeTruthy();

    // 第二页把最老的那条带了下来，卡片数也涨了
    await expect(card(page, oldest.id)).toHaveCount(1);
    expect(await items.count()).toBeGreaterThan(40);
  } finally {
    for (const s of seeds) await rm(s.dir, { recursive: true, force: true });
  }
});

test("标签：详情浮层改标签写回 PATCH，分类芯片按标签筛选", async ({ page }) => {
  const userId = await currentUserId(page);
  const dataDir = await serverDataDir();
  const tagged = await seedJob(userId, dataDir, { prompt: "要贴标签的那条", ageMs: 0 });
  const plain = await seedJob(userId, dataDir, { prompt: "不贴标签的那条", ageMs: 1000 });

  try {
    await reloadHome(page);
    await card(page, tagged.id).click();
    const dialog = workDialog(page);
    await expect(dialog).toBeVisible();

    // 预置芯片多选：点「广告」→ PATCH /api/jobs/:id { tags:["广告"] }
    const chip = dialog.locator('.work__tag[data-tag="广告"]');
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    const patched = page.waitForResponse(
      (r) => /\/api\/jobs\/[^/?]+$/.test(r.url()) && r.request().method() === "PATCH",
    );
    await chip.click();
    const res = await patched;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ tags: ["广告"] });
    await expect(chip).toHaveAttribute("aria-pressed", "true");

    // 自定义标签：回车即提交，服务端整组覆盖，所以请求体是「广告 + 新的那个」
    const patched2 = page.waitForResponse(
      (r) => /\/api\/jobs\/[^/?]+$/.test(r.url()) && r.request().method() === "PATCH",
    );
    await dialog.getByLabel("自定义标签").fill("夜景");
    await dialog.getByLabel("自定义标签").press("Enter");
    expect((await patched2).request().postDataJSON()).toEqual({ tags: ["广告", "夜景"] });

    await dialog.getByRole("button", { name: "关闭" }).click();
    await expect(dialog).toBeHidden();

    // 分类芯片真筛选：选「广告」只剩贴了标签的那条，「全部」再放开
    await expect(card(page, plain.id)).toHaveCount(1);
    await page.locator('.home__cat[data-cat="广告"]').click();
    await expect(page.locator('.home__cat[data-cat="广告"]')).toHaveAttribute("aria-pressed", "true");
    await expect(card(page, tagged.id)).toHaveCount(1);
    await expect(card(page, plain.id)).toHaveCount(0);
    await page.locator('.home__cat[data-cat="全部"]').click();
    await expect(card(page, plain.id)).toHaveCount(1);

    // 刷新之后标签还在（真的落了盘，不只是本地状态）
    await reloadHome(page);
    await expect(card(page, tagged.id)).toHaveAttribute("data-tags", "广告,夜景");
  } finally {
    await rm(tagged.dir, { recursive: true, force: true });
    await rm(plain.dir, { recursive: true, force: true });
  }
});

test("删除：详情浮层二次确认后 DELETE，卡片从瀑布流消失", async ({ page }) => {
  const userId = await currentUserId(page);
  const dataDir = await serverDataDir();
  const doomed = await seedJob(userId, dataDir, { prompt: "待删除的作品", ageMs: 0 });

  try {
    await reloadHome(page);
    await card(page, doomed.id).click();
    const dialog = workDialog(page);
    await expect(dialog).toBeVisible();

    // 一次点击只是打开确认条，不发请求
    await dialog.locator(".work__delete").click();
    const confirm = dialog.locator(".work__confirm");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "取消" }).click();
    await expect(confirm).toBeHidden();

    await dialog.locator(".work__delete").click();
    const deleted = page.waitForResponse(
      (r) => /\/api\/jobs\/[^/?]+$/.test(r.url()) && r.request().method() === "DELETE",
    );
    await dialog.getByRole("button", { name: "确认删除" }).click();
    expect((await deleted).status()).toBe(204);

    await expect(dialog).toBeHidden();
    await expect(card(page, doomed.id)).toHaveCount(0);
    // 服务端也真的没了：再读这条是 404
    expect((await page.request.get(`/api/jobs/${doomed.id}`)).status()).toBe(404);
  } finally {
    await rm(doomed.dir, { recursive: true, force: true });
  }
});

test("分享：详情浮层出链接，匿名浏览器能打开 /s/<token>", async ({ page, browser }) => {
  // 这条要真成片：分享页背后是 `/api/share/:token/media`，字节不在盘上就只验了半条链路。
  const created = await page.request.post("/api/jobs", {
    data: {
      mode: "text_to_video",
      prompt: "分享用样片：湖面清晨的薄雾",
      durationSec: 5,
      aspectRatio: "16:9",
      resolution: "720p",
      generateAudio: false,
    },
  });
  expect(created.ok(), "创建分享用任务应成功").toBeTruthy();
  const jobId = ((await created.json()) as { id: string }).id;
  await expect
    .poll(async () => ((await (await page.request.get(`/api/jobs/${jobId}`)).json()) as { status: string }).status, {
      timeout: 150_000,
      intervals: [1000],
    })
    .toBe("succeeded");

  // 剪贴板要显式授权，否则 `navigator.clipboard.writeText` 在无头 Chromium 里会被拒
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await reloadHome(page);
  await card(page, jobId).click();
  const dialog = workDialog(page);
  await expect(dialog).toBeVisible();

  const shared = page.waitForResponse(
    (r) => /\/api\/jobs\/[^/]+\/share$/.test(r.url()) && r.request().method() === "POST",
  );
  await dialog.locator(".work__share").click();
  expect((await shared).ok()).toBeTruthy();

  const row = dialog.locator(".work__shared");
  await expect(row).toBeVisible();
  const url = (await row.getAttribute("data-share-url")) ?? "";
  expect(url, "分享行应带出完整链接").toMatch(/\/s\/[A-Za-z0-9._~-]+$/);
  // 提示语（契约：「链接已复制，24 小时有效」）。小时数是从 expiresAt 推的，所以钉成
  // 正则——实例把 SHARE_TTL_HOURS 调短时这条用例不该假失败。一次断言拿下：`.toast`
  // 只挂 2.2 秒，拆成两条会在慢机器上擦边。
  await expect(page.locator(".toast")).toHaveText(/^链接已复制，\d+ 小时有效$/);
  // 剪贴板里就是这条链接（「复制」这个动作本身是契约的一半）
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);

  // 匿名上下文：没有会话 Cookie，令牌本身就是凭据
  const anon = await browser.newContext();
  try {
    const pageRes = await anon.request.get(url);
    expect(pageRes.status(), "分享页应对匿名访问开放").toBe(200);
    expect(await pageRes.text()).toContain("湖面清晨的薄雾");
    const token = url.split("/s/")[1];
    const media = await anon.request.get(`${new URL(url).origin}/api/share/${token}/media`);
    expect(media.ok(), "分享的成片字节也该匿名可读").toBeTruthy();

    // 伪造的令牌 404（不是「页面在、视频不在」的半可见状态）
    const origin = new URL(url).origin;
    expect((await anon.request.get(`${origin}/s/not-a-real-share-token`)).status()).toBe(404);
    expect((await anon.request.get(`${origin}/api/share/not-a-real-share-token/media`)).status()).toBe(404);
  } finally {
    await anon.close();
  }
});

test("模板：卡片回填提示词与规格到创作面板", async ({ page }) => {
  const dataDir = await serverDataDir();
  const id = `e2e-${randomBytes(4).toString("hex")}`;
  const file = path.join(dataDir, "templates", `zzz-${id}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      id,
      name: "e2e 夜色广告",
      category: "广告",
      prompt: "霓虹灯下的城市街道，镜头缓慢横移，广告牌逐一亮起",
      mode: "text_to_video",
      durationSec: 10,
      aspectRatio: "9:16",
    }),
  );

  try {
    await reloadHome(page);
    await page.getByRole("main").getByRole("tab", { name: "模板" }).click();
    const tpl = page.locator(`.tpl-card[data-template-id="${id}"]`);
    await expect(tpl).toBeVisible();
    await expect(tpl).toContainText("e2e 夜色广告");
    await expect(tpl).toContainText("广告");

    await tpl.click();
    // 点一张卡 = 面板展开 + 提示词与规格都填好，用户只要按「创作」
    await expect(composer(page)).toHaveAttribute("data-open", "true");
    await expect(composer(page)).toHaveAttribute("data-tab", "video");
    await expect(promptBox(page)).toHaveValue(/霓虹灯下的城市街道/);
    const specs = page.locator(".composer__specs");
    await expect(specs).toContainText("10s");
    await expect(specs).toContainText("9:16");
  } finally {
    await rm(file, { force: true });
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

/**
 * 改密。**用一次性账号跑**，不动 `auth.setup.ts` 那个共享会话：改密会把
 * `sessionEpoch` 加一，共享账号的所有旧 Cookie 立刻失效，而 `storageState` 文件里存的
 * 正是其中一张——拿共享账号改一次密码，这个文件之后就再也登不进去了（重试与后续用例
 * 一起垮）。`page` 的上下文是每条用例独立的，所以在这里把它换成一次性账号是安全的。
 */
test("改密：旧密码不对被拒、本机不掉线、其它设备的旧密码失效", async ({ page, request }) => {
  const dataDir = await serverDataDir();
  const email = `e2e-pwd-${randomBytes(6).toString("hex")}@lumen.test`;
  const oldPass = randomBytes(18).toString("base64url");
  const newPass = randomBytes(18).toString("base64url");
  const code = newInviteCode();
  const inviteFile = await writeInvite(dataDir, code);
  let registered = false;

  try {
    // 注册这一步就把会话 Cookie 写进当前上下文，于是下面的页面就是这个一次性账号
    const reg = await page.request.post("/api/auth/register", {
      data: { email, password: oldPass, inviteCode: code },
    });
    registered = reg.ok();
    expect(registered, `注册一次性账号失败：${reg.status()} ${await reg.text()}`).toBeTruthy();
    await reloadHome(page);
    await expect(page.locator(".top__who")).toHaveText(email.split("@")[0]);

    // 账户菜单 → 修改密码
    await page.getByRole("button", { name: "账户" }).click();
    await page.getByRole("button", { name: "修改密码" }).click();
    const dialog = page.locator('.pwd[role="dialog"]');
    await expect(dialog).toBeVisible();

    // 本地校验：两次新密码不一致，请求根本不发出
    await dialog.getByLabel("当前密码").fill(oldPass);
    await dialog.getByLabel("新密码", { exact: true }).fill(newPass);
    await dialog.getByLabel("确认新密码").fill(`${newPass}x`);
    await dialog.getByRole("button", { name: "确认修改" }).click();
    await expect(dialog.locator(".pwd__err")).toHaveText("两次输入的新密码不一致");

    // 服务端 401 invalid_credentials → 中文提示，弹窗留在原地
    await dialog.getByLabel("当前密码").fill(`${oldPass}wrong`);
    await dialog.getByLabel("确认新密码").fill(newPass);
    await dialog.getByRole("button", { name: "确认修改" }).click();
    await expect(dialog.locator(".pwd__err")).toHaveText("当前密码不正确");

    // 真改
    await dialog.getByLabel("当前密码").fill(oldPass);
    const changed = page.waitForResponse(
      (r) => r.url().endsWith("/api/auth/password") && r.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "确认修改" }).click();
    expect((await changed).status()).toBe(200);
    await expect(dialog).toBeHidden();
    await expect(page.locator(".toast")).toHaveText("密码已修改，其它设备已下线");

    // 本机不掉线：服务端改完密码顺手重签了 Cookie（`/api/auth/password` 的注释）
    const me = await page.request.get("/api/me");
    expect(me.ok(), "改密后当前设备不该掉线").toBeTruthy();
    expect(((await me.json()) as { email: string }).email).toBe(email);

    // 其它设备：旧密码登不上，新密码可以（`request` 是另一个上下文，不影响页面）
    const withOld = await request.post("/api/auth/login", { data: { email, password: oldPass } });
    expect(withOld.status(), "旧密码应当失效").toBe(401);
    const withNew = await request.post("/api/auth/login", { data: { email, password: newPass } });
    expect(withNew.ok(), "新密码应当可登录").toBeTruthy();
  } finally {
    // 注册成功时这张码已被标记用过；没用上就收回，别在盘上留一张活码
    if (!registered) await rm(inviteFile, { force: true });
  }
});
