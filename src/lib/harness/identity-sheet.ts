import type {
  MediaRef,
  ProviderGenerateRequest,
  ProviderHandle,
  VideoProvider,
} from "@/lib/providers/types";
import type { IdentityBible } from "./types";

/**
 * 角色设定表按视图分三张（ViMax 做法：16:9 宽画布、角色居中留白），而不是一张
 * 三视合一——侧面 / 背面以正面图为参考走图生图，需要 provider 声明
 * `supportsImageReference`；不声明时由调用方（orchestrator keyframe 阶段）只留正面。
 */
export type SheetView = "front" | "side" | "back";

export const SHEET_VIEWS: readonly SheetView[] = ["front", "side", "back"];

export type IdentitySheetInput = {
  jobId: string;
  bible: IdentityBible;
  characterId: string;
  language?: "zh" | "en";
};

export type IdentitySheetResult = {
  characterId: string;
  characterIndex: number;
  view: SheetView;
  requestJobId: string;
  prompt: string;
  handle: ProviderHandle;
};

export function buildCharacterSheetPrompt(input: IdentitySheetInput, view: SheetView): string {
  const { character } = locateCharacter(input);
  const language = input.language ?? "zh";
  const characterTraits = character.lockedTraits.join("；");
  const palette = input.bible.style.palette.join("、");
  const doNotChange = input.bible.style.doNotChange.join("；");
  if (language === "en") {
    if (view === "front") {
      return [
        `Generate a full-body front-view turnaround of "${character.name}" on a pure white background, wide 16:9 landscape canvas, character centered with horizontal empty space on both sides. Facing forward, arms relaxed at sides, natural expression.`,
        `Locked traits: ${characterTraits}`,
        `Palette: ${palette}`,
        `Lighting: ${input.bible.style.lighting}`,
        `Era: ${input.bible.style.era}`,
        `Never change: ${doNotChange}`,
        "No text, logos, watermark, or extra characters.",
      ].join("\n");
    }
    if (view === "side") {
      return [
        `Using the provided front-view turnaround as reference, generate a full-body side-view turnaround of the same character "${character.name}" (facing left) on a pure white background, wide 16:9 landscape canvas, character centered. Arms relaxed at sides. Wardrobe, hairstyle, build, and colors must match the front view exactly.`,
        "No text, logos, watermark, or extra characters.",
      ].join("\n");
    }
    return [
      `Using the provided front-view turnaround as reference, generate a full-body back-view turnaround of the same character "${character.name}" on a pure white background, wide 16:9 landscape canvas, character centered. No facial features visible. Wardrobe, hairstyle, build, and colors must match the front view exactly.`,
      "No text, logos, watermark, or extra characters.",
    ].join("\n");
  }
  if (view === "front") {
    return [
      `生成角色「${character.name}」的全身正面立绘，纯白背景，16:9 横向宽画布，角色居中、两侧留足空白。正视前方，双手自然下垂，表情自然。`,
      `锁定特征：${characterTraits}`,
      `色板：${palette}`,
      `光线：${input.bible.style.lighting}`,
      `时代：${input.bible.style.era}`,
      `绝对不能改变：${doNotChange}`,
      "不要文字、标志、水印或其他角色。",
    ].join("\n");
  }
  if (view === "side") {
    return [
      `以提供的正面立绘为准，生成同一角色「${character.name}」的全身侧面立绘（面向左），纯白背景，16:9 横向宽画布，角色居中。双手自然下垂。服装、发型、体型、配色与正面图完全一致。`,
      "不要文字、标志、水印或其他角色。",
    ].join("\n");
  }
  return [
    `以提供的正面立绘为准，生成同一角色「${character.name}」的全身背面立绘，纯白背景，16:9 横向宽画布，角色居中。不露出面部。服装、发型、体型、配色与正面图完全一致。`,
    "不要文字、标志、水印或其他角色。",
  ].join("\n");
}

export async function requestIdentitySheet(
  input: IdentitySheetInput,
  provider: VideoProvider,
  model: string,
  view: SheetView = "front",
  frontReference?: MediaRef,
): Promise<IdentitySheetResult> {
  const { character, index } = locateCharacter(input);
  if (input.language !== undefined && input.language !== "zh" && input.language !== "en") {
    throw new Error("语言无效");
  }
  const caps = provider.capabilities();
  if (!caps.modes.includes("text_to_image")) {
    throw new Error("provider 不支持角色表生成");
  }
  const referenceImages = view === "front" ? [] : frontReference ? [frontReference] : [];
  if (view !== "front") {
    if (!frontReference) throw new Error("侧面/背面视图缺少正面参考图");
    if (!caps.supportsImageReference) throw new Error("provider 不支持图生图角色表视图");
  }
  const prompt = buildCharacterSheetPrompt(input, view);
  const requestJobId = `${input.jobId}-sheet-${index}-${view}`;
  const request: ProviderGenerateRequest = {
    jobId: requestJobId,
    mode: "text_to_image",
    prompt,
    model,
    aspectRatio: "16:9",
    imageResolution: "1k",
    generateAudio: false,
    ...(referenceImages.length ? { referenceImages } : {}),
  };
  const handle = await provider.submit(request);
  if (handle.respectModeration === false) {
    throw new Error("角色表未通过安全审核");
  }
  return {
    characterId: character.id,
    characterIndex: index,
    view,
    requestJobId,
    prompt,
    handle,
  };
}

function locateCharacter(input: IdentitySheetInput) {
  if (!input.jobId.trim() || !input.characterId.trim()) throw new Error("角色表输入无效");
  const index = input.bible.characters.findIndex(({ id }) => id === input.characterId);
  const character = input.bible.characters[index];
  if (!character) throw new Error("角色不存在");
  return { character, index };
}
