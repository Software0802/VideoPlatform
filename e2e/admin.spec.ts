import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { serverDataDir } from "./invites";
import { E2E_ADMIN_USER_ID, E2E_SESSION_SECRET } from "./paths";

/**
 * `/admin/relays` 中转管理页（N3.5，方案 plan-relay-provider §4b）。
 *
 * 管理员 = `LUMEN_ADMIN_USER_ID` 点名的那个 user.id（env 在服务启动时固定，没法指向
 * 注册接口随机生成的 id）。所以这个 spec 的做法是：把一个**固定 id** 的 user.json 直接写进
 * 服务器的 `data/users/`（会话按 id 读 user.json，不经过 email→id 索引缓存），再用 e2e
 * 的固定 `LUMEN_SESSION_SECRET` 伪造一条签名合法的会话 Cookie。
 *
 * 复用的 dev server 需要自带 `LUMEN_ADMIN_USER_ID` / 同一个 session secret，否则
 * `becomeAdmin` 返回 false，管理员用例整组 skip——与「复用服务器非 mock 则 skip」
 * 同一口径。
 */

const ADMIN_ID = E2E_ADMIN_USER_ID;
const ADMIN_EMAIL = "e2e-admin@lumen.test";

const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? 3000}`;

type Health = { ok: boolean; mockMode: boolean };

test.beforeEach(async ({ page }) => {
  const res = await page.request.get("/api/health");
  expect(res.ok(), "健康检查应通过").toBeTruthy();
  const h = (await res.json()) as Health;
  test.skip(!h.mockMode, "冒烟只在 mock 模式跑，避免消耗上游额度");
});

/**
 * 播种管理员 user.json 并把它的签名会话种进当前 context。
 * 返回 false 表示服务器没带 e2e 的管理员 env（复用 dev server 的常见情形），调用方 skip。
 */
async function becomeAdmin(page: Page): Promise<boolean> {
  const dir = await serverDataDir();
  const now = new Date().toISOString();
  const userDir = path.join(dir, "users", ADMIN_ID);
  await mkdir(userDir, { recursive: true });
  await writeFile(
    path.join(userDir, "user.json"),
    JSON.stringify({
      id: ADMIN_ID,
      email: ADMIN_EMAIL,
      // 从不走密码登录（持有的是伪造会话），hash 只需满足 schema 的非空字符串。
      passwordHash: "scrypt$16384$8$1$00$00",
      sessionEpoch: 1,
      plan: "free",
      balanceCny: 0,
      memberCreditsCny: 0,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const epoch = 1;
  const signature = createHmac("sha256", E2E_SESSION_SECRET)
    .update(`v1.${ADMIN_ID}.${expiresAt}.${epoch}`)
    .digest("base64url");
  await page.context().addCookies([
    {
      name: "lumen_session",
      value: `${ADMIN_ID}.${expiresAt}.${epoch}.${signature}`,
      url: BASE,
    },
  ]);
  // 验签失败（secret 不同）→ /api/me 401；env 未点名 → /api/admin/relays 404。
  const me = await page.request.get("/api/me");
  if (!me.ok()) return false;
  const relays = await page.request.get("/api/admin/relays");
  return relays.ok();
}

/** 表单里建一条 relay 并等 POST 落定。 */
async function createRelayViaForm(
  page: Page,
  input: { id: string; name: string; priority: string },
): Promise<void> {
  await page.getByRole("button", { name: "新建中转" }).click();
  const form = page.locator(".relay-admin__create");
  await form.locator('input[name="id"]').fill(input.id);
  await form.locator('input[name="name"]').fill(input.name);
  await form.locator('input[name="baseUrl"]').fill(`https://${input.id}.example.com/v1`);
  await form.locator('input[name="keyEnv"]').fill(`${input.id.replace(/-/g, "_").toUpperCase()}_KEY`);
  await form.locator('input[name="priority"]').fill(input.priority);
  const created = page.waitForResponse(
    (res) => res.url().includes("/api/admin/relays") && res.request().method() === "POST" && res.ok(),
  );
  await form.getByRole("button", { name: "创建" }).click();
  await created;
  await expect(page.locator(`.relay-row[data-relay-id="${input.id}"]`)).toBeVisible();
}

/** 列表里的 data-relay-id 顺序（断言 priority 排序生效）。 */
async function relayOrder(page: Page): Promise<string[]> {
  return page.locator(".relay-row").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-relay-id") ?? ""),
  );
}

test("非管理员：/admin/relays 返回 404，头像菜单没有「中转管理」入口", async ({ page }) => {
  const res = await page.goto("/admin/relays");
  expect(res?.status(), "非管理员访问应是 404（与 /api/admin/* 同口径，不可探测）").toBe(404);

  await page.goto("/");
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await page.locator(".top__avatar").click();
  await expect(page.locator(".top__menu")).toBeVisible();
  await expect(
    page.locator(".top__menu").getByRole("button", { name: "中转管理" }),
  ).toHaveCount(0);
});

test("管理员：列表出现 yman / openai 预设与健康灯，probe 有计费确认", async ({ page }) => {
  test.skip(
    !(await becomeAdmin(page)),
    "服务器没有 e2e 的管理员 env（LUMEN_ADMIN_USER_ID / session secret），仅隔离跑法覆盖",
  );

  const res = await page.goto("/admin/relays");
  expect(res?.status(), "管理员访问应 200").toBe(200);
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });

  // 头像菜单入口对管理员可见。
  await page.locator(".top__avatar").click();
  await expect(
    page.locator(".top__menu").getByRole("button", { name: "中转管理" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // 老 env 折算的两条预设（mock 实例没有 relays.json）。
  await expect(page.locator('.relay-row[data-relay-id="yman"]')).toBeVisible();
  await expect(page.locator('.relay-row[data-relay-id="openai"]')).toBeVisible();
  // env 预设不可管理：开关与删除都不该可用。
  await expect(
    page.locator('.relay-row[data-relay-id="yman"] .relay-admin__toggle'),
  ).toBeDisabled();
  await expect(
    page.locator('.relay-row[data-relay-id="yman"]').getByRole("button", { name: "删除" }),
  ).toHaveCount(0);
  // 健康灯存在且带 data-health（颜色 + 文案双编码）。
  await expect(page.locator(".relay-admin__health[data-health]").first()).toBeVisible();

  // probe 先弹「上游可能计费」确认；mock 下不真发（dismiss 掉）。
  const yman = page.locator('.relay-row[data-relay-id="yman"]');
  await expect(yman.getByRole("button", { name: "探测" })).toBeVisible();
  await expect(yman.getByRole("button", { name: "目录发现" })).toBeVisible();
  const dialog = new Promise<string>((resolve) => {
    page.once("dialog", (d) => {
      void d.dismiss();
      resolve(d.message());
    });
  });
  await yman.getByRole("button", { name: "探测" }).click();
  expect(await dialog, "probe 的确认文案应提到计费").toContain("计费");
});

test("管理员：新建 → 上移换 priority → 删除", async ({ page }) => {
  test.skip(!(await becomeAdmin(page)), "服务器没有 e2e 的管理员 env");
  await page.goto("/admin/relays");
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });

  // 收尾无论成败都把两条测试 relay 删掉，别把残留写进（可能是开发机的）DATA_DIR。
  try {
    await createRelayViaForm(page, { id: "e2e-relay-a", name: "E2E Relay A", priority: "5" });
    await createRelayViaForm(page, { id: "e2e-relay-b", name: "E2E Relay B", priority: "3" });

    // priority 升序：b(3) 在 a(5) 前。
    const order = await relayOrder(page);
    expect(order.indexOf("e2e-relay-b")).toBeLessThan(order.indexOf("e2e-relay-a"));

    // 上移 a：与相邻的 b 交换 priority（两次 PATCH）。
    const rowA = page.locator('.relay-row[data-relay-id="e2e-relay-a"]');
    const patched = page.waitForResponse(
      (res) => res.url().includes("/api/admin/relays/") && res.request().method() === "PATCH" && res.ok(),
    );
    await rowA.getByRole("button", { name: "上移" }).click();
    await patched;
    await expect
      .poll(async () => {
        const ids = await relayOrder(page);
        return ids.indexOf("e2e-relay-a") - ids.indexOf("e2e-relay-b");
      })
      .toBeLessThan(0);

    // 启停开关：文件条目可切。
    await rowA.locator(".relay-admin__toggle").click();
    await expect(rowA).toHaveAttribute("data-enabled", "false");

    // 删除（confirm 接受）。
    for (const id of ["e2e-relay-a", "e2e-relay-b"]) {
      page.once("dialog", (d) => void d.accept());
      const deleted = page.waitForResponse(
        (res) =>
          res.url().includes(`/api/admin/relays/${id}`) &&
          res.request().method() === "DELETE" &&
          res.status() === 204,
      );
      await page
        .locator(`.relay-row[data-relay-id="${id}"]`)
        .getByRole("button", { name: "删除" })
        .click();
      await deleted;
      await expect(page.locator(`.relay-row[data-relay-id="${id}"]`)).toHaveCount(0);
    }
  } finally {
    for (const id of ["e2e-relay-a", "e2e-relay-b"]) {
      await page.request
        .delete(`/api/admin/relays/${id}`)
        .catch(() => undefined);
    }
  }
});
