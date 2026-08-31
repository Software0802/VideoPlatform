import { MODEL_IMAGE } from "@/lib/providers/grok/mode-matrix";
import { grokNativeProvider } from "@/lib/providers/grok/native";
import type {
  ProviderGenerateRequest,
  ProviderHandle,
  VideoProvider,
} from "@/lib/providers/types";
import type { IdentityBible } from "./types";

export type IdentitySheetInput = {
  jobId: string;
  bible: IdentityBible;
  characterId: string;
  language?: "zh" | "en";
};

export type IdentitySheetResult = {
  characterId: string;
  characterIndex: number;
  requestJobId: string;
  prompt: string;
  handle: ProviderHandle;
};

export function buildIdentitySheetPrompt(input: IdentitySheetInput): string {
  const { character } = locateCharacter(input);
  const language = input.language ?? "zh";
  const characterTraits = character.lockedTraits.join("；");
  const palette = input.bible.style.palette.join("、");
  const doNotChange = input.bible.style.doNotChange.join("；");
  if (language === "en") {
    return [
      "Create a clean cinematic character reference sheet for Lumen continuity control.",
      `Character: ${character.name} (id: ${character.id})`,
      `Locked traits: ${characterTraits}`,
      `Palette: ${palette}`,
      `Lighting: ${input.bible.style.lighting}`,
      `Lens language: ${input.bible.style.lens}`,
      `Era: ${input.bible.style.era}`,
      `Never change: ${doNotChange}`,
      "Show front, three-quarter, and profile views with consistent facial identity, wardrobe, and proportions.",
      "Neutral uncluttered background; no text, logos, watermark, or extra characters.",
    ].join("\n");
  }
  return [
    "生成用于 Lumen 一致性控制的电影感角色设定表。",
    `角色：${character.name}（id：${character.id}）`,
    `锁定特征：${characterTraits}`,
    `色板：${palette}`,
    `光线：${input.bible.style.lighting}`,
    `镜头语言：${input.bible.style.lens}`,
    `时代：${input.bible.style.era}`,
    `绝对不能改变：${doNotChange}`,
    "展示正面、四分之三侧面和侧面视图，保持脸部身份、服装和身体比例一致。",
    "背景干净克制；不要出现文字、标志、水印或其他角色。",
  ].join("\n");
}

export async function requestIdentitySheet(
  input: IdentitySheetInput,
  provider: VideoProvider = grokNativeProvider,
): Promise<IdentitySheetResult> {
  const { character, index } = locateCharacter(input);
  if (input.language !== undefined && input.language !== "zh" && input.language !== "en") {
    throw new Error("语言无效");
  }
  if (!provider.capabilities().modes.includes("text_to_image")) {
    throw new Error("provider 不支持角色表生成");
  }
  const prompt = buildIdentitySheetPrompt(input);
  const requestJobId = `${input.jobId}-sheet-${index}`;
  const request: ProviderGenerateRequest = {
    jobId: requestJobId,
    mode: "text_to_image",
    prompt,
    model: MODEL_IMAGE,
    aspectRatio: "1:1",
    imageResolution: "1k",
    generateAudio: false,
  };
  const handle = await provider.submit(request);
  if (handle.respectModeration === false) {
    throw new Error("角色表未通过安全审核");
  }
  return {
    characterId: character.id,
    characterIndex: index,
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
