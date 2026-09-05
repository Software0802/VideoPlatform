import { expect, test, type Page } from "@playwright/test";

/**
 * mock 模式冒烟：空态 / 文生视频完成 / 图生视频首帧上传 / [fail] 重试 / 存档进详情。
 * 依赖 mock provider 的 `[fail]` 提示词标记（src/lib/providers/mock.ts）。
 */

const readout = (page: Page) => page.locator(".readout");

async function submitPrompt(page: Page, prompt: string) {
  await page.getByRole("textbox", { name: "提示词" }).fill(prompt);
  await page.getByRole("button", { name: "Generate 生成" }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Idle · 待机")).toBeVisible();
});

test("空态：首屏、三条路径与存档都在", async ({ page }) => {
  await expect(page.getByRole("textbox", { name: "提示词" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate 生成" })).toBeVisible();
  await expect(page.locator(".paths")).toBeVisible();
  await expect(page.locator(".archive .plate").first()).toBeVisible();
  // mock 模式必须在首屏声明
  await expect(page.getByText("Mock · 模拟输出")).toBeVisible();
});

test("文生视频：提交后读数走到 Done，成片区块可下载", async ({ page }) => {
  await submitPrompt(page, "雨夜的外滩，一位穿深青色风衣的女人走向江边");
  await expect(readout(page)).toContainText(/Job [0-9A-F]{4}/);
  await expect(readout(page)).toContainText("完成 / Done", { timeout: 30_000 });
  await expect(readout(page)).toContainText("100%");
  const output = page.locator(".output");
  await expect(output).toBeVisible();
  await expect(output.locator("video")).toHaveAttribute("src", /\/api\/.+/);
  await expect(output.getByRole("link", { name: /Download/ })).toHaveAttribute("href", /download=1/);
});

test("图生视频：上传首帧后自动切路径并完成", async ({ page }) => {
  await page.getByRole("button", { name: /Grok · video/ }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: /首帧/ }).first().click(),
  ]);
  await chooser.setFiles({
    name: "first.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await expect(page.getByRole("radio", { name: /图生视频/ })).toBeChecked();
  await submitPrompt(page, "镜头缓慢推进");
  await expect(readout(page)).toContainText("完成 / Done", { timeout: 30_000 });
  await expect(page.locator(".output")).toBeVisible();
});

test("失败态：[fail] 提示词失败后可重试，重试是一条新任务", async ({ page }) => {
  await submitPrompt(page, "冒烟 [fail]");
  await expect(readout(page)).toContainText("失败 / Failed");
  await expect(readout(page)).toContainText("模拟失败");
  const idBefore = (await readout(page).locator(".readout__id").textContent()) ?? "";
  await page.getByRole("button", { name: /Retry/ }).click();
  await expect(readout(page).locator(".readout__id")).not.toHaveText(idBefore);
  // 提示词未变，新任务同样失败并再次给出重试入口
  await expect(readout(page)).toContainText("失败 / Failed");
  await expect(page.getByRole("button", { name: /Retry/ })).toBeVisible();
});

test("存档：点击成片进入详情，Reuse 回填提示词", async ({ page }) => {
  const plate = page.locator(".archive .plate").first();
  const prompt = (await plate.locator(".plate__prompt").textContent()) ?? "";
  await plate.click();
  const detail = page.locator(".detail");
  await expect(detail).toBeVisible();
  await expect(detail.locator(".detail__prompt")).toHaveText(prompt);
  await detail.getByRole("button", { name: /Reuse/ }).click();
  await expect(page.getByRole("textbox", { name: "提示词" })).toHaveValue(prompt);
  await expect(detail).toBeHidden();
});
