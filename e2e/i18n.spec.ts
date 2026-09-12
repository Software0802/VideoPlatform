import { expect, test, type Page } from "@playwright/test";

/**
 * 多语言（方案 `docs/plan-agent-i18n-subscription-2026-09.md` §2）。
 *
 * 只验三件事，其余都是别的用例的地盘：
 *  1. 顶栏的语言切换是真的——点一下整壳文案立刻变，不刷新；
 *  2. 偏好落在 Cookie `lumen_locale` 上——刷新之后**服务端首屏**就是英文，
 *     `<html lang>` 跟着变（水合一致，不会闪回中文）；
 *  3. 切得回来。默认语言仍是简体中文，所以 `genius.spec.ts` 的中文选择器不受影响。
 *
 * 这条用例不提交任何任务，也就不花积分——放心跟在别的用例后面跑。
 * 语言 Cookie 是浏览器上下文级的，Playwright 每个用例一个新上下文（`storageState` 里
 * 只有会话 Cookie），所以它不会漏给别的用例。
 */

type Health = { ok: boolean; mockMode: boolean };

const REQUIRE_MOCK = Boolean(process.env.CI || process.env.E2E_REQUIRE_MOCK);

const langButton = (page: Page) => page.locator(".lang--top .lang__btn");
const langItem = (page: Page, locale: string) => page.locator(`.lang__item[data-locale="${locale}"]`);

test.beforeEach(async ({ page }) => {
  const res = await page.request.get("/api/health");
  expect(res.ok(), "健康检查应通过").toBeTruthy();
  const h = (await res.json()) as Health;
  if (REQUIRE_MOCK) expect(h.mockMode, "门禁要求 mock 模式的服务器，当前不是").toBeTruthy();
  test.skip(!h.mockMode, "冒烟只在 mock 模式跑，避免消耗上游额度");
  await page.goto("/");
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
});

/** 侧栏五项在两种语言下的名字（`shell.nav.*`）。 */
const NAV_ZH = ["主页", "创作", "智能体", "画布", "订阅"];
const NAV_EN = ["Home", "Create", "Agent", "Canvas", "Subscription"];

async function expectNav(page: Page, names: string[]) {
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link")).toHaveCount(5);
  for (const name of names) {
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  }
}

test("语言切换：顶栏切英文 → 侧栏与顶栏即时变 → 刷新仍是英文且 <html lang=en> → 切回中文", async ({ page }) => {
  // 默认简体中文（没有 Cookie 时 `Accept-Language` 兜底；Playwright 默认 en-US，
  // 所以这里顺带证明了 e2e 用的是**显式默认**而不是浏览器语言——否则整套中文选择器都会塌）
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expectNav(page, NAV_ZH);
  await expect(page.locator(".top__title")).toHaveText("主页");

  // 切换是 disclosure（与头像菜单同款），当前项带 aria-current
  await langButton(page).click();
  await expect(langItem(page, "zh-CN")).toHaveAttribute("aria-current", "true");
  await expect(langItem(page, "en")).toHaveCount(1);
  await langItem(page, "en").click();

  // 即时生效：没有刷新，整棵树重渲染
  await expect(page.locator(".lang__pop")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expectNav(page, NAV_EN);
  await expect(page.locator(".top__title")).toHaveText("Home");
  // 创作面板（收起态输入条）也跟着变
  await expect(page.getByRole("button", { name: "Describe what you want to create" })).toBeVisible();

  // Cookie 落盘：这才是刷新之后服务端首屏能直接给英文的原因
  const cookie = (await page.context().cookies()).find((c) => c.name === "lumen_locale");
  expect(cookie?.value, "切换应写入 lumen_locale Cookie").toBe("en");

  // 刷新：`<html lang>` 由服务端渲染决定，水合前后一致
  await page.reload();
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expectNav(page, NAV_EN);

  // 换个视图也仍是英文（`VIEW_TITLE` 存的是键名，侧栏与顶栏同源）
  await page.getByRole("navigation").getByRole("link", { name: "Canvas", exact: true }).click();
  await expect(page.locator(".top__title")).toHaveText("Canvas");

  // 切回简体中文
  await langButton(page).click();
  await langItem(page, "zh-CN").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".top__title")).toHaveText("画布");
  await expectNav(page, NAV_ZH);
});

test("登录页也能切换语言（未登录时）", async ({ page, context }) => {
  await context.clearCookies();
  /*
    清掉会话 Cookie 之后，旧页面上还在飞的后台请求（H1 起的通知同步等）会吃到
    401 → 客户端 `location.assign("/login")`——与这里的 goto 同目的地，可能把它
    顶成 ERR_ABORTED。等「最终落在 /login」即可，不要求 goto 自己跑完。
  */
  await Promise.all([
    page.waitForURL("**/login"),
    page.goto("/login").catch((e: unknown) => {
      if (!String(e).includes("ERR_ABORTED")) throw e;
    }),
  ]);
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("进入 Genius");

  await page.locator(".lang--auth .lang__btn").click();
  await page.locator('.lang__item[data-locale="en"]').click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Enter Genius");
  await expect(page.getByRole("tab", { name: "Sign in" })).toHaveAttribute("aria-selected", "true");
});
