import type { MessageKey } from "@/lib/i18n/messages";

/**
 * 五个视图的 id 与顶栏标题；`GeniusShell` 用 `usePathname()` 推导，侧栏与顶栏共用。
 * 标题存的是**键名**而不是文案：渲染方 `t(VIEW_TITLE[view])` 才拿到当前语言的字符串。
 */
export type ShellView = "home" | "create" | "agent" | "canvas" | "sub" | "account";

export const VIEW_TITLE: Record<ShellView, MessageKey> = {
  home: "shell.nav.home",
  create: "shell.nav.create",
  agent: "shell.nav.agent",
  canvas: "shell.nav.canvas",
  sub: "shell.nav.sub",
  account: "shell.nav.account",
};

export function viewOfPath(pathname: string): ShellView {
  if (pathname.startsWith("/create")) return "create";
  if (pathname.startsWith("/agent")) return "agent";
  if (pathname.startsWith("/canvas")) return "canvas";
  if (pathname.startsWith("/subscription")) return "sub";
  // H3：账户页不进侧栏（仍是五视图），只借 `data-view` 与顶栏标题。
  if (pathname.startsWith("/account")) return "account";
  return "home";
}
