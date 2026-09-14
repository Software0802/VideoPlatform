import { expect, test, type Page } from "@playwright/test";

/**
 * 智能体闭环（方案 `docs/plan-agent-i18n-subscription-2026-09.md` §1）。
 *
 * 走的是真实路径：`POST /api/agent/sessions` → 一轮对话扣 ¥0.05 → 「海报」触发一条
 * `text_to_image` action → `createJob` 落一条普通任务 → 会话页渲染回复 + 任务卡 +
 * 资产栏。mock 模式下 LLM 是 `src/lib/agent/llm.ts` 的确定性替身（`LUMEN_FORCE_MOCK=1`
 * 时它排在任何 key 判定之前），所以断言可以钉死在「有一条 image action」上。
 *
 * 账号与余额由 `auth.setup.ts` 备好（注册 + `grant-balance.mjs` 充 ¥1000）。
 */

type Health = { ok: boolean; mockMode: boolean };

const REQUIRE_MOCK = Boolean(process.env.CI || process.env.E2E_REQUIRE_MOCK);

/** mock 的图片触发词。改这句话之前先看 `llm.ts` 的 `IMAGE_HINTS`。 */
const IDEA = "生成一张海边黄昏的海报";

async function health(page: Page): Promise<Health> {
  const res = await page.request.get("/api/health");
  expect(res.ok(), "健康检查应通过").toBeTruthy();
  return (await res.json()) as Health;
}

test.beforeEach(async ({ page, context, baseURL }) => {
  const h = await health(page);
  if (REQUIRE_MOCK) {
    expect(h.mockMode, "门禁要求 mock 模式的服务器，当前不是").toBeTruthy();
  }
  test.skip(!h.mockMode, "冒烟只在 mock 模式跑，避免消耗上游额度");
  // 语言由 Cookie 决定，没有 Cookie 时看 `Accept-Language`——Chromium 默认是 en-US。
  // 这组用例按中文文案写选择器，所以先把偏好钉死，而不是让它随浏览器默认漂。
  await context.addCookies([
    { name: "lumen_locale", value: "zh-CN", url: baseURL ?? "http://localhost:3000" },
  ]);
  await page.goto("/agent");
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
});

const view = (page: Page) => page.locator(".agent-view");
const idea = (page: Page) => page.getByRole("textbox", { name: "智能体提示词" });

/**
 * 本文件建出来的任务 id。智能体建的就是**普通任务**，会进主页作品流——而这个账号是
 * 整套 e2e 共用的，本文件又排在 `genius.spec.ts` 前面（Playwright 按文件名顺序跑），
 * 不收拾干净，那边的「瀑布流空态」用例就会看到这里留下的两张图。
 *
 * 积分退不回去（这一轮真的花掉了），所以那边的积分断言改成了相对差值；作品退得回去，
 * 就在这里退。
 */
const createdJobs: string[] = [];

const TERMINAL = new Set(["succeeded", "failed", "canceled", "expired"]);

/** 等到终态再删——进行中的任务 `DELETE /api/jobs/:id` 会 409。 */
async function dropJob(page: Page, jobId: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const res = await page.request.get(`/api/jobs/${jobId}`);
    if (!res.ok()) return;
    if (TERMINAL.has(((await res.json()) as { status: string }).status)) break;
    await page.waitForTimeout(500);
  }
  if ((await page.request.delete(`/api/jobs/${jobId}`)).status() === 409) {
    await page.request.post(`/api/jobs/${jobId}/cancel`);
    await page.request.delete(`/api/jobs/${jobId}`);
  }
}

/** 记下任务卡上的 job id，供收尾删除。 */
async function openPlaza(page: Page): Promise<void> {
  await page.locator(".agent-ask .agent-chip").last().click();
  await page.locator(".agent-skillpop__manage").click();
  await expect(view(page)).toHaveAttribute("data-screen", "plaza");
}

async function skillOff(page: Page): Promise<string[]> {
  const response = await page.request.get("/api/agent/skills");
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { off?: string[] }).off ?? [];
}

async function noteJob(page: Page): Promise<string> {
  const jobId = await page.locator(".agent-chat__job").first().getAttribute("data-job-id");
  expect(jobId, "任务卡应带上真实的 job id").toBeTruthy();
  createdJobs.push(jobId!);
  return jobId!;
}

test.afterEach(async ({ page }) => {
  for (const jobId of createdJobs.splice(0)) await dropJob(page, jobId);
  await page.request.patch("/api/agent/skills", { data: { skillId: "car-ad", off: false } });
});

test("智能体：一句想法 → 真实会话 + 助手回复 + 生成任务 + 资产栏", async ({ page }) => {
  await expect(view(page)).toHaveAttribute("data-screen", "home");
  // 技能来自 `GET /api/agent/skills`，不是写死的占位表。
  await expect(page.locator(".agent-card").first()).toBeVisible({ timeout: 30_000 });

  await idea(page).fill(IDEA);
  await page.getByRole("button", { name: "发送", exact: true }).click();

  // 发出去之后立刻进会话页，先显示「思考中」占位。
  await expect(view(page)).toHaveAttribute("data-screen", "chat");

  const answer = page.locator(".agent-chat__answer").last();
  await expect(answer).toBeVisible({ timeout: 60_000 });
  await expect(answer).not.toHaveAttribute("data-thinking", "true");
  await expect(answer.locator(".agent-chat__text").first()).not.toBeEmpty();

  // 默认批准制：先出提案卡（带报价），批准那一刻才真的建任务。
  await expect(answer.locator(".agent-chat__proposal")).toBeVisible();
  await answer.getByRole("button", { name: "批准生成" }).click();

  // 这一轮真的建了一条任务：消息里的任务卡与右侧资产栏说的是同一个 job id。
  const jobCard = page.locator(".agent-chat__job").first();
  await expect(jobCard).toBeVisible();
  await expect(jobCard).toHaveAttribute("data-kind", "image");
  const jobId = await noteJob(page);
  await expect(page.locator(`.agent-asset[data-job-id="${jobId}"]`)).toBeVisible();

  // 这一轮的对话费按 ¥1 = 100 积分显示（¥0.05 → 5 积分）。
  await expect(answer.locator(".agent-chat__credits")).toContainText("5");

  // 它就是一条普通任务：主页作品流按同一个 id 也能拿到它。
  const detail = await page.request.get(`/api/jobs/${jobId}`);
  expect(detail.ok(), "智能体建的任务应能从 /api/jobs/:id 读到").toBeTruthy();
  expect(((await detail.json()) as { mode: string }).mode).toBe("text_to_image");
});

test("智能体：对话模型可换、提案标产品、消息落款写明模型与档位", async ({ page }) => {
  // 白名单由 webServer env 注入；复用的 dev server 可能没配，那时只有一个模型可选。
  const skills = await page.request.get("/api/agent/skills");
  const chat = ((await skills.json()) as { chat?: { models: { id: string; name: string }[] } }).chat;
  test.skip((chat?.models.length ?? 0) < 2, "需要 AGENT_CHAT_MODELS 注入的双模型白名单");

  // 首页芯片显示默认模型的真名（不再是「自动 · 均衡」）。
  const chip = page.locator(".agent-ask .agent-chip").first();
  await expect(chip).toContainText("Mock 甲");
  await chip.click();
  // 弹层第一组是模型（name + id + 每轮积分），第二组是创意档。
  await page.locator('.agent-pop__item[data-chat-model="mock-agent-b"]').click();
  await expect(chip).toContainText("Mock 乙");

  await idea(page).fill(IDEA);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(view(page)).toHaveAttribute("data-screen", "chat");

  const answer = page.locator(".agent-chat__answer").last();
  await expect(answer).toBeVisible({ timeout: 60_000 });
  await expect(answer).not.toHaveAttribute("data-thinking", "true");

  // 落款：模型名 + 档位（zh-CN）。
  const meta = answer.locator(".agent-chat__meta");
  await expect(meta).toHaveAttribute("data-model", "mock-agent-b");
  await expect(meta).toContainText("Mock 乙");
  await expect(meta).toContainText("均衡");

  // 即使没点名，服务端也按实际路由解析并标明最终产品，不再显示「自动」。
  const proposal = answer.locator(".agent-chat__proposal");
  await expect(proposal).toBeVisible();
  await expect(proposal.locator(".agent-chat__proposal-product").first()).not.toHaveText("自动");

  await page.getByRole("button", { name: /通知/ }).click();
  const agentNotice = page
    .locator('.notify__item[data-kind="agent"][data-status="awaiting_approval"]')
    .first();
  await expect(agentNotice).toBeVisible();
  await agentNotice.click();
  await expect(page).toHaveURL(/\/agent\?session=ses_[0-9a-f]{16}$/);
  await expect(view(page)).toHaveAttribute("data-screen", "chat");

  // 对话页芯片可交互：换图片产品，下一轮生效。
  const imgChip = page.locator(".agent-chat__composer .agent-chip").nth(1);
  await imgChip.click();
  const pick = page.locator(".agent-pop--img .agent-pop__item[data-product-id]").first();
  const pickedName = (await pick.locator(".agent-pop__name").textContent())?.trim();
  await pick.click();
  await expect(imgChip).toContainText(pickedName ?? " ");

  const input = page.getByRole("textbox", { name: "会话输入" });
  await input.fill("再来一张图");
  await page.locator(".agent-chat__send").click();
  const second = page.locator(".agent-chat__answer").last();
  await expect(second).toBeVisible({ timeout: 60_000 });
  await expect(second).not.toHaveAttribute("data-thinking", "true");
  // 第二轮沿会话头记住的 mock-agent-b，提案写明用户点名的产品。
  await expect(second.locator(".agent-chat__meta")).toHaveAttribute("data-model", "mock-agent-b");
  await expect(second.locator(".agent-chat__proposal-product").first()).toHaveText(pickedName ?? "");
});

test("智能体：历史抽屉列出真实会话，点进去能读回对话", async ({ page }) => {
  await idea(page).fill(IDEA);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".agent-chat__answer").last()).toBeVisible({ timeout: 60_000 });
  // 提案 → 批准 → 任务卡。
  const answer = page.locator(".agent-chat__answer").last();
  await answer.getByRole("button", { name: "批准生成" }).click();
  await expect(page.locator(".agent-chat__job").first()).toBeVisible();
  await noteJob(page);

  await page.getByRole("button", { name: "返回智能体" }).first().click();
  await expect(view(page)).toHaveAttribute("data-screen", "home");

  await page.getByRole("button", { name: "历史记录" }).click();
  const drawer = page.locator(".agent-drawer");
  await expect(drawer).toBeVisible();
  const row = drawer.locator(".agent-drawer__row").first();
  await expect(row).toBeVisible();
  // 标题来自第一句用户输入，不是占位字符串。
  await expect(row.locator(".agent-drawer__item-name")).toContainText("海报");

  await row.locator(".agent-drawer__item").click();
  await expect(view(page)).toHaveAttribute("data-screen", "chat");
  await expect(page.locator(".agent-chat__bubble").first()).toContainText(IDEA);
  await expect(page.locator(".agent-chat__job").first()).toBeVisible();
});

test("智能体：技能开关按账号持久化并从首页下拉移除", async ({ page }) => {
  await openPlaza(page);
  const card = page.locator('.agent-plaza-card[data-skill-id="car-ad"]');
  const toggle = card.locator('.agent-switch');
  await expect(toggle).toHaveAttribute("data-on", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-on", "false");
  await expect.poll(() => skillOff(page)).toContain("car-ad");

  await page.reload();
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true");
  await openPlaza(page);
  await expect(page.locator('.agent-plaza-card[data-skill-id="car-ad"] .agent-switch')).toHaveAttribute(
    "data-on",
    "false",
  );

  await page.locator(".agent-round").click();
  await page.locator(".agent-ask .agent-chip").last().click();
  await expect(page.locator('.agent-skillpop__item[data-skill-id="car-ad"]')).toHaveCount(0);
});

test("智能体：一次性迁移旧 localStorage 技能开关", async ({ page }) => {
  await page.evaluate(() => {
    window.localStorage.setItem("genius.agent.skillsOff", JSON.stringify({ "car-ad": true }));
  });
  await page.reload();
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true");
  await expect.poll(() => skillOff(page)).toContain("car-ad");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("genius.agent.skillsOff")))
    .toBeNull();
});
