import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";
import { log } from "@/lib/log";
import type { SkillLoader, SkillManifest } from "@/lib/skills/types";

/**
 * 盘上的技能：`<DATA_DIR>/skills/<id>/SKILL.md`，一目录一条。
 *
 * 与 `src/lib/templates.ts` 同一套口径：运维用编辑器就能加一条技能，不需要发版；
 * 读法是「对一遍每个文件的 mtime + 大小，没变就用缓存」；单个坏文件只记一条 warn
 * 并跳过——一条写坏的技能不该让整张技能表空掉。目录不存在 = 没有文件技能，不是错误。
 *
 * 内容是**运维资产**（与 `data/templates` 同级信任），会被拼进 system prompt；
 * 因此只做形状与体量校验，不做语义过滤。
 */

const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 一条技能的上限：正文 4000 字符、单文件 64KB、目录里最多 200 条。 */
const MAX_PROMPT_LEN = 4000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_SKILLS = 200;

export function skillsDir(): string {
  return path.join(dataDir(), "skills");
}

type Cache = { signature: string; skills: SkillManifest[] };
type CacheState = typeof globalThis & { __lumenFileSkillCache?: Cache };
const cacheState = globalThis as CacheState;

/** 仅测试用：强制下一次读盘。 */
export function resetFileSkillCache(): void {
  delete cacheState.__lumenFileSkillCache;
}

/**
 * SKILL.md 的 frontmatter：首行 `---`，到下一条 `---` 为止，`key: value` 一行一条。
 *
 * 不引 YAML 依赖——这里认得的键是固定的几个标量加一个字符串数组，用整套 YAML 解析
 * 反而要为它的引用 / 锚点 / 多行语义负责。认不出的键直接忽略。
 */
export function parseSkillMarkdown(id: string, source: string): SkillManifest | null {
  const text = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return null;

  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0 || line.trimStart().startsWith("#")) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
    if (key) fields.set(key, value);
  }

  const name = fields.get("name")?.slice(0, 40) ?? "";
  const description = fields.get("description")?.slice(0, 120) ?? "";
  const systemPrompt = text.slice(match[0].length).trim().slice(0, MAX_PROMPT_LEN);
  // 没名字或没正文的技能装进技能表也只是一张点不开的卡片。
  if (!name || !systemPrompt) return null;

  const rawKinds = (fields.get("kinds") ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((k) => k.trim())
    .filter((k): k is "image" | "video" => k === "image" || k === "video");
  const kinds = [...new Set(rawKinds)];

  const nameEn = fields.get("nameEn")?.slice(0, 40);
  const descriptionEn = fields.get("descriptionEn")?.slice(0, 120);
  return {
    id,
    name,
    description,
    version: fields.get("version")?.slice(0, 16) || "1",
    ...(nameEn ? { nameEn } : {}),
    ...(descriptionEn ? { descriptionEn } : {}),
    ...(kinds.length ? { kinds } : {}),
    systemPrompt,
  };
}

async function readAll(dir: string): Promise<SkillManifest[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && SKILL_ID_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .slice(0, MAX_SKILLS);
  } catch {
    return [];
  }

  const parts: string[] = [];
  const files: { id: string; file: string }[] = [];
  for (const id of entries) {
    const file = path.join(dir, id, "SKILL.md");
    try {
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) {
        log("warn", "skill_file_too_large", { id, size: info.size });
        continue;
      }
      parts.push(`${id}:${Math.floor(info.mtimeMs)}:${info.size}`);
      files.push({ id, file });
    } catch {
      // 目录里没有 SKILL.md：不是技能，静默跳过。
    }
  }

  const signature = parts.join("|");
  const cached = cacheState.__lumenFileSkillCache;
  if (cached && cached.signature === signature) return cached.skills;

  const skills: SkillManifest[] = [];
  for (const { id, file } of files) {
    try {
      const manifest = parseSkillMarkdown(id, await readFile(file, "utf8"));
      if (manifest) skills.push(manifest);
      else log("warn", "skill_file_invalid", { id });
    } catch (e) {
      log("warn", "skill_file_unreadable", { id, error: String(e) });
    }
  }
  cacheState.__lumenFileSkillCache = { signature, skills };
  return skills;
}

/** `<DATA_DIR>/skills` 的加载器。目录缺失时 `load()` 返回空数组。 */
export const fileSkillLoader: SkillLoader = {
  load: () => readAll(skillsDir()),
};
