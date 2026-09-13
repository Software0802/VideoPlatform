import type { MessageKey } from "@/lib/i18n/messages";

/**
 * 五个视图的 id 与顶栏标题；`GeniusShell` 用 `usePathname()` 推导，侧栏与顶栏共用。
 * 标题存的是**键名**而不是文案：渲染方 `t(VIEW_TITLE[view])` 才拿到当前语言的字符串。
 */
export type ShellView = "home" | "create" | "agent" | "canvas" | "sub" | "account" | "admin";

export const VIEW_TITLE: Record<ShellView, MessageKey> = {
  home: "shell.nav.home",
  create: "shell.nav.create",
  agent: "shell.nav.agent",
  canvas: "shell.nav.canvas",
  sub: "shell.nav.sub",
  account: "shell.nav.account",
  admin: "shell.nav.admin",
};

export function viewOfPath(pathname: string): ShellView {
  if (pathname.startsWith("/create")) return "create";
  if (pathname.startsWith("/agent")) return "agent";
  if (pathname.startsWith("/canvas")) return "canvas";
  if (pathname.startsWith("/subscription")) return "sub";
  // H3：账户页不进侧栏（仍是五视图），只借 `data-view` 与顶栏标题。
  if (pathname.startsWith("/account")) return "account";
  // N3.5：中转管理页同理——管理员专属，入口在头像菜单，侧栏保持五项。
  if (pathname.startsWith("/admin")) return "admin";
  return "home";
}
