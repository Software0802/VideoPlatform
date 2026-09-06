"use client";

import { useMemo, type CSSProperties } from "react";

import iridescentSource from "./woven-cloth-iridescent.html";

/*
 * ThreeUI <WovenCloth /> —— 按注册源码 src/shaders/woven-cloth/WovenCloth.tsx
 * （SHA-256 5a89ff03…0550）移植。本项目只落地 `iridescent` 变体：
 *   - `woven-cloth`（Neuform 隔离宿主）依赖 6 份未随包分发的 Neuform 源文档，无法编译，未移植；
 *   - `atelier` / `washi` 未被使用，未随包落盘。
 * `CompanionCloth` 的实现（iframe + srcDoc + sandbox + hue/saturation/brightness 滤镜）保持原样。
 * `?raw` 在 Turbopack 里换成 next.config.ts 的 `*.html` → raw-loader 规则。
 */

export const WOVEN_CLOTH_VARIANTS = ["iridescent"] as const;
export type WovenClothVariant = (typeof WOVEN_CLOTH_VARIANTS)[number];

export type NeuformCraftEffectProps = {
  mode?: "dark" | "light";
  hue?: number;
  saturation?: number;
  brightness?: number;
  className?: string;
  style?: CSSProperties;
};

export const NEUFORM_CRAFT_DEFAULTS = {
  hue: 0,
  saturation: 1,
  brightness: 1,
} as const;

export type WovenClothProps = NeuformCraftEffectProps & {
  variant?: WovenClothVariant;
};

type CompanionDefinition = {
  title: string;
  background: string;
  source: string;
};

const COMPANIONS: Record<WovenClothVariant, CompanionDefinition> = {
  iridescent: {
    title: "Woven Cloth iridescent silk",
    background: "#05060d",
    source: iridescentSource,
  },
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function CompanionCloth({
  definition,
  hue = NEUFORM_CRAFT_DEFAULTS.hue,
  saturation = NEUFORM_CRAFT_DEFAULTS.saturation,
  brightness = NEUFORM_CRAFT_DEFAULTS.brightness,
  className,
  style,
}: NeuformCraftEffectProps & { definition: CompanionDefinition }) {
  const safeHue = clamp(hue, -180, 180);
  const safeSaturation = clamp(saturation, 0, 2);
  const safeBrightness = clamp(brightness, 0.35, 1.65);
  const filter = safeHue === 0 && safeSaturation === 1 && safeBrightness === 1
    ? undefined
    : `hue-rotate(${safeHue}deg) saturate(${safeSaturation}) brightness(${safeBrightness})`;

  return (
    <iframe
      className={className}
      title={definition.title}
      srcDoc={definition.source}
      sandbox="allow-scripts"
      loading="eager"
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        border: 0,
        background: definition.background,
        filter,
        ...style,
      }}
    />
  );
}

export function WovenCloth({ variant = "iridescent", ...props }: WovenClothProps) {
  const definition = useMemo(() => COMPANIONS[variant] ?? COMPANIONS.iridescent, [variant]);
  return <CompanionCloth {...props} key={variant} definition={definition} />;
}
