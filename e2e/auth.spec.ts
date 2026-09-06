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
    const avatarBtn = page.getByRole("button", { name: "账户" });
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
    //    硬约束）。新账号余额是 0，这里同时验证「不够就禁用提交」，UI 与后端各查一遍。
    const me = (await (await page.request.get("/api/me")).json()) as {
      email: string;
      balance?: { availableCny: number };
    };
    expect(me.email).toBe(EMAIL);
    if (me.balance) {
      expect(me.balance.availableCny).toBe(0);
      await expect(page.locator(".top__credits")).toHaveAttribute("aria-label", "积分 0");

      await page.getByRole("button", { name: "描述你想创作的内容" }).click();
      await expect(page.locator(".composer")).toHaveAttribute("data-open", "true");
      await page.getByRole("textbox", { name: "提示词" }).fill("随便试一下");
      // 按钮名恒为「创作」（§7），不像旧版会把可访问名换成警示文案；用 disabled + 错误行判断。
      await expect(page.getByRole("button", { name: "创作", exact: true })).toBeDisabled();
      await expect(page.locator(".composer__error")).toHaveAttribute("role", "alert");
      await expect(page.locator(".composer__error")).toContainText(/余额|充值/);

      // 同一条硬约束在后端的独立验证：绕开 UI 直接打 API 也必须是 402，不能只是前端好看。
      const denied = await page.request.post("/api/jobs", {
        data: { mode: "text_to_video", prompt: "随便试一下" },
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
