import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { newInviteCode, serverDataDir, writeInvite } from "./invites";

/**
 * 登录 / 注册页与顶栏（方案 docs/plan-ui-genius-app.md §2、§7）。这条用例是唯一不带
 * 会话的：`test.use` 清掉 `auth.setup.ts` 留下的 Cookie，走完「被挡回登录页 → 用一次性
 * 邀请码注册 → 落到首页 → 头像菜单退出 → 又被挡回登录页」。
 *
 * 越权访问他人任务返回 404 已由单测覆盖，这里不重复。
 *
 * 随换壳更新的选择器（旧版全部失效）：
 *   - `.app[data-ready]` → `.shell[data-ready]`（登录页与已登录壳共用同一个"水合完成"
 *     标记——ASSUMPTION，见交接报告：§7 契约表只把 `.shell` 挂在 GeniusShell 名下，
 *     登录页不在 (shell) 路由组里，两者是否共用同一个类名由 coder 定，这里按任务书
 *     字面要求实现）。
 *   - 「退出」从顶栏直接可见的按钮，改成藏进头像菜单（§7：按钮名「账户」→ 菜单内「退出」）；
 *     账号身份（邮箱）现在只在菜单里，顶栏的"账户芯片"按设计交接包只显示头像/积分/
 *     "基础版"，不含用户名（README §2："个人"是芯片的静态填充文案，不是账号名）。
 *   - 余额展示从 CNY 文案 `.composer__quota` 改成 `.top__credits` 的 ⚡ 积分（¥1=100 积分）。
 *   - 「最近成片」`.recent__item` 换成按 kind 分标签页的瀑布流 `.masonry__item`；新账号
 *     "没有任何任务"这条断言额外加了一次 `GET /api/jobs`（阶段 B 起回分页信封
 *     `{ jobs: [] }`），比数格子数更直接地证明账号隔离（不会看见别人的作品）。
 */

test.use({ storageState: { cookies: [], origins: [] } });

const EMAIL = `e2e-ui-${randomBytes(6).toString("hex")}@lumen.test`;
const PASSWORD = randomBytes(18).toString("base64url");
/** 12 位合法格式但服务器上不存在 —— 与「已被使用」返回同一个 invite_invalid */
const UNKNOWN_CODE = newInviteCode();

const emailField = (page: import("@playwright/test").Page) =>
  page.getByRole("textbox", { name: "邮箱" });
const codeField = (page: import("@playwright/test").Page) =>
  page.getByRole("textbox", { name: "邀请码" });
const submit = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("button", { name, exact: true });

test("未登录被送到登录页；注册后进首页、头像菜单显示账号；退出后又被挡回", async ({ page }) => {
  const dataDir = await serverDataDir();
  const code = newInviteCode();
  const inviteFile = await writeInvite(dataDir, code);

  try {
    // 1. 未登录访问 / → 服务端重定向到 /login
    await page.goto("/");
    await page.waitForURL("**/login");
    await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("进入 Genius");

    // 2. 默认登录 tab，没有邀请码栏；切到注册才出现
    await expect(page.getByRole("tab", { name: "登录" })).toHaveAttribute("aria-selected", "true");
    await expect(codeField(page)).toHaveCount(0);
    await page.getByRole("tab", { name: "注册" }).click();
    await expect(codeField(page)).toBeVisible();

    // 3. 本地校验：密码不足 8 位，请求根本不发出
    await emailField(page).fill(EMAIL);
    await page.getByLabel("密码").fill("short");
    await codeField(page).fill(code);
    await submit(page, "注册").click();
    await expect(page.locator(".auth__error")).toHaveText("密码至少 8 位");
    await expect(page).toHaveURL(/\/login$/);

    // 4. 服务端 400 invite_invalid → 中文提示
    await page.getByLabel("密码").fill(PASSWORD);
    await codeField(page).fill(UNKNOWN_CODE);
    await submit(page, "注册").click();
    await expect(page.locator(".auth__error")).toHaveText("邀请码无效或已使用");

    // 5. 真码注册 → 落到首页
    await codeField(page).fill(code);
    await submit(page, "注册").click();
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });

    // 6. 账号身份藏进头像菜单（§7：按钮名「账户」→ 菜单内「退出」），不是顶栏裸露的文本。
    //    ASSUMPTION：菜单和规格弹层一样是点击态开关，再点一次头像会关闭——用来验证它
    //    不会一直悬着挡住后面的操作；如果 coder 用点击外部关闭而不是再点头像，这两行
    //    需要换成点别处。
    // 头像按钮与 H3 新增的菜单项同名「账户」（aria-label vs 文本），按类名取头像避免歧义。
    const avatarBtn = page.locator("button.top__avatar");
    const logoutBtn = page.getByRole("button", { name: "退出" });
    await avatarBtn.click();
    await expect(page.getByText(EMAIL)).toBeVisible();
    await expect(logoutBtn).toBeVisible();
    await avatarBtn.click();
    await expect(logoutBtn).toBeHidden();

    // 7. 新账号没有任何任务：瀑布流是空的，且服务端也确实没有任务记录
    //    （不串到别人的成片——这条比数格子数更直接地证明账号隔离）。
    await expect(page.getByRole("main").locator(".masonry__item")).toHaveCount(0);
    // 阶段 B 起 `GET /api/jobs` 回的是分页信封 `{ jobs, nextBefore? }` 而不是裸数组
    // （主页「加载更多」要靠 `nextBefore` 在不在判断还有没有下一页）。新账号一条都没有，
    // 所以 `jobs` 是空的，也不该带游标。
    const jobsRes = await page.request.get("/api/jobs");
    expect(await jobsRes.json()).toEqual({ jobs: [] });

    // 8. 顶栏积分：`/api/me` 给了 balance 就换算成 ⚡ 积分显示（¥1=100 积分，AGENTS.md
    //    硬约束）。新账号注册即送 ¥5（`SIGNUP_BONUS_CNY`）= 500 积分：默认规格（5 秒 720p
    //    ¥2）买得起，创作按钮可用；超出 ¥5 的规格（10 秒 1080p 有声 ¥7）后端必须 402。
    const me = (await (await page.request.get("/api/me")).json()) as {
      email: string;
      balance?: { availableCny: number };
    };
    expect(me.email).toBe(EMAIL);
    if (me.balance) {
      expect(me.balance.availableCny).toBe(5);
      await expect(page.locator(".top__credits")).toHaveAttribute("aria-label", "积分 500");

      await page.getByRole("button", { name: "描述你想创作的内容" }).click();
      await expect(page.locator(".composer")).toHaveAttribute("data-open", "true");
      await page.getByRole("textbox", { name: "提示词" }).fill("随便试一下");
      await expect(page.getByRole("button", { name: "创作", exact: true })).toBeEnabled();

      // 余额硬约束在后端的独立验证：绕开 UI 直接打 API，超出赠送额度的规格必须是 402。
      const denied = await page.request.post("/api/jobs", {
        data: {
          mode: "text_to_video",
          prompt: "随便试一下",
          durationSec: 10,
          resolution: "1080p",
          generateAudio: true,
        },
      });
      expect(denied.status()).toBe(402);
      expect(await denied.json()).toMatchObject({
        error: { code: "insufficient_balance", message: "余额不足，请充值" },
      });
    } else {
      await expect(page.locator(".top__credits")).toHaveCount(0);
    }

    // 9. 退出（头像菜单内）→ 回登录页，且 / 又被挡回
    await avatarBtn.click();
    await expect(logoutBtn).toBeVisible();
    await logoutBtn.click();
    await page.waitForURL("**/login");
    await expect(page.getByRole("tab", { name: "登录" })).toBeVisible();
    await page.goto("/");
    await page.waitForURL("**/login");
  } finally {
    // 注册成功时码已被消费（文件仍在，标了 usedBy）；失败时别把活码留下
    await rm(inviteFile, { force: true });
  }
});

/**
 * H3 账户页（方案 §4）：头像菜单进 `/account` → 三张卡 → 「查看流水」落到
 * `/subscription#ledger` 自动开流水抽屉 → 回账户页「退出全部设备」→ 回登录页，
 * 且作废旧 Cookie（`sessionEpoch` +1）再访 `/account` 又被送回登录页。
 *
 * 注册走与上面那条相同的真实注册路径；邮箱与邀请码是这条用例自己的，不与它共享。
 */
test("账户页：三张卡 → 查看流水开抽屉 → 退出全部设备后旧 Cookie 失效", async ({ page, baseURL }) => {
  const dataDir = await serverDataDir();
  const code = newInviteCode();
  const inviteFile = await writeInvite(dataDir, code);
  const email = `e2e-acct-${randomBytes(6).toString("hex")}@lumen.test`;
  const password = randomBytes(18).toString("base64url");
  const origin = baseURL ?? "http://localhost:3000";

  try {
    // 1. 注册 → 落到首页
    await page.goto("/");
    await page.waitForURL("**/login");
    await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await page.getByRole("tab", { name: "注册" }).click();
    await emailField(page).fill(email);
    await page.getByLabel("密码").fill(password);
    await codeField(page).fill(code);
    await submit(page, "注册").click();
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });

    // 2. 头像菜单 → 「账户」菜单项（与头像按钮同名「账户」，限定在 .top__menu 里取）
    await page.locator("button.top__avatar").click();
    await page.locator(".top__menu").getByRole("button", { name: "账户" }).click();
    await page.waitForURL((url) => url.pathname === "/account");

    // 3. 三张卡可见；账号卡显示邮箱与注册时间，余额卡显示 ¥5 → 500 可用积分 + 未订阅
    const profile = page.locator('.account-card[data-card="profile"]');
    const balance = page.locator('.account-card[data-card="balance"]');
    const security = page.locator('.account-card[data-card="security"]');
    await expect(profile).toBeVisible();
    await expect(balance).toBeVisible();
    await expect(security).toBeVisible();
    await expect(profile).toContainText(email);
    await expect(profile).toContainText("注册时间");
    await expect(balance).toContainText("500");
    await expect(balance.locator('.account-sub__plan[data-plan="none"]')).toHaveText("未订阅");

    // 4. 安全卡：「修改密码」弹窗能开能关
    await security.getByRole("button", { name: "修改密码" }).click();
    const pwdDialog = page.getByRole("dialog", { name: "修改密码" });
    await expect(pwdDialog).toBeVisible();
    await pwdDialog.getByRole("button", { name: "取消" }).click();
    await expect(pwdDialog).toBeHidden();

    // 5. 「查看流水」→ /subscription#ledger：抽屉自动打开，hash 随即被清掉。
    //    抽屉内容要等 /api/me/ledger 回来（dev 下首编译可能很慢）。
    await balance.getByRole("link", { name: "查看流水" }).click();
    await page.waitForURL((url) => url.pathname === "/subscription");
    const drawer = page.getByRole("dialog", { name: "积分使用详情" });
    await expect(drawer).toBeVisible({ timeout: 60_000 });
    await expect(drawer.locator(".ledger__item").first()).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/subscription$/);

    // 6. 回 /account → 退出全部设备（先抓下旧会话 Cookie，稍后验证它已作废）
    await page.goto("/account");
    await expect(security).toBeVisible();
    const session = (await page.context().cookies(origin)).find((c) => c.name === "lumen_session");
    expect(session, "会话 Cookie 应存在").toBeTruthy();

    await security.getByRole("button", { name: "退出全部设备" }).click();
    const confirmBox = page.locator(".account-confirm");
    await expect(confirmBox).toBeVisible();
    await confirmBox.getByRole("button", { name: "确认退出" }).click();
    await page.waitForURL("**/login");
    await expect(page.getByRole("tab", { name: "登录" })).toBeVisible();

    // 7. 旧 Cookie 再访 /account：sessionEpoch 已 +1，服务端把它送回登录页
    await page.context().addCookies([{ name: "lumen_session", value: session!.value, url: origin }]);
    await page.goto("/account");
    await page.waitForURL("**/login");
  } finally {
    await rm(inviteFile, { force: true });
  }
});
