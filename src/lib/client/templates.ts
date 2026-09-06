import type { AspectRatio, NativeMode } from "@/lib/providers/types";
import { parseAuthed } from "@/lib/client/http";

/**
 * `GET /api/templates`（阶段 B 契约）：管理员维护的预置提示词 + 参数，主页「模板」页签的
 * 内容源，点一张卡就把它回填进创作面板。
 *
 * 形状的事实源在服务端，这份类型是它的**镜像**——与 `models.ts` 同一个口径：每个字段过
 * 一遍白名单校验，服务端多发的丢掉、少发或发错的整条剔除。模板是「点了就会按这套参数
 * 提交」的东西，认不出的 mode / 画幅原样带上去只会换来一次 400。
 */

export type Template = {
  id: string;
  name: string;
  category: string;
  prompt: string;
  mode: NativeMode;
  durationSec?: number;
  aspectRatio?: AspectRatio;
  /** 封面图地址（`/api/media/...` 或静态资源）；没有时卡片显示纯色底。 */
  cover?: string;
};

const NATIVE_MODES: readonly NativeMode[] = [
  "text_to_image",
  "text_to_video",
  "image_to_video",
  "reference_to_video",
  "edit_video",
  "extend_video",
];
const RATIOS: readonly AspectRatio[] = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];

function readTemplate(raw: unknown): Template | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const id = str(t.id);
  const name = str(t.name);
  const prompt = str(t.prompt);
  const mode = NATIVE_MODES.find((m) => m === t.mode);
  // 没有 id / 名字 / 提示词的模板点了也没用；mode 认不出就不知道该填进哪个页签
  if (!id || !name || !prompt || !mode) return null;
  const durationSec =
    typeof t.durationSec === "number" && Number.isFinite(t.durationSec) && t.durationSec > 0
      ? t.durationSec
      : undefined;
  return {
    id,
    name,
    category: str(t.category) || "全部",
    prompt,
    mode,
    durationSec,
    aspectRatio: RATIOS.find((r) => r === t.aspectRatio),
    cover: str(t.cover) || undefined,
  };
}

/** 拉失败时抛，由调用方决定回落（模板页签会显示一行「暂时读不到模板」而不是空白）。 */
export async function fetchTemplates(): Promise<Template[]> {
  const res = await fetch("/api/templates", { cache: "no-store" });
  const data = await parseAuthed<unknown>(res, "无法读取模板");
  // 契约是裸数组；顺手也收 `{ templates: [...] }`，免得服务端换成信封时前端整页空掉
  const raw = Array.isArray(data)
    ? data
    : Array.isArray((data as { templates?: unknown } | null)?.templates)
      ? ((data as { templates: unknown[] }).templates)
      : [];
  return raw.map(readTemplate).filter((t): t is Template => t !== null);
}
