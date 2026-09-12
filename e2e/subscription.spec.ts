import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { serverDataDir } from "./invites";

/**
 * 订阅页（方案 `docs/plan-agent-i18n-subscription-2026-09.md` §3.3）。
 *
 * 三件事：四档显示的是**真实算出来的**人民币价格（不再是原型的美元占位）；已购余额
 * 不够时点订阅得到「余额不足」而不是静默失败；余额够时买得下来，「我的方案」立刻变成
 * 那一档并显示到账的会员积分。
 *
 * 价格随部署环境变（`costRatio()` 读当前 provider 次序与价目表），所以这里**不写死数字**：
 * 断言的是「是正数、带 ¥、年费 = 12 × 月费」这些不随环境变的性质，具体金额从
 * `GET /api/subscription` 取回来再和界面对。
 *
 * 用例顺序有意义：先测余额不足（此时还没有订阅），再测购买成功——买完之后账号上就有
 * 一份生效中的订阅，任何再次购买都会变成 409。
 */

type Health = { ok: boolean; mockMode: boolean };

const REQUIRE_MOCK = Boolean(process.env.CI || process.env.E2E_REQUIRE_MOCK);

type PlanRow = { id: string; monthlyCny: number; yearlyCny: number };

async function plans(page: Page): Promise<PlanRow[]> {
  const res = await page.request.get("/api/subscription");
  expect(res.ok(), "订阅档位接口应可读").toBeTruthy();
  return ((await res.json()) as { plans: PlanRow[] }).plans;
}

async function balanceCny(page: Page): Promise<number> {
  const res = await page.request.get("/api/me");
  expect(res.ok(), "账号接口应可读").toBeTruthy();
  const me = (await res.json()) as { balance?: { balanceCny?: number } };
  return me.balance?.balanceCny ?? 0;
}

/** 充值走真正的管理员 CLI（和 `auth.setup.ts` 同一条路径，顺带验证它还能跑）。 */
async function fund(page: Page, amountCny: number): Promise<void> {
  const me = (await (await page.request.get("/api/me")).json()) as { email: string };
  const script = path.resolve(__dirname, "../scripts/grant-balance.mjs");
  await promisify(execFile)(
    process.execPath,
    [
      script,
      me.email,
      String(amountCny),
      "--offline",
      "--ref",
      `e2e-fund:${me.email}:${Date.now()}`,
      "--note",
      "playwright subscription",
    ],
    { env: { ...process.env, DATA_DIR: await serverDataDir() } },
  );
}

test.beforeEach(async ({ page, baseURL }) => {
  const res = await page.request.get("/api/health");
  expect(res.ok(), "健康检查应通过").toBeTruthy();
  const h = (await res.json()) as Health;
  if (REQUIRE_MOCK) {
    expect(h.mockMode, "门禁要求 mock 模式的服务器，当前不是").toBeTruthy();
  }
  test.skip(!h.mockMode, "冒烟只在 mock 模式跑，避免消耗上游额度");

  // 语言固定成简体中文再进页面：Playwright 的 Chrome 默认 `Accept-Language: en-US`，
  // 不写这枚 Cookie 的话整页会渲染成英文，下面按中文写的断言全部落空。
  await page.context().addCookies([
    { name: "lumen_locale", value: "zh-CN", url: baseURL ?? "http://localhost:3000" },
  ]);
  await page.goto("/subscription");
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  // 卡片要等 `GET /api/subscription` 回来才渲染，而 dev 模式下这条路由的首次编译能到
  // 二三十秒——不在这里等一次，第一条用例就会在别人的编译时间上超时。
  await expect(page.locator(".sub-card").first()).toBeVisible({ timeout: 60_000 });
});

test("服务端不向浏览器下发成本比例与毛利率", async ({ page }) => {
  const res = await page.request.get("/api/subscription");
  expect(res.ok()).toBeTruthy();
  const raw = await res.text();
  // 价格是算出来的，但算它用的那两个数（进货价与加价幅度）不出网关。
  expect(raw).not.toContain("costRatio");
  expect(raw).not.toContain("grossMargin");
  expect(raw).not.toContain("basis");
});

test("四档显示真实人民币价格，脚注说明价格怎么来的", async ({ page }) => {
  const cards = page.locator(".sub-card");
  await expect(cards).toHaveCount(4);

  const rows = await plans(page);
  expect(rows.length, "服务端应下发四档").toBe(4);

  for (const row of rows) {
    // 价格必须是正数，年费恒等于 12 × 月费（毛利率固定，年付不打折）。
    expect(row.monthlyCny, `${row.id} 月费应为正数`).toBeGreaterThan(0);
    expect(row.yearlyCny).toBeCloseTo(row.monthlyCny * 12, 4);

    const price = page.locator(`.sub-card[data-plan="${row.id}"] .sub-card__price`);
    const text = (await price.textContent())?.trim() ?? "";
    expect(text, `${row.id} 卡片应显示 ¥ 价格`).toMatch(/^¥\d+(\.\d)?$/);
    expect(Number(text.replace("¥", ""))).toBeCloseTo(row.monthlyCny, 2);
  }

  // 脚注是**静态文案**：说清价格怎么来的、从哪个池扣，但不摆成本比例与毛利率的数字
  // （那是进货价，服务端根本不下发）。
  await expect(page.locator(".sub-basis")).toContainText("平台成本");
  await expect(page.locator(".sub-basis")).toContainText("已购积分");

  // 还没订阅：我的方案卡显示「未订阅」。
  await expect(page.locator('.sub-mine__plan[data-plan="none"]')).toHaveText("未订阅");
});

test("已购余额不够时点订阅：提示余额不足，不产生订阅", async ({ page }) => {
  const rows = await plans(page);
  const balance = await balanceCny(page);
  // 找一档「按年」买不起的（至尊年费在 mock 下约 ¥2000，账号初始 ¥1000）。
  const target = [...rows].reverse().find((row) => row.yearlyCny > balance);
  test.skip(!target, `账号余额 ¥${balance} 足以买下任何一档年费，这条用例无从触发`);

  await page.locator('.sub-cycle__btn[data-cycle="yearly"]').click();
  const card = page.locator(`.sub-card[data-plan="${target!.id}"]`);
  await card.getByRole("button", { name: "订阅", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "确认订阅" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认订阅", exact: true }).click();

  await expect(page.locator(".sub-toast__pill")).toHaveText("已购积分不足，请先兑换礼品码");
  await expect(page.locator('.sub-mine__plan[data-plan="none"]')).toHaveText("未订阅");
});

test("余额足够时买下标准档：我的方案变成该档并显示会员积分", async ({ page }) => {
  const rows = await plans(page);
  const standard = rows.find((row) => row.id === "standard");
  expect(standard, "标准档应存在").toBeTruthy();

  // 前面的用例可能花掉一些余额，这里补一笔，让这条用例不依赖别人剩下多少。
  await fund(page, Math.ceil(standard!.monthlyCny) + 50);
  await page.reload();
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.locator(".sub-card").first()).toBeVisible({ timeout: 60_000 });

  const card = page.locator('.sub-card[data-plan="standard"]');
  await card.getByRole("button", { name: "订阅", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认订阅" });
  await expect(dialog).toBeVisible();
  // 确认弹窗要说清扣多少、从哪个池扣。
  await expect(dialog).toContainText("已购积分");
  await dialog.getByRole("button", { name: "确认订阅", exact: true }).click();

  await expect(page.locator(".sub-toast__pill")).toHaveText("订阅成功，会员积分已到账");

  // 我的方案卡换成标准版，且带到期日。
  await expect(page.locator('.sub-mine__plan[data-plan="standard"]')).toHaveText("标准版");
  await expect(page.locator(".sub-mine__meta")).toContainText("到期");

  // 会员积分到账：标准档 1200，当天的日积分（+60）可能已经在同一次 /api/me 里发下来。
  const member = page.locator(".sub-mine__num[data-member-credits]");
  await expect
    .poll(async () => Number((await member.textContent())?.trim() ?? "0"), {
      message: "会员积分应至少到账 1200",
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(1200);

  // 已经是当前方案的那张卡不能再点。
  await expect(card.getByRole("button", { name: "当前方案", exact: true })).toBeDisabled();
});
