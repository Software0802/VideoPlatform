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

  it("generates route types before the clean-checkout CI typecheck", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("pnpm exec next typegen && pnpm exec tsc --noEmit");
  });
});
