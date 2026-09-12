import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasMessage } from "@/lib/i18n/messages";

/**
 * 错误码字典覆盖（方案 §3 H2）：客户端 `errorText` 按 `common.err.<code>` 查字典，
 * 前提是服务端每个稳定码都在字典里。这份清单不靠手抄——直接扫源码的四类出口，
 * 扫到而字典里没有的，在这里红掉并把缺的码打出来。
 *
 * 覆盖的出口：
 *  1. `new ProviderHttpError(<status>, "<code>"` —— 经 `jsonError` 变成信封 `error.code`；
 *  2. `src/lib/jobs/quota.ts` 的 `code: "<code>"` —— `assertQuota` 把 `block.code` 抛成 ProviderHttpError；
 *  3. `src/lib/billing/protocol.mjs` 的 `billingError("<code>")` —— 经 ledger/subscription 转成 ProviderHttpError；
 *  4. `src/app/api/**` 与 `src/proxy.ts` 的 `error: { code: "<code>"` 信封字面量
 *     （含 proxy 的 `refuse(<status>, "<code>")` 帮手）。
 *
 * 不在其中的：上游透传码（task-poll 的动态 `code`、`kling_*`）与任务/轮次记录里的
 * `job.error.code`（`needs_review`、`uncertain_submit` 等）——它们不是信封出口，
 * 撞到 `errorText` 时走 `common.err.unknown` + requestId。
 */

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) yield* walk(file);
    else if (/\.(ts|mjs)$/.test(name) && !/\.test\.(ts|mjs)$/.test(name)) yield file;
  }
}

const PROVIDER_RE = /new\s+ProviderHttpError\(\s*\d+\s*,\s*"([A-Za-z0-9_]+)"/g;
const ENVELOPE_RE = /error:\s*\{\s*code:\s*"([A-Za-z0-9_]+)"/g;
const REFUSE_RE = /refuse\(\s*\d+\s*,\s*"([A-Za-z0-9_]+)"/g;

function collectCodes(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (code: string, file: string) => {
    const rel = path.relative(SRC, file);
    if (!found.has(code)) found.set(code, new Set());
    found.get(code)!.add(rel);
  };

  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    const rel = path.relative(SRC, file);
    for (const m of text.matchAll(PROVIDER_RE)) add(m[1]!, file);
    const isEnvelopeExit = rel.startsWith(`app${path.sep}api${path.sep}`) || rel === "proxy.ts";
    if (isEnvelopeExit) {
      for (const m of text.matchAll(ENVELOPE_RE)) add(m[1]!, file);
      for (const m of text.matchAll(REFUSE_RE)) add(m[1]!, file);
    }
  }

  const quota = readFileSync(path.join(SRC, "lib", "jobs", "quota.ts"), "utf8");
  for (const m of quota.matchAll(/code:\s*"([a-z0-9_]+)"/g)) add(m[1]!, path.join(SRC, "lib", "jobs", "quota.ts"));

  const protocol = readFileSync(path.join(SRC, "lib", "billing", "protocol.mjs"), "utf8");
  for (const m of protocol.matchAll(/billingError\(\s*"([a-z0-9_]+)"/g)) {
    add(m[1]!, path.join(SRC, "lib", "billing", "protocol.mjs"));
  }
  return found;
}

describe("common.err.* 字典覆盖", () => {
  it("源码里每个服务端错误码都有 common.err.<code> 键", () => {
    const missing = [...collectCodes().entries()]
      .filter(([code]) => !hasMessage(`common.err.${code}`))
      .map(([code, files]) => `${code}（${[...files].join(", ")}）`)
      .sort();
    expect(missing, "以下错误码缺 common.err.<code> 文案").toEqual([]);
  });
});
