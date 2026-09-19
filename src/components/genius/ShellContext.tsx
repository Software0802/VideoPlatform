"use client";

import { useMemo, type ReactNode } from "react";
import { SessionProvider, useSession, type SessionShell } from "./shell/SessionProvider";
import { NoticesProvider, useNotices, type NoticesShell } from "./shell/NoticesProvider";
import { JobsProvider, useJobs, type JobsShell } from "./shell/JobsProvider";
import { ComposerProvider, useComposer, type ComposerShell } from "./shell/ComposerProvider";
import type { ShellCaps } from "./shell/shared";

/*
  Genius App 的客户端状态所有者（方案 `docs/plan-ui-genius-app.md` §3）。
  主页与创作页共用同一个创作面板实例，所以面板状态必须挂在壳上而不是某个视图里；
  组件只经 `@/lib/client/*` 访问 `/api/*`，这里是它们唯一的调用处（AGENTS.md）。

  R5.2 起拆成四个域 Provider（`./shell/`），嵌套顺序 Session → Notices → Jobs →
  Composer：下层域经 `useSession()` / `useNotices()` / `useJobs()` 读上层，跨域
  读取只许往下不许往上。`useShell()` 是聚合兼容层，返回四域的并集（每个域的
  value 各自 useMemo，某一域的状态变化不再拖着重渲另外三域的消费者）。
*/

/* ── 常量 / 类型 / 域 hook 全部从本文件 re-export，外部 import 路径不变 ── */

export {
  COMPOSER_TABS,
  VIDEO_MODES,
  VIDEO_MODE_KEY,
  RES_LABEL,
  IMAGE_RES_LABEL,
  COUNTS,
  MAX_COUNT,
  JOBS_PAGE,
  MAX_NOTICES,
  creditsOf,
  kindOfJob,
} from "./shell/shared";
export type {
  ComposerTab,
  VideoMode,
  Frame,
  SlotTarget,
  Pop,
  Notice,
  ShellCaps,
} from "./shell/shared";
export { useSession } from "./shell/SessionProvider";
export { useNotices, isLongToast } from "./shell/NoticesProvider";
export { useJobs } from "./shell/JobsProvider";
export { useComposer } from "./shell/ComposerProvider";
export type { ToastItem } from "./shell/NoticesProvider";
export type { SessionShell, NoticesShell, JobsShell, ComposerShell };

type Shell = SessionShell & NoticesShell & JobsShell & ComposerShell;

export function ShellProvider({ caps, children }: { caps: ShellCaps; children: ReactNode }) {
  return (
    <SessionProvider caps={caps}>
      <NoticesProvider>
        <JobsProvider>
          <ComposerProvider>{children}</ComposerProvider>
        </JobsProvider>
      </NoticesProvider>
    </SessionProvider>
  );
}

/** 聚合兼容层：需要跨域字段的组件仍可用它；新代码优先取所需最窄的域 hook。 */
export function useShell(): Shell {
  const s = useSession();
  const n = useNotices();
  const j = useJobs();
  const c = useComposer();
  return useMemo(() => ({ ...s, ...n, ...j, ...c }), [s, n, j, c]);
}
