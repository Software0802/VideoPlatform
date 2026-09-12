import { parseAuthed } from "@/lib/client/http";
import type { NotificationItem } from "@/lib/notifications/store";

/**
 * `GET /api/notifications` / `POST /api/notifications/read` 的浏览器封装（H1）。
 *
 * 形状与两条路由的响应一致：`epoch`（存储代际，标已读时原样带回）、`items`
 * （全量、按 seq 倒序）、`lastReadSeq`、`unread`（服务端算好的未读数）。
 * 标已读带旧 epoch 会 409 `notifications_stale`——调用方重拉 `fetchNotifications`
 * 而不是重试 POST。
 */
export type { NotificationItem };

export type NotificationsState = {
  epoch: string;
  items: NotificationItem[];
  lastReadSeq: number;
  unread: number;
};

export async function fetchNotifications(): Promise<NotificationsState> {
  const res = await fetch("/api/notifications", { cache: "no-store" });
  return parseAuthed<NotificationsState>(res, "无法读取通知");
}

/** 「打开铃铛 = 全部已读」：`upToSeq` 传本地见过的最大 `seq`。 */
export async function markNotificationsRead(
  epoch: string,
  upToSeq: number,
): Promise<NotificationsState> {
  const res = await fetch("/api/notifications/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ epoch, upToSeq }),
  });
  return parseAuthed<NotificationsState>(res, "标已读失败");
}
