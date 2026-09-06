/** 五个视图的 id 与顶栏标题；`GeniusShell` 用 `usePathname()` 推导，侧栏与顶栏共用。 */
export type ShellView = "home" | "create" | "agent" | "canvas" | "sub";

export const VIEW_TITLE: Record<ShellView, string> = {
  home: "主页",
  create: "创作",
  agent: "智能体",
  canvas: "画布",
  sub: "订阅",
};

export function viewOfPath(pathname: string): ShellView {
  if (pathname.startsWith("/create")) return "create";
  if (pathname.startsWith("/agent")) return "agent";
  if (pathname.startsWith("/canvas")) return "canvas";
  if (pathname.startsWith("/subscription")) return "sub";
  return "home";
}
