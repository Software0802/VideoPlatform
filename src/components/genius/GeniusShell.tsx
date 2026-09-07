"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/genius/Sidebar";
import { TopBar } from "@/components/genius/TopBar";
import { ShellProvider, useShell, type ShellCaps } from "@/components/genius/ShellContext";
import { Dock } from "@/components/genius/composer/Dock";
import { useT } from "@/components/genius/i18n/I18nProvider";
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
  const { toast, noticeToast, openNotice, dismissNoticeToast, open } = useShell();
  const t = useT();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setReady(true), 0);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="shell" data-ready={ready} data-view={view}>
      <Sidebar view={view} />
      {/*
        画布视图自己管滚动（作者坐标 + 缩放），`main` 改 overflow:hidden。
        `data-composer` 报的是悬浮层此刻有多高（收起态输入条 60px / 展开的面板约 200px），
        主页据此给自己留出落底空间——不留的话最后一行卡片与「加载更多」压在面板下面点不到
        （e2e「主页分页」用例就是这么撞出来的：`.bar` 拦住了按钮的点击）。
        留 padding 的是**视图**不是壳，交接包 §9.1「内容区不预留」说的是后者。
      */}
      <div className="col" data-view={view} data-composer={open ? "open" : "bar"}>
        <TopBar view={view} />
        <main className="main">{children}</main>
        <Dock view={view} />
        {toast ? (
          <p className="toast" role="status">
            {toast}
          </p>
        ) : null}
        {/*
          任务完成通知（阶段 B）：右上角，成功那条可点跳创作页。与 `.toast`（「即将上线」
          那类一次性提示）分开——这条带的是要读、可能要点的信息，所以不是 pointer-events:none。
        */}
        {noticeToast ? (
          <div className="notice-toast" role="status" data-ok={noticeToast.ok} data-job-id={noticeToast.jobId}>
            <button type="button" className="notice-toast__hit" onClick={() => openNotice(noticeToast)}>
              <span className="notice-toast__title">{noticeToast.title}</span>
              <span className="notice-toast__detail">{noticeToast.detail}</span>
            </button>
            <button
              type="button"
              className="notice-toast__x"
              aria-label={t("shell.notify.dismiss")}
              onClick={dismissNoticeToast}
            >
              ✕
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
