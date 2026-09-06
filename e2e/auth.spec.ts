import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { newInviteCode, serverDataDir, writeInvite } from "./invites";

/**
 * 登录 / 注册页与顶栏（方案 §7）。这条用例是唯一不带会话的：`test.use` 清掉
 * `auth.setup.ts` 留下的 Cookie，走完「被挡回登录页 → 用一次性邀请码注册 →
 * 落到首页 → 退出 → 又被挡回登录页」。
 *
 * 越权访问他人任务返回 404 已由单测覆盖，这里不重复。
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

test("未登录被送到登录页；注册后进首页、顶栏显示账号；退出后又被挡回", async ({ page }) => {
  const dataDir = await serverDataDir();
  const code = newInviteCode();
  const inviteFile = await writeInvite(dataDir, code);

  try {
    // 1. 未登录访问 / → 服务端重定向到 /login
    await page.goto("/");
    await page.waitForURL("**/login");
    await expect(page.locator(".app")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
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

    // 5. 真码注册 → 落到首页，顶栏显示 @ 前的部分
    await codeField(page).fill(code);
    await submit(page, "注册").click();
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.locator(".app")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(page.locator(".account__name")).toHaveText(EMAIL.split("@")[0]);
    await expect(page.getByRole("button", { name: "退出" })).toBeVisible();
    // 新账号没有任何任务：作品环回落样片，不串到别人的成片
    await expect(page.locator(".recent__item")).toHaveCount(6);

    // 6. 配额行：/api/me 给了 quota 就显示，没给就整行不渲染（方案 §6.3 的降级）
    const me = (await (await page.request.get("/api/me")).json()) as {
      email: string;
      quota?: { limit: number; remaining: number };
    };
    expect(me.email).toBe(EMAIL);
    if (me.quota) {
      await expect(page.locator(".composer__quota")).toHaveText(
        `今日剩余 ${me.quota.remaining}/${me.quota.limit}`,
      );
    } else {
      await expect(page.locator(".composer__quota")).toHaveCount(0);
    }

    // 7. 退出 → 回登录页，且 / 又被挡回
    await page.getByRole("button", { name: "退出" }).click();
    await page.waitForURL("**/login");
    await expect(page.getByRole("tab", { name: "登录" })).toBeVisible();
    await page.goto("/");
    await page.waitForURL("**/login");
  } finally {
    // 注册成功时码已被消费（文件仍在，标了 usedBy）；失败时别把活码留下
    await rm(inviteFile, { force: true });
  }
});
