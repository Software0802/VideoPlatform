import { z } from "zod";

/**
 * 作品标签（方案 `docs/plan-frontend-backend-adaptation.md` §1.4）。
 *
 * 标签是**用户自己**贴在作品上的分类，不参与路由、不参与计价，服务端只负责存与发；
 * 主页的分类芯片按它做前端筛选。预置清单与主页芯片同一份，但**不是白名单**——
 * 自定义标签一样收，否则「分类」就变成了一张管理员才能改的表。
 */

/** 主页分类芯片的预置清单，顺序即芯片顺序。 */
export const PRESET_TAGS = [
  "广告",
  "电影叙事",
  "风格艺术",
  "动物剧场",
  "特效",
  "数字人",
  "动漫游戏",
  "情绪特写",
  "音乐",
] as const;

export type PresetTag = (typeof PRESET_TAGS)[number];

/** 一条作品最多几个标签。 */
export const MAX_TAGS = 5;
/** 单个标签的长度上限，按**字**（码点）算——「电影叙事」是 4 字，不是 12 字节。 */
export const MAX_TAG_LENGTH = 16;

/** 码点数，而不是 `String.length`：CJK 与 emoji 在 UTF-16 里各占 1–2 个单元。 */
function tagLength(tag: string): number {
  return [...tag].length;
}

/**
 * trim + 去空 + 去重，保持首次出现的顺序。
 *
 * 只做这三件**无损**的整理：长度与数量超限是拒绝（400），不是静默截断——用户点了五个
 * 标签却只存下三个，界面上没有任何地方会告诉他，比直接报错难查得多。
 */
export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const tag = item.trim();
    if (!tag) continue;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * 请求体里的 `tags`。外层的 `.max()` 只是挡「拿这个字段当垃圾桶」的请求体，
 * 真正的上限在归一之后判——去重前的 6 个「广告」应该算 1 个。
 */
export const tagsSchema = z
  .array(z.string().max(MAX_TAG_LENGTH * 4))
  .max(MAX_TAGS * 4)
  .transform(normalizeTags)
  .refine((tags) => tags.length <= MAX_TAGS, { message: `最多 ${MAX_TAGS} 个标签` })
  .refine((tags) => tags.every((tag) => tagLength(tag) <= MAX_TAG_LENGTH), {
    message: `单个标签最多 ${MAX_TAG_LENGTH} 字`,
  });

/** `PATCH /api/jobs/:id` 的请求体：整组覆盖，空数组即清空。 */
export const updateJobTagsBodySchema = z.object({ tags: tagsSchema }).strict();

export type UpdateJobTagsBody = z.infer<typeof updateJobTagsBodySchema>;
