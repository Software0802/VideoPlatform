"use client";

import { useEffect } from "react";
import { WarpFieldBackground } from "@/shaders/warp-field/WarpFieldBackground";
import "@/shaders/threeui.css";

const HOLD_MS = 3200;

export function LoadingScreen({ onEnter }: { onEnter: () => void }) {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      onEnter();
      return;
    }
    const timer = window.setTimeout(onEnter, HOLD_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Escape") onEnter();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onEnter]);

  return (
    <div
      className="fixed inset-0 z-50 bg-[#02040a]"
      role="dialog"
      aria-label="流光加载"
      onClick={onEnter}
    >
      <div className="shader-frame">
        <WarpFieldBackground
          variant="letters"
          speed={15.0}
          streakOpacity={0.6}
          tileOpacity={0.9}
          fov={75}
          hue={0}
          saturation={1}
          brightness={1}
        />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-14 flex flex-col items-center gap-3 text-center">
        <p className="text-[11px] tracking-[0.55em] text-[#a7f3d0]/85">流光 · LUMEN</p>
        <p className="text-xs text-white/45">点击任意处进入工作室</p>
      </div>
    </div>
  );
}
