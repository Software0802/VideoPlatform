import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { expect, test, type Page } from "@playwright/test";
import { DATA_DIR_HINT } from "./paths";

/**
 * 画布保存 409 冲突二选一（2026-09-13）：双标签页各改一笔，后到的一方不再被
 * 静默覆盖——弹层展示「本地 / 服务端」两份摘要，由用户选。
 *
 * 同一登录态开两个 page（同 context 共享 Cookie），先后改同一张画布：
 * A 先落盘（PATCH 200）→ B 的防抖 PATCH 撞 409 → `.canvas-conflict` 弹层。
 */

type Health = { ok: boolean; mockMode: boolean };
const REQUIRE_MOCK = Boolean(process.env.CI || process.env.E2E_REQUIRE_MOCK);

async function freshCanvas(page: Page) {
  const created = await page.request.post("/api/canvases", { data: { title: "e2e 独立画布" } });
  expect(created.status()).toBe(201);
  const { canvas } = await created.json();
  const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/canvases/${canvas.id}` && r.request().method() === "GET");
  await page.goto("/canvas");
  expect((await loaded).status()).toBe(200);
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.locator(".canvas-scroll")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".canvas-node")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  const res = await page.request.get("/api/health");
  const h = (await res.json()) as Health;
  if (REQUIRE_MOCK) {
    expect(h.mockMode, "门禁要求 mock 模式的服务在前跑").toBeTruthy();
  }
  test.skip(!h.mockMode, "冒烟只在 mock 模式跑，真 key 环境下这条 skip");
  await freshCanvas(page);
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
async function waitPatch(page: Page, prompt: string) {
  const res = await page.waitForResponse(
    (r) => r.url().includes("/api/canvases/") && r.request().method() === "PATCH" &&
      r.request().postDataJSON().nodes?.some((node: { prompt?: string }) => node.prompt === prompt),
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
  await expect(pageB.locator(".canvas-node")).toHaveCount(0);

  // 第一段：A 先落盘，B 后到撞 409 → 弹层 → 选「保留本地」。
  const patchA = waitPatch(pageA, "甲的提示词");
  await addImageNode(pageA, "甲的提示词");
  expect(await patchA).toBe(200);

  const patchB = waitPatch(pageB, "乙的提示词");
  await addImageNode(pageB, "乙的提示词");
  expect(await patchB, "B 的 PATCH 必须先返回真实的 409").toBe(409);

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
  // 独立新画布：两个标签页先载入同一份空底稿，不继承第一段的节点与 revision。
  await freshCanvas(pageA);
  await pageB.reload();
  await expect(pageB.locator(".canvas-scroll")).toBeVisible({ timeout: 60_000 });
  await expect(pageB.locator(".canvas-node")).toHaveCount(0);
  const patchA2 = waitPatch(pageA, "甲的第二个节点");
  await addImageNode(pageA, "甲的第二个节点");
  expect(await patchA2).toBe(200);

  const patchB2 = waitPatch(pageB, "乙不该留下的节点");
  await addImageNode(pageB, "乙不该留下的节点");
  expect(await patchB2, "第二段 B 的 PATCH 必须先返回真实的 409").toBe(409);

  const dialog2 = pageB.locator(".canvas-conflict");
  await expect(dialog2).toBeVisible();
  await dialog2.getByRole("button", { name: "采用服务端，丢弃本地" }).click();
  await expect(dialog2).toBeHidden();
  await expect(pageB.locator(".toast")).toHaveText("已切换到服务端版本，本地修改已丢弃");

  await pageB.reload();
  await expect(pageB.locator(".canvas-scroll")).toBeVisible({ timeout: 60_000 });
  const after = pageB.locator(".canvas-node");
  await expect(after).toHaveCount(1);
  const values = await Promise.all(
    (await after.locator(".canvas-node__textarea").all()).map((l) => l.inputValue()),
  );
  expect(values).toEqual(["甲的第二个节点"]);
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
    await expect(pageB.locator(".canvas-node")).toHaveCount(0);

    const patchA = waitPatch(pageA, "甲的提示词");
    await addImageNode(pageA, "甲的提示词");
    expect(await patchA).toBe(200);

    const patchB = waitPatch(pageB, "乙的提示词");
    await addImageNode(pageB, "乙的提示词");
    expect(await patchB, "移动端 B 的 PATCH 必须先返回真实的 409").toBe(409);

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

test("素材刷新后可预览，30 天到期显示重新上传而不是失效图片", async ({ page }) => {
  const image = await sharp({
    create: { width: 24, height: 18, channels: 3, background: { r: 40, g: 90, b: 150 } },
  }).jpeg().toBuffer();
  const saved = page.waitForResponse((r) => r.url().includes("/api/canvases/") &&
    r.request().method() === "PATCH" &&
    r.request().postDataJSON().nodes?.some((node: { uploadId?: string }) => Boolean(node.uploadId)));
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".canvas-view").click({ button: "right", position: { x: 120, y: 200 } });
  await page.locator(".canvas-menu").getByRole("button", { name: "素材", exact: true }).click();
  await (await chooser).setFiles({ name: "canvas.jpg", mimeType: "image/jpeg", buffer: image });
  const patch = await saved;
  expect(patch.status()).toBe(200);
  const { canvas } = await patch.json();
  const node = canvas.nodes.find((item: { kind: string }) => item.kind === "material");
  expect(node.assetId).toMatch(/^as_[0-9a-f]{16}$/);
  await page.reload();
  const preview = page.locator(".canvas-node__img");
  await expect(preview).toHaveAttribute("src", `/api/uploads/${node.assetId}`);
  await expect.poll(() => preview.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator(".canvas-node__material-note")).toContainText("素材保留至");

  const dataRoot = (await readFile(DATA_DIR_HINT, "utf8")).trim();
  const metadataPath = path.join(dataRoot, "assets", canvas.ownerId, `${node.assetId}.json`);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  expect((await page.request.get(`/api/uploads/${node.assetId}`)).status()).toBe(404);
  await page.reload();
  await expect(page.getByText("素材已过期或缺失，请重新上传", { exact: true })).toBeVisible();
  await expect(page.locator(".canvas-node__upload")).toBeVisible();
  await expect(page.locator(".canvas-node__img")).toHaveCount(0);
});

test("在途保存序列化：紧贴上一个 PATCH 的第二次改动不撞 409", async ({ page }) => {
  // 第一步：建节点。等它的防抖 PATCH「已发出」那一刻立刻做第二步——此刻
  // 服务端 revision 已 +1，但本地 doc 还没等到响应；没有保存链的话，第二次
  // 保存会带旧 expectedRevision 撞出冲突弹层。
  const firstSent = page.waitForRequest(
    (r) => r.url().includes("/api/canvases/") && r.method() === "PATCH",
  );
  const firstDone = page.waitForResponse(
    (r) =>
      r.url().includes("/api/canvases/") &&
      r.request().method() === "PATCH" &&
      (r.request().postDataJSON()?.nodes?.length ?? 0) === 1,
    { timeout: 20_000 },
  );
  await page.locator(".canvas-view").click({ button: "right", position: { x: 120, y: 200 } });
  const menu = page.locator(".canvas-menu");
  await menu.getByRole("button", { name: "文生图" }).click();
  const node = page.locator(`.canvas-node[data-kind="gen_image"]`).last();
  await expect(node).toBeVisible();
  await firstSent;

  const secondDone = page.waitForResponse(
    (r) =>
      r.url().includes("/api/canvases/") &&
      r.request().method() === "PATCH" &&
      Boolean(
        r.request().postDataJSON()?.nodes?.some(
          (n: { prompt?: string }) => n.prompt === "第二镜的提示词",
        ),
      ),
    { timeout: 20_000 },
  );
  await node.locator(".canvas-node__textarea").fill("第二镜的提示词");

  const [r1, r2] = await Promise.all([firstDone, secondDone]);
  expect(r1.status()).toBe(200);
  expect(r2.status()).toBe(200);
  const rev1 = (await r1.json()).canvas.revision;
  const rev2 = (await r2.json()).canvas.revision;
  expect(rev2).toBe(rev1 + 1);
  await expect(page.locator(".canvas-conflict")).toHaveCount(0);
});
