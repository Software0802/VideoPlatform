import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("repository operating contracts", () => {
  it("keeps agent rules readable without truncating safety and billing invariants", async () => {
    const bytes = await readFile("AGENTS.md");
    expect(bytes.length).toBeLessThanOrEqual(12_288);
    const text = bytes.toString("utf8");
    expect(Buffer.byteLength(text.replace(/\r?\n/g, "\r\n"))).toBeLessThanOrEqual(12_288);
    for (const term of ["next/dist/docs/", "withAdmissionLock", "applyBalanceChange", "refundOf", "private, no-cache", "uncertain_submit", "billing_export_corrupt", "LUMEN_SESSION_SECRET", "expectedRevision"]) {
      expect(text).toContain(term);
    }
  });

  it("indexes every documentation file as current guidance or historical evidence", async () => {
    const index = await readFile("docs/README.md", "utf8");
    const files = (await readdir("docs", { withFileTypes: true })).filter((entry) => entry.isFile());
    for (const file of files) expect(index, `missing docs/${file.name}`).toContain(file.name);
  });

  it("runs one typecheck definition everywhere: dev types cleared, then typegen, then tsc", async () => {
    /*
      三个调用点（本机 / CI / deploy.sh）必须是同一条命令，否则「CI 绿、本地红」会再来
      一次（review 2026-09-15 B-01）：`.next/dev/types/**` 是 Next 托管的 tsconfig include，
      切分支或删路由后旧 dev 产物会引用已不存在的路由文件，让裸 `tsc --noEmit` 必红，而
      干净检出的 CI 什么都看不到。脚本先删它，再 typegen（F-01：类型必须在 tsc 之前生成）。
    */
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const typecheck = pkg.scripts?.typecheck ?? "";
    expect(typecheck).toContain(".next/dev/types");
    expect(typecheck.indexOf("next typegen")).toBeGreaterThan(typecheck.indexOf(".next/dev/types"));
    expect(typecheck.indexOf("tsc --noEmit")).toBeGreaterThan(typecheck.indexOf("next typegen"));

    for (const file of [".github/workflows/ci.yml", "scripts/deploy.sh"]) {
      const text = await readFile(file, "utf8");
      expect(text, `${file} 应调用 pnpm typecheck`).toContain("pnpm typecheck");
      expect(text, `${file} 不应再各写一份 tsc 调用`).not.toContain("pnpm exec tsc --noEmit");
    }
  });

  it("drives e2e admin CLIs over HTTP: `--offline` cannot hold while Playwright keeps a server up", async () => {
    /*
      同一类「本机绿、CI 红」（review 2026-09-15 B-01 的兄弟）：`--offline` 直写文件
      要求服务确实没在跑，`scripts/lib/admin-client.mjs` 的 `assertServiceStopped`
      只放行 ECONNREFUSED。而 e2e 全程有服务在 `e2eBaseUrl()` 上，所以 e2e 里
      **任何** `--offline` 的成败都只取决于探测地址上恰好有没有人应答：本机把
      `E2E_PORT` 挪开、3000 空着就放行；CI 不设 `E2E_PORT`、服务正在 3000 就拒绝。
      `subscription.spec.ts` 的 `fund()` 踩的就是这条，定时 e2e 因此连红六轮。
      规则钉在这里：e2e 不传 `--offline`，管理 CLI 一律令牌 + 共用地址走 HTTP。
    */
    const ADMIN_CLI = /scripts\/(grant-balance|mint-gift-codes|mint-invites|reset-password|disable-user)\.mjs/;
    const files = (await readdir("e2e", { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts"),
    );
    expect(files.length, "e2e 目录应有用例").toBeGreaterThan(0);

    let callSites = 0;
    for (const entry of files) {
      const file = path.join("e2e", entry.name);
      const text = await readFile(file, "utf8");
      // 引号限定成实参字面量，正文注释里解释为什么不能用 `--offline` 不算违规。
      expect(text, `${file} 不能给管理 CLI 传 --offline：e2e 期间服务一直在跑`).not.toMatch(
        /(["'])--offline\1/,
      );
      if (!ADMIN_CLI.test(text)) continue;
      callSites += 1;
      expect(text, `${file} 调管理 CLI 必须带 LUMEN_ADMIN_TOKEN`).toContain("LUMEN_ADMIN_TOKEN");
      expect(text, `${file} 的 LUMEN_ADMIN_BASE_URL 必须来自共用的 e2eBaseUrl()`).toMatch(
        /LUMEN_ADMIN_BASE_URL:\s*e2eBaseUrl\(\)/,
      );
    }
    // 下限而不是等号：新增调用点是正常演进，上面的循环已经逐个校验；这里只防
    // 「正则一个都没匹配上，于是整条用例空转绿」。
    expect(callSites, "应至少有 auth.setup / genius / subscription 三个管理 CLI 调用点").toBeGreaterThanOrEqual(3);

    // 探测地址与浏览器地址必须同源：分家就等于把绿红交给「3000 上有没有人」。
    const config = await readFile("playwright.config.ts", "utf8");
    expect(config, "playwright.config 的 baseURL 应同样取自 e2eBaseUrl()").toMatch(
      /baseURL:\s*BASE_URL/,
    );
    expect(config).toMatch(/const BASE_URL = e2eBaseUrl\(\);/);
  });
});
