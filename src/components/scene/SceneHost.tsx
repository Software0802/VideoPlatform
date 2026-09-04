"use client";

import { useEffect, useRef, type CanvasHTMLAttributes } from "react";
import type { SceneHandle } from "@/lib/scene/lumen-three";

/**
 * 把一个纯 three.js 场景（mount(canvas) => handle）挂到 <canvas> 上。
 * 只在挂载时调用一次 mount；需要重建时给它换 key。
 * WebGL 只是增强：mount 抛错时静默留白，页面其余部分照常。
 */
export function SceneHost<H extends SceneHandle>({
  mount,
  onReady,
  ...canvasProps
}: {
  mount: (canvas: HTMLCanvasElement) => H;
  onReady?: (handle: H | null) => void;
} & CanvasHTMLAttributes<HTMLCanvasElement>) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const mountRef = useRef(mount);
  const readyRef = useRef(onReady);
  useEffect(() => {
    mountRef.current = mount;
    readyRef.current = onReady;
  });

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let handle: H | null = null;
    try {
      handle = mountRef.current(el);
    } catch (error) {
      console.warn("Lumen scene disabled; leaving the paper blank", error);
    }
    readyRef.current?.(handle);
    return () => {
      readyRef.current?.(null);
      handle?.dispose();
    };
  }, []);

  return <canvas ref={canvas} {...canvasProps} />;
}
