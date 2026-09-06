import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "@/lib/env";
import { aspectRatioSchema, nativeModeSchema } from "@/lib/jobs/schema";
import { log } from "@/lib/log";

/**
 * 模板 = 预置提示词 + 参数（方案 §1.4「模板 tab」）。
 *
 * 存成 `data/templates/*.json` 一个文件一条，管理员用编辑器就能改，不需要发版、也不
 * 需要一张管理后台。`data/` 不入库，所以仓库里带一份示例在 `data-seed/templates/`，
 * 首次部署拷过去即可。
 *
 * 读法是「每次请求对一遍文件的 mtime + 大小，没变就用缓存」：模板只有几条，`readdir`
 * 加几次 `stat` 比解析 JSON 便宜得多，而管理员改完文件不该等进程重启才生效。只对目录
 * 的 mtime 是不够的——改一个已存在文件的内容不会动目录时间戳。
 */

const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 相对 `public/` 的绝对路径，如 `/templates/ad.webp`。 */
const COVER_RE = /^\/[A-Za-z0-9_\-/.]+\.(png|jpg|jpeg|webp|avif|svg)$/i;

export const templateSchema = z
  .object({
    id: z.string().regex(TEMPLATE_ID_RE),
    name: z.string().min(1).max(40),
    /** 与主页分类芯片同一套词表（`@/lib/jobs/tags` 的 `PRESET_TAGS`），但不强制。 */
    category: z.string().min(1).max(16),
    prompt: z.string().min(1).max(2000),
    mode: nativeModeSchema,
    durationSec: z.number().int().min(1).max(60).optional(),
    aspectRatio: aspectRatioSchema.optional(),
    cover: z
      .string()
      .regex(COVER_RE)
      // 正则已经排除了 `..`（点只出现在扩展名前，且不能连续成 `../`），这条是显式的
      // 第二道：封面是要被浏览器直接请求的路径，写错方向就是一个目录穿越。
      .refine((value) => !value.includes(".."), { message: "封面路径不能包含 .." })
      .optional(),
  })
  .strict();

export type Template = z.infer<typeof templateSchema>;

export function templatesDir(): string {
  return path.join(dataDir(), "templates");
}

type Cache = { signature: string; templates: Template[] };

type CacheState = typeof globalThis & { __lumenTemplateCache?: Cache };
const cacheState = globalThis as CacheState;

/** 仅测试用：强制下一次读盘。 */
export function resetTemplateCache(): void {
  delete cacheState.__lumenTemplateCache;
}

/**
 * 目录里全部模板，按文件名排序——顺序是管理员用文件名（`01-…`）控制的，比按 id 排更
 * 符合「这是一份手工维护的清单」。
 *
 * 单个坏文件（手改坏的 JSON、字段不合法）只记一条 warn 并跳过：一条模板不该让整个
 * 模板页空掉。目录不存在 = 没有模板，不是错误。
 */
export async function listTemplates(): Promise<Template[]> {
  const dir = templatesDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }

  const parts: string[] = [];
  for (const name of files) {
    try {
      const info = await stat(path.join(dir, name));
      parts.push(`${name}:${Math.floor(info.mtimeMs)}:${info.size}`);
    } catch {
      // 刚被删掉的文件：不进签名，下面读的时候也会被跳过。
    }
  }
  const signature = parts.join("|");
  const cached = cacheState.__lumenTemplateCache;
  if (cached && cached.signature === signature) return cached.templates;

  const templates: Template[] = [];
  const seen = new Set<string>();
  for (const name of files) {
    let parsed: Template;
    try {
      parsed = templateSchema.parse(JSON.parse(await readFile(path.join(dir, name), "utf8")));
    } catch (error) {
      log("warn", "模板文件不可用，已跳过", {
        detail: `${name}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    // id 是给前端做 key 与埋点的，重复了就说明有人复制文件忘了改 id。留先出现的那条。
    if (seen.has(parsed.id)) {
      log("warn", "模板 id 重复，已跳过后一条", { detail: `${name}: ${parsed.id}` });
      continue;
    }
    seen.add(parsed.id);
    templates.push(parsed);
  }
  cacheState.__lumenTemplateCache = { signature, templates };
  return templates;
}
