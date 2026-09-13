import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type BuildInfo = {
  sha: string;
  shortSha: string;
  builtAt: string;
  /** **构建机**的 Node 版本（打 `deploy.sh` 那台），不是运行时——生产运行时见 runbook 环境事实表。 */
  node: string;
  dirty: boolean;
};

const buildInfoSchema = z.object({
  sha: z.string().min(1),
  shortSha: z.string().min(1),
  builtAt: z.string().min(1),
  node: z.string().min(1),
  dirty: z.boolean(),
});

let cached: BuildInfo | null | undefined;

/**
 * 发布包根的 `BUILD_INFO.json`（`scripts/deploy.sh` 打包时写入）。开发环境与普通
 * 本地构建没有它，返回 null；缺文件 / 非法 JSON / 结构不符一律不抛。结果按进程
 * 缓存——文件随部署整体替换，进程生命周期内不会变。
 */
export function buildInfo(): BuildInfo | null {
  if (cached !== undefined) return cached;
  try {
    const raw = readFileSync(path.join(process.cwd(), "BUILD_INFO.json"), "utf8");
    const parsed = buildInfoSchema.safeParse(JSON.parse(raw));
    cached = parsed.success ? parsed.data : null;
  } catch {
    cached = null;
  }
  return cached;
}
