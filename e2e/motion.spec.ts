import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";

/**
 * 背景呼吸灯 + 等模型输出的等待特效（coder 与本文件同轮并行实装）的锁定测试。
 * 目的不是验收视觉效果本身，是锁住任务书冻结的 DOM/CSS 契约，防止后续改样式时
 * 悄悄把特效弄没、或把「减少动效」降级弄坏。
 *
 * 契约来源（任务书，尚未写进 DESIGN.md「可访问性契约」表——那张表目前只到
 * `.canvas-node__exec[data-exec]` 这一版，本文件锁的是下一版新增的钩子）：
 *  - `.shell::before` 的 animation-name 为 `glow-breathe`，`.shell::after` 为 `glow-drift`；
 *    登录页根节点同样是 `.shell`（`LoginScreen.tsx`：`<div className="auth shell">`）。
 *  - `prefers-reduced-motion: reduce` 命中 `src/app/globals.css:237-245` 的全局兜底
 *    （`*, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; ... }`）。
 *  - 创作页忙碌态 `.task[data-state="busy"]` 内有 `.task__wait[aria-hidden="true"][data-pct]`
 *    且内部无文本；成片后 `.task[data-state="done"]` 内不再有 `.task__wait`。
 *
 * 写这份文件时 `src/` 里还没有 `glow-breathe` / `glow-drift` / `.task__wait` 任何一处
 * （已用 grep 确认），coder 正在并行实装——下面的用例预期先是红的，等实装落地后才转绿，
 * 这是任务分工使然，不是测试写错。
 *
 * mock 门禁与 genius.spec.ts 同一套（R12）：非 CI 下服务器不是 mock 模式就跳过，
 * CI / E2E_REQUIRE_MOCK 下把跳过升级成失败，避免「红→跳过」被误读成绿。
 *
 * genius.spec.ts 的 helper 都没有 export（已用 grep 确认），本文件按任务书约定各自
 * 最小复刻一份，不去改那个文件加 export。
 */

type Health = { ok: boolean; mockMode: boolean; harnessRunnable: boolean };

const REQUIRE_MOCK = Boolean(process.env.CI || process.env.E2E_REQUIRE_MOCK);

async function health(page: Page): Promise<Health> {
  const res = await page.request.get("/api/health");
  expect(res.ok(), "健康检查应通过").toBeTruthy();
  return (await res.json()) as Health;
}

test.beforeEach(async ({ page }) => {
  const h = await health(page);
  if (REQUIRE_MOCK) {
    expect(h.mockMode, "门禁要求 mock 模式的服务器，当前不是").toBeTruthy();
  }
  test.skip(!h.mockMode, "冒烟只在 mock 模式跑，避免消耗上游额度");
  await page.goto("/");
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
});

// ---------------------------------------------------------------------------
// 背景呼吸灯
// ---------------------------------------------------------------------------

type GlowInfo = {
  beforeName: string;
  afterName: string;
  beforeDuration: string;
  beforeIterationCount: string;
};

/** `::before`/`::after` 不是真实 DOM 节点，只能用 getComputedStyle(el, pseudo) 读，Playwright 的
 *  `toHaveCSS` 不支持伪元素定位，所以照任务书要求走 page.evaluate。 */
async function shellGlow(page: Page, selector: string): Promise<GlowInfo | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const before = getComputedStyle(el, "::before");
    const after = getComputedStyle(el, "::after");
    return {
      beforeName: before.animationName,
      afterName: after.animationName,
      beforeDuration: before.animationDuration,
      beforeIterationCount: before.animationIterationCount,
    };
  }, selector);
}

/**
 * 把 getComputedStyle 返回的时间值统一解析成秒数。
 *
 * ASSUMPTION（本轮假设，见报告）：任务书给的断言字面量是 `animationDuration === "0.01ms"`，
 * 但用一份不启动项目 dev server、只加载本地静态 HTML 的独立 Chromium 实测过同一条
 * `0.01ms !important` 规则——Chromium 把极小的时间值归一化成科学计数法的秒，实测读到的是
 * `"1e-05s"`，从来不会是字面串 `"0.01ms"`。字面量断言在 coder 严格照 globals.css:237-245
 * 实装之后仍会永远失败，等于把一条正确实现钉成红——所以改成数值解析后判定「远小于任何
 * 正常呼吸周期」，不锁某个 Chromium 版本的具体序列化写法。
 */
function parseCssSeconds(value: string): number {
  const m = /^([-+0-9.eE]+)(ms|s)$/.exec(value.trim());
  expect(m, `无法解析 CSS 时间值："${value}"`).not.toBeNull();
  const [, num, unit] = m!;
  const n = Number(num);
  return unit === "ms" ? n / 1000 : n;
}

test("背景呼吸灯：主页与登录页有动画，减少动效时静止", async ({ page, browser }) => {
  // beforeEach 已经让默认 page（已登录）停在 "/" 且 data-ready="true"。
  const home = await shellGlow(page, ".shell");
  expect(home?.beforeName).toBe("glow-breathe");
  expect(home?.afterName).toBe("glow-drift");
  expect(home?.beforeDuration).not.toBe("0s");

  // 无 Cookie 的新 context 访问 /login：手动带上与 playwright.config.ts 顶层 use 同值的
  // locale / Accept-Language。注意 @playwright/test 的 browser fixture 会把项目 use 里的
  // storageState（chromium 项目的登录 Cookie）合并进 browser.newContext()——不显式清空，
  // 这个 context 就是登录态，/login 会被服务端 307 回主页、根节点变成 .shell 而非 .auth.shell。
  let anon: BrowserContext | undefined;
  try {
    anon = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      locale: "zh-CN",
      extraHTTPHeaders: { "accept-language": "zh-CN" },
    });
    const anonPage = await anon.newPage();
    await anonPage.goto("/login");
    await expect(anonPage.locator(".auth.shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });

    const login = await shellGlow(anonPage, ".auth.shell");
    expect(login?.beforeName).toBe("glow-breathe");
    expect(login?.afterName).toBe("glow-drift");
    expect(login?.beforeDuration).not.toBe("0s");

    // 减少动效：globals.css:237-245 的全局 !important 兜底。
    await anonPage.emulateMedia({ reducedMotion: "reduce" });
    await anonPage.reload();
    await expect(anonPage.locator(".auth.shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    const reduced = await shellGlow(anonPage, ".auth.shell");
    expect(parseCssSeconds(reduced?.beforeDuration ?? "")).toBeLessThan(0.001);
    expect(reduced?.beforeIterationCount).toBe("1");
  } finally {
    await anon?.close();
  }
});

// ---------------------------------------------------------------------------
// 创作页等待层（最小复刻 genius.spec.ts 的 helper：那边没有 export 任何一个）
// ---------------------------------------------------------------------------

const promptBox = (page: Page) => page.getByRole("textbox", { name: "提示词" });
const composer = (page: Page) => page.locator(".composer");
const sendButton = (page: Page) => page.getByRole("button", { name: "创作", exact: true });

function taskById(page: Page, jobId: string): Locator {
  return page.locator(`.task[data-job-id="${jobId}"]`);
}

async function ensureComposerOpen(page: Page) {
  if ((await composer(page).getAttribute("data-open")) === "true") return;
  await page.getByRole("button", { name: "描述你想创作的内容" }).click();
  await expect(composer(page)).toHaveAttribute("data-open", "true");
}

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

type ApiProduct = { id: string; name: string; kind: "video" | "image"; durations?: number[] };

async function apiProducts(page: Page): Promise<ApiProduct[]> {
  const res = await page.request.get("/api/models");
  expect(res.ok(), "GET /api/models 应可读").toBeTruthy();
  const list = ((await res.json()) as { products: ApiProduct[] }).products;
  expect(list.length, "mock 实例应至少有一个可用产品").toBeGreaterThan(0);
  return list;
}

/** 时长连续的那一档——30 秒长片只有它接得下（同 genius.spec.ts）。 */
function flexibleVideo(list: ApiProduct[]): ApiProduct {
  const hit = list.find((p) => p.kind === "video" && !p.durations);
  expect(hit, "应有一个时长连续的视频产品（长片用例依赖它）").toBeTruthy();
  return hit!;
}

async function pickProduct(page: Page, product: ApiProduct) {
  await page.locator(".composer__model").click();
  const item = page.locator(`.model-pop button[data-product-id="${product.id}"]`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator(".model-pop")).toBeHidden();
  await expect(page.locator(".composer__model")).toContainText(product.name);
}

test("创作页：生成中显示等待层，完成后撤掉", async ({ page }) => {
  const h = await health(page);
  test.skip(!h.harnessRunnable, "HARNESS_ENABLED 未开启");

  const flexible = flexibleVideo(await apiProducts(page));
  await ensureComposerOpen(page);
  // 30 秒长片只挂在时长连续的产品上（product-choice.ts），先切过去再开时长弹层。
  await pickProduct(page, flexible);
  await setSpecs(page, { dur: 30 });
  await expect(page.locator(".composer__specs")).toContainText("30s");

  await promptBox(page).fill("清晨的山谷薄雾，镜头缓慢推进，一位登山者沿山脊行走");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST");
  await sendButton(page).click();
  const res = await created;
  const jobId = ((await res.json()) as { id: string }).id;
  // .task[data-job-id] 只在 /create 上渲染：这个 locator 本身就是「等跳转」的等待点。
  const task = taskById(page, jobId);

  // 忙碌态：等待层可见、对 AT 隐身、带 0–100 的整数进度、内部无文本。
  await expect(task).toHaveAttribute("data-state", "busy");
  const wait = task.locator(".task__wait");
  await expect(wait).toBeVisible();
  await expect(wait).toHaveAttribute("aria-hidden", "true");
  await expect(wait).toHaveAttribute("data-pct", /^\d{1,3}$/);
  expect((await wait.textContent())?.trim()).toBe("");

  // mock 30s 长片约 25 秒出片，给到 90s 超时；done 之后等待层必须撤掉，成片可见。
  await expect(task).toHaveAttribute("data-state", "done", { timeout: 90_000 });
  await expect(task.locator(".task__wait")).toHaveCount(0);
  await expect(task.locator(".task__media video")).toBeVisible();
});

/*
 * 第三条「画布：等审批的节点带 approval 等待态」没有写——不满足任务书给的前提。
 *
 * 任务书说"只有当 e2e/canvas.spec.ts 里到 awaiting_approval 的步骤能在 80 行以内复用……
 * 才写"，但实测 `grep -n "awaiting_approval\|canvas-quote\|批准" e2e/canvas.spec.ts` 零命中：
 * 这个文件通篇是画布保存冲突弹层与素材过期两组用例，从未创建过要跑「运行整图」的节点，
 * 也没有报价层或审批相关代码可复用。
 *
 * 全仓库唯一挨到报价层的是 e2e/mobile.spec.ts:265-303，但它只建一个「文生图」节点、点开
 * `.canvas-quote`、再点 ✕ 关闭——从未勾选「执行前需我批准」、从未点「确认运行」，也就从未
 * 让任何节点进入 awaiting_approval。要从零搭这条链路（建一个生成视频节点、喂它需要的输入、
 * 跑报价、勾批准、确认运行、轮询节点到 data-wait="approval"、点批准、再等它消失）在没有
 * dev server 可跑、无法用真实浏览器逐步验证选择器的这一轮里风险远高于 80 行，所以按任务书
 * 的退出条款不写，留给之后能起服务器核对时再补。
 */
