"use client";

import { useEffect, useState } from "react";
import { WovenCloth } from "@/shaders/woven-cloth/WovenCloth";

type ExhibitState = "idle" | "busy" | "done" | "failed";
type Phase = "off" | "on" | "flip" | "fade";

/** busy 之后先让百分比 / 阶段行落位，再把布铺上来；也避开 iframe 首帧编译与任务提交抢资源 */
const MOUNT_DELAY_MS = 1200;

/**
 * 展览区的「丝绸幕布」：任务进行中（busy）铺满黑框；出片（done）时整块布翻转露出成片后卸载；
 * 失败 / 关闭则淡出。下一次进入 busy 再重新挂载。iframe 内 three.js 场景每次挂载都从头织，
 * 所以 off 时必须真正卸载而不是隐藏。
 */
export function ClothVeil({ state }: { state: ExhibitState }) {
  const [phase, setPhase] = useState<Phase>(state === "busy" ? "on" : "off");
  const [seen, setSeen] = useState(state);
  const [woven, setWoven] = useState(false);

  // 状态切换在渲染期派生（React 允许对自身 state 这样做），避免 effect 里 setState 级联
  if (state !== seen) {
    setSeen(state);
    if (state === "busy") {
      setPhase("on");
      setWoven(false);
    } else if (seen === "busy") {
      const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      // 布还没铺上就结束了：直接收起，不做翻转
      setPhase(reduce || !woven ? "off" : state === "done" ? "flip" : "fade");
    }
  }

  // 延迟挂载 iframe；离开 on 之后（翻转 / 淡出期间）保持已织状态，下次进入 busy 时在上面重置
  useEffect(() => {
    if (phase !== "on") return;
    const t = window.setTimeout(() => setWoven(true), MOUNT_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  // 兜底：动画事件没送达（标签被隐藏、面板节流）时，按动画最长时长收尾
  useEffect(() => {
    if (phase !== "flip" && phase !== "fade") return;
    const t = window.setTimeout(() => setPhase("off"), 1600);
    return () => window.clearTimeout(t);
  }, [phase]);

  if (phase === "off" || !woven) return null;
  return (
    <div className="exhibit__veil" data-phase={phase} aria-hidden onAnimationEnd={() => (phase === "flip" || phase === "fade") && setPhase("off")}>
      <div className="exhibit__veil-cloth">
        <WovenCloth variant="iridescent" hue={0} saturation={1.0} brightness={1.0} />
      </div>
    </div>
  );
}
