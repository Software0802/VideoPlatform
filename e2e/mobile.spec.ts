import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { expect, request as apiRequest, test, type Locator, type Page } from "@playwright/test";
import { newInviteCode, serverDataDir, writeInvite } from "./invites";
import { STORAGE_STATE } from "./paths";

/**
 * H4 移动端回归（方案 `docs/plan-h-account-notifications-2026-09-12.md` §5）。
 *
 * 三档视口各跑一遍主要路径：注册 → 主页 → 创作面板（规格弹层）→ 文生图 →
 * /create 成片 → /agent 发一轮并批准 → /canvas 右键建文生图节点 + 「运行整图」
 * 报价弹层 → /subscription 购买确认 → /account 三张卡 → 头像菜单退出。
 *
 * 贯穿断言（方案原文）：
 *   1. `document.documentElement.scrollWidth <= clientWidth`——走过的每个页面
 *      都验一次（`.shell` 是 `overflow:hidden`，文档级溢出会表现为裁掉而不是
 *      滚动条，所以另对每个关键控件做 boundingBox 完全在视口内的检查）。
 *   2. 每个弹层 / 对话框有可见关闭控件且 Esc 可关。菜单型浮层（画布右键菜单、
 *      头像菜单这类 disclosure / context menu）没有「关闭控件」这个概念，按
 *      Esc 与点外层收层来验。
 *   3. 主要控件的 boundingBox 完全落在视口内（弹层另要求其完整落在宿主视图内，
 *      因为宿主是 `overflow:hidden` 的裁切边界）。
 *
 * 每个视口自己注册一个全新账号（与 auth.spec.ts 同一条 UI 注册路径），文件级
 * 清掉 setup 留下的会话 Cookie。软键盘遮挡 Playwright 模拟不了，不在本用例
 * 范围——方案 §5 已把它标成「未验证」，真机验收另行进行。
 */

test.use({ storageState: { cookies: [], origins: [] } });

type Health = { ok: boolean; mockMode: boolean };
const REQUIRE_MOCK = Boolean(process.env.CI || process.env.E2E_REQUIRE_MOCK);

const VIEWPORTS = [
  { width: 375, height: 667, tag: "375x667" },
  { width: 390, height: 844, tag: "390x844" },
  { width: 768, height: 1024, tag: "768x1024" },
] as const;

/** 等壳（或登录页 `.auth.shell`）客户端水合完成——与全套 e2e 同一个约定。 */
async function shellReady(page: Page): Promise<void> {
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
}

/** 方案 §5 硬性断言：document 无横向溢出。 */
async function expectNoHScroll(page: Page, where: string): Promise<void> {
  const size = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  expect(
    size.scroll,
    `${where}：documentElement 横向溢出 scrollWidth=${size.scroll} > clientWidth=${size.client}`,
  ).toBeLessThanOrEqual(size.client);
  expect(size.body, `${where}：body 横向溢出 ${size.body} > ${size.client}`).toBeLessThanOrEqual(
    size.client,
  );
}

/**
 * 元素的 boundingBox 必须完全落在视口内；给了 `within` 时再要求其完整落在宿主
 * 框内（宿主是 `overflow:hidden` 的裁切边界，比如 `.canvas-view`）。
 * `scrollIntoViewIfNeeded` 会先把它滚进视口——在流内、低于一屏的元素（订阅卡 /
 * 账户卡）靠它滚上来；已经是 fixed/absolute 的浮层原地不动。
 */
async function expectInsideViewport(
  loc: Locator,
  page: Page,
  what: string,
  within?: Locator,
): Promise<void> {
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  expect(box, `${what} 应有布局框`).toBeTruthy();
  const b = box!;
  const vw = page.viewportSize()!.width;
  const vh = page.viewportSize()!.height;
  const eps = 0.6;
  expect(b.x, `${what} 左缘 ${b.x.toFixed(1)} 越出视口左缘`).toBeGreaterThanOrEqual(-eps);
  expect(b.y, `${what} 上缘 ${b.y.toFixed(1)} 越出视口上缘`).toBeGreaterThanOrEqual(-eps);
  expect(
    b.x + b.width,
    `${what} 右缘 ${(b.x + b.width).toFixed(1)} 超过视口宽 ${vw}`,
  ).toBeLessThanOrEqual(vw + eps);
  expect(
    b.y + b.height,
    `${what} 下缘 ${(b.y + b.height).toFixed(1)} 超过视口高 ${vh}`,
  ).toBeLessThanOrEqual(vh + eps);
  if (!within) return;
  const host = await within.boundingBox();
  expect(host, `${what} 的宿主应有布局框`).toBeTruthy();
  const h = host!;
  expect(b.x, `${what} 左缘 ${b.x.toFixed(1)} 越出宿主左缘 ${h.x.toFixed(1)}`).toBeGreaterThanOrEqual(
    h.x - eps,
  );
  expect(b.y, `${what} 上缘越出宿主上缘`).toBeGreaterThanOrEqual(h.y - eps);
  expect(
    b.x + b.width,
    `${what} 右缘 ${(b.x + b.width).toFixed(1)} 越出宿主右缘 ${(h.x + h.width).toFixed(1)}`,
  ).toBeLessThanOrEqual(h.x + h.width + eps);
  expect(
    b.y + b.height,
    `${what} 下缘 ${(b.y + b.height).toFixed(1)} 越出宿主下缘 ${(h.y + h.height).toFixed(1)}`,
  ).toBeLessThanOrEqual(h.y + h.height + eps);
}

/** Esc 收层：按一下，断言浮层消失。 */
async function expectEscapeCloses(page: Page, layer: Locator, what: string): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(layer, `${what} 应被 Esc 关掉`).toBeHidden();
}

/** H4 缺陷点的过程截图，与修复前的探针截图同名配对（报告里做前后对照）。 */
async function shot(page: Page, tag: string, step: string): Promise<void> {
  await page.screenshot({ path: `test-results/h4-${tag}-${step}.png` });
}

for (const vp of VIEWPORTS) {
  test.describe(`移动端 ${vp.tag}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("主要路径：注册→创作→成片→智能体→画布→订阅→账户→退出", async ({ page, baseURL }) => {
      test.setTimeout(300_000);

      /*
        mock 门禁要走 setup 留下的会话：`/api/health` 对匿名只回 `{ ok }`，
        `mockMode` 等实例清单在登录后才给（安全收口——实例配置不裸奔）。
      */
      const healthCtx = await apiRequest.newContext({
        baseURL: baseURL ?? "http://localhost:3000",
        storageState: STORAGE_STATE,
      });
      const res = await healthCtx.get("/api/health");
      expect(res.ok(), "健康检查应通过").toBeTruthy();
      const health = (await res.json()) as Health;
      await healthCtx.dispose();
      if (REQUIRE_MOCK) expect(health.mockMode, "门禁要求 mock 服务器").toBeTruthy();
      test.skip(!health.mockMode, "移动端回归只在 mock 模式跑，避免消耗上游额度");

      const dataDir = await serverDataDir();
      const code = newInviteCode();
      const inviteFile = await writeInvite(dataDir, code);
      const email = `e2e-mob-${randomBytes(6).toString("hex")}@lumen.test`;
      const password = randomBytes(18).toString("base64url");

      try {
        /* ── 1. 登录页 → 注册新账号 → 落到首页 ── */
        await page.goto("/");
        await page.waitForURL("**/login");
        await shellReady(page);
        await expectNoHScroll(page, "登录页");
        await shot(page, vp.tag, "01-login");

        await page.getByRole("tab", { name: "注册" }).click();
        await expectInsideViewport(
          page.getByRole("textbox", { name: "邀请码" }),
          page,
          "邀请码输入框",
        );
        await page.getByRole("textbox", { name: "邮箱" }).fill(email);
        await page.getByLabel("密码").fill(password);
        await page.getByRole("textbox", { name: "邀请码" }).fill(code);
        await page.getByRole("button", { name: "注册", exact: true }).click();
        await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
        await shellReady(page);
        await expectNoHScroll(page, "主页");

        // 顶栏主要控件全部落在视口内（375 + 三字标题页在步骤 6 再验一次）
        await expectInsideViewport(page.locator(".top__sub"), page, "订阅入口");
        await expectInsideViewport(page.locator(".top__bell .top__icon"), page, "通知铃铛");
        await expectInsideViewport(page.locator("button.top__avatar"), page, "头像菜单钮");
        await shot(page, vp.tag, "02-home");

        /* ── 2. 打开创作面板 → 图片页（文生图）── */
        await page.getByRole("button", { name: "描述你想创作的内容" }).click();
        const composer = page.locator(".composer");
        await expect(composer).toHaveAttribute("data-open", "true");
        await composer.getByRole("tab", { name: "图片" }).click();
        await expectInsideViewport(composer.locator(".composer__send"), page, "创作按钮");
        await expectNoHScroll(page, "创作面板");

        /* ── 3. 规格弹层：完整落在视口内、有可见关闭控件、Esc 可关 ── */
        await composer.locator(".composer__specs").click();
        const specsPop = page.locator(".specs-pop");
        await expect(specsPop).toBeVisible();
        await expectInsideViewport(specsPop, page, "规格弹层");
        await expect(specsPop.locator(".specs-pop__close"), "规格弹层应有可见关闭控件").toBeVisible();
        await shot(page, vp.tag, "04-specs-pop");
        await expectEscapeCloses(page, specsPop, "规格弹层");

        /* ── 4. 提交一条文生图 → /create 看到成片 ── */
        await page.getByRole("textbox", { name: "提示词" }).fill("一座漂浮在云海上的玻璃灯塔，黄昏");
        const created = page.waitForResponse(
          (r) => r.url().includes("/api/jobs") && r.request().method() === "POST",
        );
        await composer.locator(".composer__send").click();
        await created;
        await page.waitForURL("**/create");
        await shellReady(page);
        const task = page.locator(".task[data-job-id]");
        await expect(task).toHaveAttribute("data-status", "succeeded", { timeout: 90_000 });
        await expect(task.locator(".task__media img")).toBeVisible();
        await expectInsideViewport(task.locator(".task__media"), page, "成片预览");
        await expectNoHScroll(page, "创作页");
        await shot(page, vp.tag, "05-create");

        /* ── 5. 回主页点开这条作品 → 详情层 Esc 可关 ── */
        await page.goto("/");
        await shellReady(page);
        // 瀑布流默认在「视频」tab，图片任务要切到「图片」才看得到。
        await page.locator(".home__tabs").getByRole("tab", { name: "图片" }).click();
        const item = page.locator(".masonry__item").first();
        await expect(item).toBeVisible({ timeout: 30_000 });
        await item.click();
        const workDialog = page.locator(".work[role='dialog']");
        await expect(workDialog).toBeVisible({ timeout: 30_000 });
        await expectInsideViewport(workDialog, page, "作品详情层");
        await expectEscapeCloses(page, workDialog, "作品详情层");

        /* ── 6. /agent：发一轮 → 提案 → 批准 → 任务卡 ── */
        await page.goto("/agent");
        await shellReady(page);
        await expect(page.locator(".agent-view")).toBeVisible();
        await expectInsideViewport(page.locator(".agent-ask"), page, "智能体输入卡");
        await expectInsideViewport(page.locator(".agent-send"), page, "发送按钮");
        await expectNoHScroll(page, "智能体首页");
        await shot(page, vp.tag, "06-agent-home");

        await page.locator(".agent-ask__input").fill("生成一张海边黄昏的海报");
        await page.locator(".agent-send").click();
        const chat = page.locator(".agent-chat");
        await expect(chat).toBeVisible({ timeout: 30_000 });
        const answer = page.locator(".agent-chat__answer").last();
        await expect(answer).toBeVisible({ timeout: 60_000 });
        await expect(answer.locator(".agent-chat__proposal")).toBeVisible();

        // 会话列的主要控件必须整列落在视口内（H4 之前右缘整体被裁）。
        // 「返回智能体」与「删除会话」共用 .agent-chat__back，按可访问名取。
        await expectInsideViewport(
          chat.getByRole("button", { name: "返回智能体" }),
          page,
          "返回按钮",
        );
        await expectInsideViewport(
          answer.locator(".agent-chat__proposal-actions"),
          page,
          "提案按钮组",
        );
        await expectInsideViewport(chat.locator(".agent-chat__input"), page, "会话输入框");
        await expectInsideViewport(chat.locator(".agent-chat__send"), page, "会话发送钮");
        // 顶栏在这条三字符标题下也不许溢出
        await expectInsideViewport(page.locator("button.top__avatar"), page, "头像菜单钮");
        await shot(page, vp.tag, "07-agent-chat");

        await answer.getByRole("button", { name: "批准生成" }).click();
        await expect(chat.locator(".agent-chat__job").first()).toBeVisible({ timeout: 60_000 });

        // 素材栏在窄屏是横滑的第二页：滚进去以后必须完整落在视口内
        const assetsCol = chat.locator(".agent-chat__right");
        await expectInsideViewport(assetsCol, page, "素材栏");
        await expect(assetsCol.locator(".agent-asset").first()).toBeVisible({ timeout: 30_000 });
        await expectNoHScroll(page, "智能体会话");

        /* ── 7. /canvas：右键建文生图节点 → 运行整图 → 报价弹层 ── */
        await page.goto("/canvas");
        await shellReady(page);
        const canvasView = page.locator(".canvas-view");
        await expect(canvasView).toBeVisible();
        await expect(page.locator(".canvas-scroll")).toBeVisible({ timeout: 60_000 });
        await expectNoHScroll(page, "画布页");
        await shot(page, vp.tag, "08-canvas");

        // 真实右键（contextmenu 路径），点在视图偏左，菜单往右下展开不至于出界
        await canvasView.click({ button: "right", position: { x: 120, y: 200 } });
        const menu = page.locator(".canvas-menu");
        await expect(menu).toBeVisible();
        await expectInsideViewport(menu, page, "右键菜单", canvasView);
        await shot(page, vp.tag, "09-canvas-menu");
        await menu.getByRole("button", { name: "文生图" }).click();
        await expect(menu).toBeHidden();

        const node = page.locator('.canvas-node[data-kind="gen_image"]');
        await expect(node).toBeVisible();
        await node.locator(".canvas-node__textarea").fill("暮色里的玻璃灯塔");
        await shot(page, vp.tag, "10-canvas-node");

        const runAllBtn = page.locator(".canvas-topright__btn");
        await expectInsideViewport(runAllBtn, page, "运行整图", canvasView);
        await runAllBtn.click();
        const quote = page.locator(".canvas-quote");
        await expect(quote).toBeVisible({ timeout: 30_000 });
        // 弹层必须完整落在画布视图内（overflow:hidden 的裁切边界）——修复前 375 下左缘被裁
        await expectInsideViewport(quote, page, "报价弹层", canvasView);
        await expect(quote.locator(".canvas-quote__close"), "报价弹层应有可见关闭控件").toBeVisible();
        await shot(page, vp.tag, "11-canvas-quote");
        await expectEscapeCloses(page, quote, "报价弹层");
        // 再开一次，走可见 ✕ 关闭
        await runAllBtn.click();
        await expect(quote).toBeVisible({ timeout: 30_000 });
        await quote.locator(".canvas-quote__close").click();
        await expect(quote).toBeHidden();
        await expectNoHScroll(page, "画布报价层");

        /* ── 8. /subscription：购买确认能开、有取消控件、Esc 可关 ── */
        await page.goto("/subscription");
        await shellReady(page);
        const planCta = page.locator(".sub-card__cta:not([disabled])").first();
        await expect(planCta).toBeVisible({ timeout: 60_000 });
        await expectNoHScroll(page, "订阅页");
        await shot(page, vp.tag, "12-subscription");
        await planCta.click();
        const confirm = page.locator(".redeem.sub-confirm");
        await expect(confirm).toBeVisible();
        await expectInsideViewport(confirm.locator(".redeem__panel"), page, "购买确认面板");
        await expect(
          confirm.getByRole("button", { name: "取消" }),
          "购买确认应有可见取消控件",
        ).toBeVisible();
        await shot(page, vp.tag, "13-sub-confirm");
        await expectEscapeCloses(page, confirm, "购买确认");
        // 再开一次，走「取消」按钮
        await planCta.click();
        await expect(confirm).toBeVisible();
        await confirm.getByRole("button", { name: "取消" }).click();
        await expect(confirm).toBeHidden();

        /* ── 9. /account：三张卡都在视口内；密码弹窗与退出确认 Esc 可关 ── */
        await page.goto("/account");
        await shellReady(page);
        await expectNoHScroll(page, "账户页");
        for (const card of ["profile", "balance", "security"] as const) {
          await expectInsideViewport(
            page.locator(`.account-card[data-card="${card}"]`),
            page,
            `账户卡 ${card}`,
          );
        }
        await shot(page, vp.tag, "14-account");

        const security = page.locator('.account-card[data-card="security"]');
        await security.getByRole("button", { name: "修改密码" }).click();
        const pwdDialog = page.getByRole("dialog", { name: "修改密码" });
        await expect(pwdDialog).toBeVisible();
        await expect(pwdDialog.getByRole("button", { name: "取消" })).toBeVisible();
        await expectEscapeCloses(page, pwdDialog, "修改密码弹窗");

        await security.getByRole("button", { name: "退出全部设备" }).click();
        const confirmBox = page.locator(".account-confirm");
        await expect(confirmBox).toBeVisible();
        await expect(confirmBox.getByRole("button", { name: "取消" })).toBeVisible();
        await expectEscapeCloses(page, confirmBox, "退出全部设备确认");

        /* ── 10. 头像菜单 → 退出 → 回登录页 ── */
        const avatarBtn = page.locator("button.top__avatar");
        await avatarBtn.click();
        const topMenu = page.locator(".top__menu");
        await expect(topMenu).toBeVisible();
        await expectInsideViewport(topMenu, page, "头像菜单");
        await shot(page, vp.tag, "15-avatar-menu");
        await expectEscapeCloses(page, topMenu, "头像菜单");
        await avatarBtn.click();
        await topMenu.getByRole("button", { name: "退出" }).click();
        await page.waitForURL("**/login");
        await expect(page.getByRole("tab", { name: "登录" })).toBeVisible();
        await expectNoHScroll(page, "退出后登录页");
        await shot(page, vp.tag, "16-after-logout");
      } finally {
        await rm(inviteFile, { force: true });
      }
    });
  });
}
