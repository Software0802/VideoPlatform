import { expect, test, type Page } from "@playwright/test";

/**
 * 画布保存 409 冲突二选一（2026-09-13）：双标签页各改一笔，后到的一方不再被
 * 静默覆盖——弹层展示「本地 / 服务端」两份摘要，由用户选。
 *
 * 同一登录态开两个 page（同 context 共享 Cookie），先后改同一张画布：
 * A 先落盘（PATCH 200）→ B 的防抖 PATCH 撞 409 → `.canvas-conflict` 弹层。
 */

type Health = { ok: boolean; mockMode: boolean };
const REQUIRE_MOCK = Boolean(process.env.CI || process.env.E2E_REQUIRE_MOCK);

test.beforeEach(async ({ page }) => {
  const res = await page.request.get("/api/health");
  const h = (await res.json()) as Health;
  if (REQUIRE_MOCK) {
    expect(h.mockMode, "门禁要求 mock 模式的服务在前跑").toBeTruthy();
  }
  test.skip(!h.mockMode, "冒烟只在 mock 模式跑，真 key 环境下这条 skip");
  await page.goto("/canvas");
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.locator(".canvas-scroll")).toBeVisible({ timeout: 60_000 });
});

/** 右键画布空白处 → 菜单里点「文生图」→ 填提示词。返回节点 locator。 */
async function addImageNode(page: Page, prompt: string) {
  await page.locator(".canvas-view").click({ button: "right", position: { x: 120, y: 200 } });
  const menu = page.locator(".canvas-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: "文生图" }).click();
  await expect(menu).toBeHidden();
  const node = page.locator('.canvas-node[data-kind="gen_image"]').last();
  await expect(node).toBeVisible();
  await node.locator(".canvas-node__textarea").fill(prompt);
  return node;
}

/** 等一次 PATCH /api/canvases/:id 完成（600ms 防抖之后发出）。 */
async function waitPatch(page: Page) {
  const res = await page.waitForResponse(
    (r) => r.url().includes("/api/canvases/") && r.request().method() === "PATCH",
    { timeout: 20_000 },
  );
  return res.status();
}

test("双标签页保存冲突：弹层二选一，保留本地覆盖 / 采用服务端", async ({ page, context }) => {
  const pageA = page;
  const pageB = await context.newPage();
  await pageB.goto("/canvas");
  await expect(pageB.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(pageB.locator(".canvas-scroll")).toBeVisible({ timeout: 60_000 });

  // 第一段：A 先落盘，B 后到撞 409 → 弹层 → 选「保留本地」。
  const patchA = waitPatch(pageA);
  await addImageNode(pageA, "甲的提示词");
  expect(await patchA).toBe(200);

  const patchB = waitPatch(pageB);
  await addImageNode(pageB, "乙的提示词");
  await patchB;

  const dialog = pageB.locator(".canvas-conflict");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("本地版本（未保存）")).toBeVisible();
  await expect(dialog.getByText("服务端版本")).toBeVisible();
  await expect(dialog.getByText(/个节点 · \d+ 条连线/).first()).toBeVisible();

  await dialog.getByRole("button", { name: "保留本地并覆盖服务端" }).click();
  await expect(dialog).toBeHidden();
  await expect(pageB.locator(".toast")).toHaveText("已用本地版本覆盖服务端");

  // B 的版本已是服务端事实：reload 后只有 B 的节点。
  await pageB.reload();
  await expect(pageB.locator(".canvas-scroll")).toBeVisible({ timeout: 60_000 });
  const nodesB = pageB.locator(".canvas-node");
  await expect(nodesB).toHaveCount(1);
  await expect(nodesB.first().locator(".canvas-node__textarea")).toHaveValue("乙的提示词");

  // 第二段：再造一次冲突，选「采用服务端」——本地修改被丢弃。
  // A 的本地 revision 已落后（服务端是 B 覆盖后的版本）：先 reload 同步再改。
  await pageA.reload();
  await expect(pageA.locator(".canvas-scroll")).toBeVisible({ timeout: 60_000 });
  const patchA2 = waitPatch(pageA);
  await addImageNode(pageA, "甲的第二个节点");
  expect(await patchA2).toBe(200);

  const patchB2 = waitPatch(pageB);
  await addImageNode(pageB, "乙不该留下的节点");
  await patchB2;

  const dialog2 = pageB.locator(".canvas-conflict");
  await expect(dialog2).toBeVisible();
  await dialog2.getByRole("button", { name: "采用服务端，丢弃本地" }).click();
  await expect(dialog2).toBeHidden();
  await expect(pageB.locator(".toast")).toHaveText("已切换到服务端版本，本地修改已丢弃");

  await pageB.reload();
  await expect(pageB.locator(".canvas-scroll")).toBeVisible({ timeout: 60_000 });
  const after = pageB.locator(".canvas-node");
  await expect(after).toHaveCount(2);
  const values = await Promise.all(
    (await after.locator(".canvas-node__textarea").all()).map((l) => l.inputValue()),
  );
  expect(values).toContain("乙的提示词");
  expect(values).toContain("甲的第二个节点");
  expect(values).not.toContain("乙不该留下的节点");
});

/** 375×667：冲突弹层必须完整落在视口内（修过 top:50% 相对高 .canvas-view 被裁的回归）。 */
test.describe("移动端 375×667", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("冲突弹层完整可见且按钮在视口内", async ({ page, context }) => {
    const pageA = page;
    const pageB = await context.newPage();
    await pageB.goto("/canvas");
    await expect(pageB.locator(".canvas-scroll")).toBeVisible({ timeout: 60_000 });

    const patchA = waitPatch(pageA);
    await addImageNode(pageA, "甲的提示词");
    expect(await patchA).toBe(200);

    const patchB = waitPatch(pageB);
    await addImageNode(pageB, "乙的提示词");
    await patchB;

    const dialog = pageB.locator(".canvas-conflict");
    await expect(dialog).toBeVisible();

    const viewBox = await pageB.locator(".canvas-view").boundingBox();
    const box = await dialog.boundingBox();
    console.log(`[measure] .canvas-view=${JSON.stringify(viewBox)} .canvas-conflict=${JSON.stringify(box)}`);
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    expect(box!.y + box!.height).toBeLessThanOrEqual(667);

    const keep = dialog.getByRole("button", { name: "保留本地并覆盖服务端" });
    const useServer = dialog.getByRole("button", { name: "采用服务端，丢弃本地" });
    await expect(keep).toBeVisible();
    await expect(keep).toBeInViewport();
    await expect(useServer).toBeVisible();
    await expect(useServer).toBeInViewport();

    await useServer.click();
    await expect(dialog).toBeHidden();
  });
});
