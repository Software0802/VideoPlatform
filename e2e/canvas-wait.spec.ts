import { expect, test, type Page } from "@playwright/test";

/**
 * 画布的「转圈要停下来」回归（2026-09-17）。
 *
 * 用户报的现象是画布节点在成片之后仍然一直转圈。根因在传输层（响应体没有静默上限，
 * 成片下载中途停住就把任务永远挂在 `persisting` 这个非终态上，见
 * `providers/grok/client.ts` 的 `watchBodyIdle`），但当时全仓没有任何一条用例断言过
 * 「任务终态之后节点不再显示等待态」——`motion.spec.ts` 只覆盖了创作页的等待层，
 * 画布这一侧是空白。这两条把单节点运行与整图运行的收尾都钉住。
 *
 * mock 下跑：断言的是界面对终态的反应，不是出片质量。
 */

type Health = { ok: boolean; mockMode: boolean };

/**
 * 跑完把本用例建出来的任务删掉。
 *
 * 这个账号是全套 e2e 共用的（`auth.setup.ts` 注册一次给所有 spec 用），而
 * `genius.spec.ts` 的「空态」用例断言瀑布流里一条作品都没有——文件名排序让本文件先跑，
 * 留下的成片会把那条用例打红。删除是终态任务的正常动作，不动别人的数据。
 */
async function deleteJobs(page: Page, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    if (id) await page.request.delete(`/api/jobs/${id}`).catch(() => undefined);
  }
}

async function freshCanvas(page: Page) {
  const created = await page.request.post("/api/canvases", { data: { title: "e2e 等待态画布" } });
  expect(created.status()).toBe(201);
  await page.goto("/canvas");
  await expect(page.locator(".shell")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.locator(".canvas-scroll")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".canvas-node")).toHaveCount(0);
}

test("画布单节点运行：任务终态后节点不再显示等待态", async ({ page }) => {
  const h = (await (await page.request.get("/api/health")).json()) as Health;
  test.skip(!h.mockMode, "只在 mock 模式跑");
  await freshCanvas(page);

  await page.locator(".canvas-view").click({ button: "right", position: { x: 120, y: 200 } });
  const menu = page.locator(".canvas-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: "生成视频" }).click();
  const node = page.locator('.canvas-node[data-kind="gen_video"]').last();
  await expect(node).toBeVisible();
  await node.locator(".canvas-node__textarea").fill("海边灯塔的一个缓慢推镜");

  const runRes = page.waitForResponse(
    (r) => r.url().includes("/nodes/") && r.url().endsWith("/run") && r.request().method() === "POST",
    { timeout: 30_000 },
  );
  await node.locator(".canvas-node__run").click();
  const created = await runRes;
  expect(created.ok(), "单节点运行应成功").toBeTruthy();
  const jobId = ((await created.json()) as { job: { id: string } }).job.id;

  // 运行中：节点应处于等模型的等待态。
  await expect(node).toHaveAttribute("data-wait", "model", { timeout: 20_000 });

  // 服务端把任务跑到终态（mock 几秒内出片）。
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/jobs/${jobId}`);
        return res.ok() ? ((await res.json()) as { status: string }).status : "unknown";
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe("succeeded");

  try {
    // 关键断言：任务已经终态，界面上的等待态必须在几个轮询周期内撤掉。
    await expect(node, "任务成片后节点不该还在转圈").not.toHaveAttribute("data-wait", "model", {
      timeout: 20_000,
    });
    await expect(node.locator(".canvas-node__video")).toBeVisible({ timeout: 20_000 });
  } finally {
    await deleteJobs(page, [jobId]);
  }
});

test("画布整图运行：run 终态后节点与视图都不再显示等待态", async ({ page }) => {
  const h = (await (await page.request.get("/api/health")).json()) as Health;
  test.skip(!h.mockMode, "只在 mock 模式跑");
  await freshCanvas(page);

  await page.locator(".canvas-view").click({ button: "right", position: { x: 120, y: 200 } });
  await page.locator(".canvas-menu").getByRole("button", { name: "生成视频" }).click();
  const node = page.locator('.canvas-node[data-kind="gen_video"]').last();
  await expect(node).toBeVisible();
  await node.locator(".canvas-node__textarea").fill("雨夜霓虹的街角，缓慢横移");

  // 整图运行 → 报价弹层 → 确认（生成视频节点默认勾「执行前需我批准」）
  await page.locator(".canvas-topright__btn").click();
  const quote = page.locator(".canvas-quote");
  await expect(quote).toBeVisible({ timeout: 30_000 });
  const gate = quote.getByRole("checkbox", { name: /批准/ });
  if (await gate.count()) await gate.first().uncheck().catch(() => undefined);
  await quote.getByRole("button", { name: "确认运行" }).click();
  await expect(quote).toBeHidden({ timeout: 30_000 });

  // 运行中：节点进等待态（等模型或等审批都算「在转」）
  await expect(node).toHaveAttribute("data-wait", /model|approval/, { timeout: 30_000 });

  // 如果落在人工审批门上，就批准它，让 run 一路跑到终态
  const approve = node.getByRole("button", { name: "批准" });
  if (await approve.count()) await approve.click();

  // run 走到终态（mock 出片很快）
  await expect
    .poll(
      async () => {
        const url = new URL(page.url());
        const canvasId = url.searchParams.get("id");
        const list = await page.request.get(`/api/canvases`);
        if (!list.ok()) return "unknown";
        const { canvases } = (await list.json()) as { canvases: { id: string }[] };
        const id = canvasId ?? canvases[0]?.id;
        if (!id) return "none";
        const res = await page.request.get(`/api/canvases/${id}/runs`);
        if (!res.ok()) return "unknown";
        const { runs } = (await res.json()) as { runs: { status: string }[] };
        return runs[0]?.status ?? "none";
      },
      { timeout: 180_000, intervals: [1500] },
    )
    .toMatch(/succeeded|partially_failed|failed|canceled/);

  const list = await page.request.get(`/api/canvases`);
  const { canvases } = (await list.json()) as { canvases: { id: string }[] };
  const runsRes = await page.request.get(`/api/canvases/${canvases[0].id}/runs`);
  const { runs } = (await runsRes.json()) as {
    runs: { nodeExecutions?: { jobId?: string }[] }[];
  };
  const runJobIds = (runs[0]?.nodeExecutions ?? [])
    .map((e) => e.jobId)
    .filter((id): id is string => Boolean(id));

  try {
    // 关键断言：run 已终态，节点与整视图都不该还在转
    await expect(node, "run 终态后节点不该还在转圈").not.toHaveAttribute("data-wait", /model|approval/, {
      timeout: 30_000,
    });
    await expect(page.locator(".canvas-view")).not.toHaveAttribute("data-running", "true", {
      timeout: 30_000,
    });
  } finally {
    await deleteJobs(page, runJobIds);
  }
});
