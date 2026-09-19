"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { JobPublic } from "@/lib/jobs/schema";
import {
  fetchNotifications,
  markNotificationsRead,
  type NotificationItem,
  type NotificationsState,
} from "@/lib/client/notifications";
import { ApiError } from "@/lib/client/jobs";
import { useT } from "@/components/genius/i18n/I18nProvider";
import { errorText } from "@/lib/i18n/errorText";
import { hasMessage } from "@/lib/i18n/messages";
import { creditsOf, kindOfJob, type Notice } from "./shared";
import { useSessionBridge } from "./SessionProvider";

/*
  通知域：铃铛列表 / 未读数 / 右上角 noticeToast，外加通用 `toast`（一次操作的回执或
  它此刻办不到的理由——同属瞬态通知，且 `markNoticesRead` 的失败提示也要走它，所以
  归在本域供三个下层域调用）。

  真相是 `data/notifications/<userId>.json`（刷新 / 换设备后仍在）；SSE 只是提醒。
  `syncNotifications` 在四个时机把服务端的全量拉下来整体覆盖本地：挂载、SSE 每次
  open（含重连——断线期间漏掉的终态靠它补齐）、页面回到前台、本地观察到
  「非终态 → 终态」那一跳之后。
*/

/**
 * 轻提示的时长与条数（review 2026-09-15 C-13）。
 *
 * 2.2 秒够看完一行的那种（「已把…放进画布」「已切到视频页」这类做完一件事的回执）；拼了
 * 产品名、带请求号的错误，或 `modeBlock()` / `templateReason` 那种整句的置灰理由，一行放
 * 不下，2.2 秒不够看完，所以超过一行（约 30 个字符）的给 6 秒并额外给一个关闭按钮——手动
 * 撤下是唯一能让人「读完再走」的办法。同屏最多 3 条，再多就挤掉最老的一条。
 */
const MAX_TOASTS = 3;
const TOAST_MS = 2200;
const TOAST_LONG_MS = 6000;
const TOAST_LONG_CHARS = 30;

/** 一行放不下的提示 = 需要读 = 给更久、给关闭按钮。判据与 `.toast` 的 max-width 对应。 */
export function isLongToast(text: string): boolean {
  return text.length > TOAST_LONG_CHARS;
}

/** 轻提示的一条。`id` 只用来定位要撤下的那条，不落盘、不跨会话。 */
export type ToastItem = { id: number; text: string };

export type NoticesShell = {
  notices: Notice[];
  unread: number;
  markNoticesRead: () => void;
  /** 右上角那一条（自动消失）；同时也在通知列表里 */
  noticeToast: Notice | null;
  dismissNoticeToast: () => void;
  /**
   * 置灰项与一次性结果的轻提示，最多同时 3 条、后来的排在下面（review 2026-09-15 C-13）。
   * 原来是单槽位：连点两个置灰控件、或「已复制」紧跟着一条错误，先来的那条会被直接顶掉。
   */
  toasts: ToastItem[];
  showToast: (message: string) => void;
  dismissToast: (id: number) => void;
  /**
   * 铃铛面板开着时别再弹 `noticeToast`：它画在面板上面（z-index 45 vs 30，几何也压着），
   * 而面板里本来就列着同一条。由 TopBar 上报开合。
   */
  setNoticePanelOpen: (open: boolean) => void;
};

/**
 * 给下层域（Jobs / Composer）的内部接口：SSE 事件与「本会话新建任务」都要经这里
 * 记入状态迁移表 / 即时插入通知。useNotices() 的公开面不含这些。
 */
export type NoticesBridge = NoticesShell & {
  /** 刚建出来的任务先记一笔「非终态」（原 `remember`）。 */
  noteJob: (job: JobPublic) => void;
  /** 记录并返回该任务此前的状态（SSE 每一跳都走它）。 */
  observeJobStatus: (job: JobPublic) => JobPublic["status"] | undefined;
  /** 「非终态 → 终态」的即时通知 + 落盘对齐。`quiet` 由 Jobs 域算（/create 正看着该任务）。 */
  emitJobTerminal: (job: JobPublic, quiet: boolean) => void;
  /** 立即拉一轮落盘通知（SSE open / 重连时用）。 */
  syncNotices: () => void;
};

const Ctx = createContext<NoticesBridge | null>(null);

export function useNotices(): NoticesShell {
  const value = useContext(Ctx);
  if (!value) throw new Error("useNotices 必须在 NoticesProvider 内使用");
  return value;
}

/** 仅供下层壳域调用（JobsProvider / ComposerProvider），视图组件请用 `useNotices()`。 */
export function useNoticesBridge(): NoticesBridge {
  const value = useContext(Ctx);
  if (!value) throw new Error("useNoticesBridge 必须在 NoticesProvider 内使用");
  return value;
}

export function NoticesProvider({ children }: { children: ReactNode }) {
  const { caps } = useSessionBridge();
  const t = useT();
  const pathname = usePathname();

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [noticeToast, setNoticeToast] = useState<Notice | null>(null);

  const toastSeq = useRef(0);
  const toastTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const dismissToast = useCallback((id: number) => {
    const timer = toastTimers.current.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.current.delete(id);
    setToasts((list) => list.filter((item) => item.id !== id));
  }, []);
  const showToast = useCallback((message: string) => {
    const id = (toastSeq.current += 1);
    // 挤掉最老的一条时不动它的定时器：定时器只做一次按 id 的过滤，对已撤下的条目是空操作。
    setToasts((list) => [...list, { id, text: message }].slice(-MAX_TOASTS));
    const timer = setTimeout(() => {
      toastTimers.current.delete(id);
      setToasts((list) => list.filter((item) => item.id !== id));
    }, isLongToast(message) ? TOAST_LONG_MS : TOAST_MS);
    toastTimers.current.set(id, timer);
  }, []);
  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /** 铃铛面板开合：开着就不弹 noticeToast，并把当前这条收掉。 */
  const noticePanelOpen = useRef(false);
  const setNoticePanelOpen = useCallback((open: boolean) => {
    noticePanelOpen.current = open;
    if (open) setNoticeToast(null);
  }, []);

  const seenStatus = useRef<Map<string, JobPublic["status"]>>(
    new Map(caps.initialJobs.map((j) => [j.id, j.status])),
  );
  /**
   * 刚建出来的任务先记一笔「非终态」。不记的话，一条快到「第一条事件就是终态」的任务
   * 会被当成「本来就完成了的历史任务」而不弹通知——本会话亲手提交的那条，恰恰是最该
   * 通知的一条。
   */
  const noteJob = useCallback((job: JobPublic) => {
    if (!seenStatus.current.has(job.id)) seenStatus.current.set(job.id, job.status);
  }, []);
  const observeJobStatus = useCallback((job: JobPublic) => {
    const prev = seenStatus.current.get(job.id);
    seenStatus.current.set(job.id, job.status);
    return prev;
  }, []);

  /* H1：落盘通知的代际与游标。空 epoch = 还没同步成功过。 */
  const notifEpoch = useRef("");
  const notifMaxSeq = useRef(0);
  /** 在飞中的 sync（含退避等待）；来了新触发就置 `notifPending` 让它结束后再跑一轮。 */
  const notifSyncing = useRef(false);
  const notifPending = useRef(false);

  /** 一条落盘通知 → 面板条目。标题 / 失败原因按 kind 与 status 现渲染，不落盘。 */
  const noticeOfItem = useCallback(
    (item: NotificationItem): Notice => {
      if (item.kind === "job") {
        const ok = item.status === "succeeded";
        const title = ok
          ? t("shell.notice.done")
          : item.status === "canceled"
            ? t("shell.notice.canceled")
            : t("shell.notice.failed");
        const errKey = item.errorCode ? `common.err.${item.errorCode}` : "";
        const detail = ok
          ? item.prompt ||
            (item.mode === "text_to_image" ? t("create.mode.text_to_image") : t("create.firstFrame"))
          : errKey && hasMessage(errKey)
            ? t(errKey)
            : (item.errorMessage ?? t("shell.notice.unknownReason"));
        return {
          id: item.id,
          kind: "job",
          jobId: item.jobId,
          status: item.status,
          ok,
          title,
          detail,
          at: item.at,
        };
      }
      if (item.kind === "run") {
        const title =
          item.status === "succeeded"
            ? t("shell.notice.run.succeeded")
            : item.status === "partially_failed"
              ? t("shell.notice.run.partially_failed")
              : item.status === "failed"
                ? t("shell.notice.run.failed")
                : item.status === "canceled"
                  ? t("shell.notice.run.canceled")
                  : t("shell.notice.run.awaiting_approval");
        const canvasTitle = item.canvasTitle ?? t("shell.notice.run.untitled");
        const detail =
          item.status === "awaiting_approval"
            ? t("shell.notice.run.awaitingDetail", { title: canvasTitle })
            : t("shell.notice.run.detail", {
                title: canvasTitle,
                ok: item.nodeCounts?.succeeded ?? 0,
                bad: (item.nodeCounts?.failed ?? 0) + (item.nodeCounts?.blocked ?? 0),
              });
        return {
          id: item.id,
          kind: "run",
          runId: item.runId,
          canvasId: item.canvasId,
          status: item.status,
          ok: item.status === "succeeded" || item.status === "awaiting_approval",
          title,
          detail,
          at: item.at,
        };
      }
      const title =
        item.status === "awaiting_approval"
          ? t("shell.notice.agent.awaiting_approval")
          : t("shell.notice.agent.failed");
      let detail: string;
      if (item.status === "awaiting_approval") {
        detail = t("shell.notice.agent.awaitingDetail", {
          title: item.sessionTitle,
          n: item.actionCount ?? 0,
          credits: creditsOf(item.totalCny ?? 0),
        });
      } else {
        const errKey = item.errorCode ? `common.err.${item.errorCode}` : "";
        const reason =
          errKey && hasMessage(errKey)
            ? t(errKey)
            : (item.errorMessage ?? t("shell.notice.unknownReason"));
        detail = `${reason}${t("shell.notice.agent.refunded")}`;
      }
      return {
        id: item.id,
        kind: "agent",
        sessionId: item.sessionId,
        turnId: item.turnId,
        status: item.status,
        ok: item.status === "awaiting_approval",
        title,
        detail,
        at: item.at,
      };
    },
    [t],
  );

  /** 服务端同步结果整体覆盖本地；非首拉的新 run/agent 项补一条 toast。 */
  const applyNotificationState = useCallback(
    (state: NotificationsState) => {
      const previousMax = notifMaxSeq.current;
      const latest =
        previousMax > 0
          ? state.items
              .filter((item) => item.seq > previousMax && item.kind !== "job")
              .sort((a, b) => b.seq - a.seq)[0]
          : undefined;
      notifEpoch.current = state.epoch;
      notifMaxSeq.current = state.items.reduce((m, i) => Math.max(m, i.seq), state.lastReadSeq);
      setNotices(state.items.map(noticeOfItem));
      setUnread(state.unread);
      if (latest) {
        const onTargetPage =
          (latest.kind === "run" && pathname === "/canvas") ||
          (latest.kind === "agent" && pathname === "/agent");
        if (!onTargetPage && !noticePanelOpen.current) setNoticeToast(noticeOfItem(latest));
      }
    },
    [noticeOfItem, pathname],
  );

  /**
   * 拉一次全量通知。失败按 2s → 5s → 10s 退避重试三次后放弃（下一个触发点再来）；
   * 在飞期间又来的触发只置 `notifPending`，当前这轮结束后补跑一轮——既不在
   * 两个 GET 之间乱序覆盖，也不丢掉「断线期间又完成了一条」的那次提醒。
   */
  const syncNotifications = useCallback(async () => {
    if (notifSyncing.current) {
      notifPending.current = true;
      return;
    }
    notifSyncing.current = true;
    const backoffMs = [2000, 5000, 10_000];
    try {
      do {
        notifPending.current = false;
        for (let attempt = 0; ; attempt += 1) {
          try {
            applyNotificationState(await fetchNotifications());
            break;
          } catch {
            // 401 已被 client 层送去登录页；其余失败退避重试，三次后放弃。
            if (attempt >= backoffMs.length) return;
            await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
          }
        }
      } while (notifPending.current);
    } finally {
      notifSyncing.current = false;
    }
  }, [applyNotificationState]);
  const syncNotices = useCallback(() => void syncNotifications(), [syncNotifications]);

  /* 触发点：挂载 + 页面回到前台（SSE open / 重连在 useEvents 的 onOpen 里）。 */
  useEffect(() => {
    void syncNotifications();
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncNotifications();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [syncNotifications]);

  const emitJobTerminal = useCallback(
    (job: JobPublic, quiet: boolean) => {
      const ok = job.status === "succeeded";
      const notice: Notice = {
        id: `${job.id}:${job.status}`,
        kind: "job",
        jobId: job.id,
        status: job.status,
        ok,
        title: ok
          ? t("shell.notice.done")
          : job.status === "canceled"
            ? t("shell.notice.canceled")
            : t("shell.notice.failed"),
        detail: ok
          ? job.prompt ||
            (kindOfJob(job) === "image" ? t("create.mode.text_to_image") : t("create.firstFrame"))
          : (job.error?.message ?? t("shell.notice.unknownReason")),
        at: job.updatedAt || new Date().toISOString(),
      };
      setNotices((list) => (list.some((n) => n.id === notice.id) ? list : [notice, ...list]));
      setUnread((n) => n + 1);
      if (!quiet && !noticePanelOpen.current) setNoticeToast(notice);
      // toast 等不了同步，所以上面先即时插入；紧接着拉一次落盘真相把它对齐
      // （以及补回这条 SSE 之前断线时漏掉的其它终态）。
      void syncNotifications();
    },
    [t, syncNotifications],
  );

  /* toast 自动消失（6s）：比一行回执那种长，它带的是要读的信息 */
  useEffect(() => {
    if (!noticeToast) return;
    const t = setTimeout(() => setNoticeToast(null), 6000);
    return () => clearTimeout(t);
  }, [noticeToast]);

  /**
   * 打开铃铛 = 全部已读：本地持有全量，`upToSeq` 就是手里最大的 seq。
   * 409 `notifications_stale`（epoch 换了，多半是坏文件重建）→ 重拉一轮对齐，不重试 POST。
   */
  const markNoticesRead = useCallback(() => {
    setUnread(0);
    const epoch = notifEpoch.current;
    if (!epoch) return;
    void markNotificationsRead(epoch, notifMaxSeq.current).then(
      applyNotificationState,
      (e: unknown) => {
        if (e instanceof ApiError && e.code === "notifications_stale") {
          void syncNotifications();
          return;
        }
        showToast(errorText(t, e));
      },
    );
  }, [applyNotificationState, showToast, syncNotifications, t]);
  const dismissNoticeToast = useCallback(() => setNoticeToast(null), []);

  const value = useMemo<NoticesBridge>(
    () => ({
      notices,
      unread,
      markNoticesRead,
      noticeToast,
      dismissNoticeToast,
      toasts,
      showToast,
      dismissToast,
      setNoticePanelOpen,
      noteJob,
      observeJobStatus,
      emitJobTerminal,
      syncNotices,
    }),
    [
      notices,
      unread,
      markNoticesRead,
      noticeToast,
      dismissNoticeToast,
      toasts,
      showToast,
      dismissToast,
      setNoticePanelOpen,
      noteJob,
      observeJobStatus,
      emitJobTerminal,
      syncNotices,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
