import { readFile, readdir } from "node:fs/promises";
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
});
