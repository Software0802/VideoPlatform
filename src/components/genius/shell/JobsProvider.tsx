"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { JobPublic } from "@/lib/jobs/schema";
import {
  cancelJob,
  deleteJob,
  fetchJob,
  fetchJobsPage,
  patchJobTags,
  reconcileJob,
  retryJob,
  type JobKind,
} from "@/lib/client/jobs";
import { useEvents } from "@/lib/client/useEvents";
import { useJobLive } from "@/lib/client/useJobLive";
import { isActive, isTerminal } from "@/lib/client/labels";
import { useT } from "@/components/genius/i18n/I18nProvider";
import { errorText } from "@/lib/i18n/errorText";
import { JOBS_PAGE, kindOfJob, type Notice } from "./shared";
import { useSessionBridge } from "./SessionProvider";
import { useNoticesBridge } from "./NoticesProvider";

/*
  任务域：作品列表（含分页）+「当前任务」跟踪 + 任务动作（取消/重试/核验/标签/删除）+
  账号级 SSE 订阅。`busy` / `working` 也在本域：写 `busy` 的是任务动作与面板提交
  （Composer 经 useJobsBridge 拿 setBusy），归不到更小的域。

  「当前任务」不是一个纯粹的 state：冷加载 /create 时本会话还没提交过任何东西，但页面
  仍要把最新的一条当作当前任务（方案 §7.1 #8），所以生效值是「显式选中的那条 ?? 最新一条」。
  `pickedJob` 记显式选择（提交 / 点最近任务 / 轮询回写），`dismissed` 记「用户点了关闭」——
  没有它的话关闭会立刻被 jobs[0] 顶回来。jobs 由 store 按 createdAt 倒序下发，新任务 unshift。
*/

export type JobsShell = {
  jobs: JobPublic[];
  currentJob: JobPublic | null;
  setCurrentJob: (job: JobPublic | null) => void;
  busy: boolean;
  working: boolean;
  cancel: () => void;
  retry: () => void;
  /** 核验上游（恢复中心）：仅 `retryBlocked.code === "uncertain_submit"` 时出现 */
  reconcile: () => void;

  /* 作品列表分页（`GET /api/jobs?before=&limit=&kind=`） */
  /** 这一类还有更老的没拉过来 */
  hasMoreJobs: (kind: JobKind) => boolean;
  loadMoreJobs: (kind: JobKind) => void;
  jobsLoading: boolean;
  /** 分页失败时的那句话；再点一次「加载更多」会清掉 */
  jobsError: string | null;

  /* 作品操作（详情浮层） */
  /** `PATCH /api/jobs/:id { tags }`，整组替换 */
  saveTags: (id: string, tags: string[]) => Promise<void>;
  /** `DELETE /api/jobs/:id`，成功后从列表里移除 */
  removeJob: (id: string) => Promise<void>;

  /** 点通知：选中那条任务并跳创作页 */
  openNotice: (notice: Notice) => void;
};

/** 给下层域（Composer）的内部接口：提交要写 busy、把新任务 upsert 进列表。 */
export type JobsBridge = JobsShell & {
  upsert: (job: JobPublic) => void;
  setBusy: (value: boolean) => void;
};

const Ctx = createContext<JobsBridge | null>(null);

export function useJobs(): JobsShell {
  const value = useContext(Ctx);
  if (!value) throw new Error("useJobs 必须在 JobsProvider 内使用");
  return value;
}

/** 仅供下层壳域调用（ComposerProvider），视图组件请用 `useJobs()`。 */
export function useJobsBridge(): JobsBridge {
  const value = useContext(Ctx);
  if (!value) throw new Error("useJobsBridge 必须在 JobsProvider 内使用");
  return value;
}

/** 列表恒按 createdAt 倒序；同一毫秒时按 id 兜底，保证顺序稳定（分页不会左右横跳）。 */
function byNewest(a: JobPublic, b: JobPublic): number {
  const d = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (d !== 0 && Number.isFinite(d)) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** 追加一页：已在列表里的 id 保持原对象（那份可能正被 SSE / 轮询更新着），其余按时间插入。 */
function appendJobs(prev: JobPublic[], page: JobPublic[]): JobPublic[] {
  const known = new Set(prev.map((j) => j.id));
  const add = page.filter((j) => j && typeof j.id === "string" && !known.has(j.id));
  if (!add.length) return prev;
  return [...prev, ...add].sort(byNewest);
}

// useJobLive 需要一个 job；没有任务时给它一个终态哑对象，effect 直接跳过
const NO_JOB = { id: "", status: "succeeded" } as const;

export function JobsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useT();
  const { caps, refreshMe, setError } = useSessionBridge();
  const { noteJob, observeJobStatus, emitJobTerminal, syncNotices, dismissNoticeToast } = useNoticesBridge();

  const [jobs, setJobs] = useState<JobPublic[]>(caps.initialJobs);
  const [pickedJob, setPickedJob] = useState<JobPublic | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const currentJob: JobPublic | null = pickedJob ?? (dismissed ? null : (jobs[0] ?? null));
  const setCurrentJob = useCallback((job: JobPublic | null) => {
    setPickedJob(job);
    setDismissed(job === null);
  }, []);
  const [busy, setBusy] = useState(false);

  /* 分页：两类各一个游标与「还有没有」。首屏 40 条是混着的，所以初值都取服务端那个标记。 */
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [more, setMore] = useState<Record<JobKind, boolean>>({ video: caps.moreJobs, image: caps.moreJobs });
  const [cursor, setCursor] = useState<Partial<Record<JobKind, string>>>({});

  /* ── 任务跟踪 ── */
  const upsert = useCallback((j: JobPublic) => {
    setJobs((prev) => (prev.some((x) => x.id === j.id) ? prev.map((x) => (x.id === j.id ? j : x)) : [j, ...prev]));
  }, []);
  const onLive = useCallback(
    (j: JobPublic) => {
      setCurrentJob(j);
      upsert(j);
    },
    [setCurrentJob, upsert],
  );
  useJobLive(currentJob ?? NO_JOB, onLive);

  const jobId = currentJob?.id ?? "";
  const jobTerminal = !!currentJob && isTerminal(currentJob.status);
  /*
    当前任务换条 / 转终态时刷新余额。原来是 Session 的 fetchMe effect 里 `jobId` /
    `jobTerminal` 两个依赖；Session 在本域外层拿不到任务，改由这里代为调
    `refreshMe`——挂载那一跳跳过（Session 的 effect 自己在挂载时已经拉过一次），
    触发时机与原先逐次对应。
  */
  const jobWatchMounted = useRef(false);
  useEffect(() => {
    if (!jobWatchMounted.current) {
      jobWatchMounted.current = true;
      return;
    }
    refreshMe();
  }, [jobId, jobTerminal, refreshMe]);

  /* ── 分页：`GET /api/jobs?before=&limit=&kind=` ── */
  /*
    游标从「这一类里最老的那条」算：首屏 40 条是 SSR 混着下发的，服务端没给过游标，
    所以第一次「加载更多」得自己推。之后一律用服务端回的 `nextBefore`——它在不在，
    就是「还有没有下一页」的唯一判据（契约）。
  */
  // ref 只在事件回调里读（点「加载更多」、收到 SSE），所以在 effect 里同步就够了；
  // render 期间写 ref 会被 react-hooks/refs 拦下。
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  const hasMoreJobs = useCallback((kind: JobKind) => more[kind], [more]);

  const loadMoreJobs = useCallback(
    (kind: JobKind) => {
      if (jobsLoading || !more[kind]) return;
      const before = cursor[kind] ?? jobsRef.current.filter((j) => kindOfJob(j) === kind).at(-1)?.createdAt;
      setJobsLoading(true);
      setJobsError(null);
      void fetchJobsPage({ before, limit: JOBS_PAGE, kind }).then(
        (page) => {
          setJobsLoading(false);
          setJobs((prev) => appendJobs(prev, page.jobs));
          setCursor((c) => ({ ...c, [kind]: page.nextBefore }));
          setMore((m) => ({ ...m, [kind]: Boolean(page.nextBefore) }));
        },
        (e: unknown) => {
          setJobsLoading(false);
          setJobsError(errorText(t, e));
        },
      );
    },
    [cursor, jobsLoading, more, t],
  );

  /* ── 作品操作：标签 / 删除 ── */

  const saveTags = useCallback(
    async (id: string, tags: string[]) => {
      const next = await patchJobTags(id, tags);
      // 服务端回的是整条任务：直接换掉本地那份，标签之外的字段也跟着对齐
      upsert(next);
    },
    [upsert],
  );

  const removeJob = useCallback(
    async (id: string) => {
      await deleteJob(id);
      setJobs((prev) => prev.filter((j) => j.id !== id));
      // 删掉的正好是「当前任务」时把它关掉，否则创作页会指着一条不存在的记录
      setPickedJob((prev) => (prev?.id === id ? null : prev));
    },
    [],
  );

  /* ── 任务完成通知：账号级 SSE + 服务端落盘（H1） ── */
  /*
    通知条目与落盘对齐在 NoticesProvider；本域负责观察 SSE 上每一次状态迁移、
    算「静默」（在 /create 上看着的那条任务转终态时不弹 toast：页面上已经在放成片了），
    再把终态交给通知域即时插入 + 对齐。
  */
  const quietRef = useRef({ path: pathname ?? "/", jobId: "" });
  const quietPath = pathname ?? "/";
  const quietJobId = currentJob?.id ?? "";
  useEffect(() => {
    quietRef.current = { path: quietPath, jobId: quietJobId };
  }, [quietPath, quietJobId]);

  const onEventJob = useCallback(
    (job: JobPublic) => {
      const prev = observeJobStatus(job);
      upsert(job);
      if (prev === undefined || isTerminal(prev) || !isTerminal(job.status)) return;
      const quiet = quietRef.current.path === "/create" && quietRef.current.jobId === job.id;
      emitJobTerminal(job, quiet);
    },
    [observeJobStatus, upsert, emitJobTerminal],
  );
  const onEventsOpen = useCallback(() => syncNotices(), [syncNotices]);
  useEvents(true, onEventJob, onEventsOpen, syncNotices);

  /** 点通知：选中那条任务并跳创作页。 */
  const openNotice = useCallback(
    (notice: Notice) => {
      dismissNoticeToast();
      if (notice.kind === "run") {
        router.push("/canvas");
        return;
      }
      if (notice.kind === "agent") {
        router.push(notice.sessionId ? `/agent?session=${notice.sessionId}` : "/agent");
        return;
      }
      const noticeJobId = notice.jobId;
      if (!noticeJobId) return;
      const job = jobsRef.current.find((j) => j.id === noticeJobId);
      if (job) {
        setCurrentJob(job);
        router.push("/create");
        return;
      }
      /*
        落盘之后通知可能比本地列表活得久：列表只装了最近一页（40 条），更老的、
        或留存期被清了产物的任务都还在通知里。点之前先把那条任务取回来再跳，
        取不到（已删除）也照跳——创作页会落到最新一条。
      */
      void fetchJob(noticeJobId).then(
        (next) => {
          if (next) {
            upsert(next);
            setCurrentJob(next);
          }
          router.push("/create");
        },
        () => router.push("/create"),
      );
    },
    [router, setCurrentJob, upsert, dismissNoticeToast],
  );

  /*
    一次提交 n 条时，`useJobLive` 只盯住「当前任务」那一条，另外几条会一直停在提交时的
    状态直到刷新。这里给它们补一个 2.5s 的轮询：只查非终态、且不是当前任务的那几条，
    最多三条，出片后自然停下——「最近任务」列表才会跟着动（阶段 A §5）。
  */
  const backlog = jobs
    .filter((j) => j.id !== jobId && isActive(j.status))
    .slice(0, 3)
    .map((j) => j.id)
    .join(",");
  useEffect(() => {
    if (!backlog) return;
    const ids = backlog.split(",");
    let stopped = false;
    const tick = async () => {
      for (const id of ids) {
        if (stopped) return;
        try {
          const next = await fetchJob(id);
          if (next && !stopped) upsert(next);
        } catch {
          // 401 已跳登录页；其它错误下一轮再说
        }
      }
    };
    const timer = setInterval(() => void tick(), 2500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [backlog, upsert]);

  const active = !!currentJob && isActive(currentJob.status);
  const working = busy || active;

  const cancel = useCallback(() => {
    const job = currentJob;
    if (!job || busy || !isActive(job.status)) return;
    setError(null);
    setBusy(true);
    void cancelJob(job.id).then(
      (next) => {
        setBusy(false);
        onLive(next);
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(t, e));
      },
    );
  }, [busy, currentJob, onLive, setError, t]);

  const retry = useCallback(() => {
    const job = currentJob;
    if (!job || busy || (job.status !== "failed" && job.status !== "expired")) return;
    // 服务端 409 之外的第二道防线：上游可能已经接单计费，这条任务不能重发（方案 §5）。
    if (job.retryBlocked) return;
    // 留存期满、素材已删的任务也不给重试（方案 §5）。
    if (job.artifactsPurgedAt) return;
    setError(null);
    setBusy(true);
    void retryJob(job.id).then(
      (next) => {
        setBusy(false);
        // 重试建的是一条**新任务**，与提交同理要先记一笔，它出片时才会有通知
        noteJob(next);
        onLive(next);
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(t, e));
        refreshMe();
      },
    );
  }, [busy, currentJob, onLive, refreshMe, noteJob, setError, t]);

  /**
   * 核验上游（A 包恢复中心）：`uncertain_submit` 的任务拿我们自己的 jobId 去查上游——
   * 查到了任务接管成 pending 照常出片；查不到就把标记降级成普通失败，「重新生成」
   * 随之解锁。两种结局都不新花钱。
   */
  const reconcile = useCallback(() => {
    const job = currentJob;
    if (!job || busy || job.retryBlocked?.code !== "uncertain_submit") return;
    setError(null);
    setBusy(true);
    void reconcileJob(job.id).then(
      ({ job: next }) => {
        setBusy(false);
        onLive(next);
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(t, e));
      },
    );
  }, [busy, currentJob, onLive, setError, t]);

  const value = useMemo<JobsBridge>(
    () => ({
      jobs,
      currentJob,
      setCurrentJob,
      busy,
      working,
      cancel,
      retry,
      reconcile,
      hasMoreJobs,
      loadMoreJobs,
      jobsLoading,
      jobsError,
      saveTags,
      removeJob,
      openNotice,
      upsert,
      setBusy,
    }),
    [
      jobs,
      currentJob,
      setCurrentJob,
      busy,
      working,
      cancel,
      retry,
      reconcile,
      hasMoreJobs,
      loadMoreJobs,
      jobsLoading,
      jobsError,
      saveTags,
      removeJob,
      openNotice,
      upsert,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
