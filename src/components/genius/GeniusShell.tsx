"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/genius/Sidebar";
import { TopBar } from "@/components/genius/TopBar";
import { ShellProvider, useShell, type ShellCaps } from "@/components/genius/ShellContext";
import { Dock } from "@/components/genius/composer/Dock";
import { viewOfPath } from "@/components/genius/views";

/*
  壳（交接包 §0）：左侧 212px 固定导航 + 右侧内容区（56px 顶栏 + 滚动主体）。
  创作面板 / 素材弹窗是 `main` 的**兄弟**，绝不放进滚动容器（`Dock`）。
  `.shell[data-ready="true"]` 只由客户端 effect 写入，e2e 用它判断已水合（方案 §7）。
*/

export function GeniusShell({ caps, children }: { caps: ShellCaps; children: React.ReactNode }) {
  return (
    <ShellProvider caps={caps}>
      <Frame>{children}</Frame>
    </ShellProvider>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const view = viewOfPath(pathname ?? "/");
  const { toast } = useShell();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setReady(true), 0);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="shell" data-ready={ready} data-view={view}>
      <Sidebar view={view} />
      {/* 画布视图自己管滚动（作者坐标 + 缩放），`main` 改 overflow:hidden */}
      <div className="col" data-view={view}>
        <TopBar view={view} />
        <main className="main">{children}</main>
        <Dock view={view} />
        {toast ? (
          <p className="toast" role="status">
            {toast}
          </p>
        ) : null}
      </div>
    </div>
  );
}
