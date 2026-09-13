"use client";

import { useEffect, useRef } from "react";
import {
  fetchCanvasRun,
  type CanvasDocument,
  type CanvasRun,
} from "@/lib/client/canvas";
import { fetchJob } from "@/lib/client/jobs";
import type { JobPublic } from "@/lib/jobs/schema";
import { TERMINAL } from "./util";

const POLL_MS = 3000;

/**
 * 画布的轮询/补拉簇（R5.3 自 CanvasView 拆出）：
 * - 整图运行轮询：running 的 run 每 3s 问一次；
 * - 执行位签名变化时重拉顶栏余额；
 * - 生成节点轮询：有 jobId 未终态的节点每 3s 问一次；
 * - 首次见到 jobId 立即补拉一次。
 * 只读入参、只经 setState 回写，返回值无。
 */
export function useCanvasPolling({
  doc,
  latestRun,
  setLatestRun,
  jobs,
  setJobs,
  refreshMe,
}: {
  doc: CanvasDocument | null;
  latestRun: CanvasRun | null;
  setLatestRun: React.Dispatch<React.SetStateAction<CanvasRun | null>>;
  jobs: Record<string, JobPublic>;
  setJobs: React.Dispatch<React.SetStateAction<Record<string, JobPublic>>>;
  refreshMe: () => void;
}) {
  /* 整图运行轮询（D 包）：running 的 run 每 3s 问一次；进终态由 CanvasView 的 toast effect 报。 */
  // 只按「哪张 run、是否还在跑」重建定时器；run 对象内容刷新不该重启轮询——
  // 依赖收敛成「running 时的 id」，run 内容经 setLatestRun 回流即可。
  const pollRunId = latestRun?.status === "running" ? latestRun.id : null;
  useEffect(() => {
    if (!pollRunId) return;
    const timer = setInterval(() => {
      // 轮询的 5xx/断网按「这拍跳过」吞掉，下拍再来；401 已由 parseAuthed 整页跳登录。
      void fetchCanvasRun(pollRunId)
        .then((run) => {
          if (run) setLatestRun(run);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pollRunId, setLatestRun]);

  const execSignature = (latestRun?.nodeExecutions ?? [])
    .map((e) => `${e.nodeId}:${e.status}`)
    .join(",");
  const runId = latestRun?.id ?? null;
  const runStatus = latestRun?.status ?? null;
  // refreshMe 经 ref 取最新：依赖表只含触发条件（id/status/签名），回调换引用不重启 effect。
  const refreshMeRef = useRef(refreshMe);
  useEffect(() => {
    refreshMeRef.current = refreshMe;
  }, [refreshMe]);
  useEffect(() => {
    if (!runId) return;
    // 执行位状态每变一次（提交/成功/失败/驳回/取消）余额或在途预留都会变，顶栏读数跟着重拉
    refreshMeRef.current();
  }, [runId, runStatus, execSignature]);

  /* 生成节点轮询：有 jobId 未终态的节点每 3s 问一次（含 run 执行位的 jobId）。 */
  const pendingJobIds = [
    ...(doc?.nodes ?? []).map((n) => n.jobId),
    ...(latestRun?.nodeExecutions ?? []).map((e) => e.jobId),
  ].filter((id): id is string => Boolean(id) && !TERMINAL.has(jobs[id!]?.status ?? ""));
  const pendingKey = pendingJobIds.join(",");
  useEffect(() => {
    // jobId 形如 `job_*`、不含逗号，key 拆回即原 id 集；依赖字符串使成员相同就不重启定时器。
    const ids = pendingKey ? pendingKey.split(",") : [];
    if (!ids.length) return;
    const timer = setInterval(() => {
      for (const id of ids) {
        // 同上：轮询失败吞掉等下拍，401 由 parseAuthed 跳登录。
        void fetchJob(id)
          .then((job) => {
            if (job) setJobs((map) => ({ ...map, [id]: job }));
          })
          .catch(() => {});
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pendingKey, setJobs]);

  /* 首次见到 jobId 就立即拉一次（刷新恢复时不必等一个轮询周期）。 */
  useEffect(() => {
    const ids = [
      ...(doc?.nodes ?? []).map((n) => n.jobId),
      ...(latestRun?.nodeExecutions ?? []).map((e) => e.jobId),
    ];
    for (const id of ids) {
      if (id && !jobs[id]) {
        // 同上：失败吞掉——这是轮询的补拉，下一拍还会再来；401 由 parseAuthed 跳登录。
        void fetchJob(id)
          .then((job) => {
            if (job) setJobs((map) => ({ ...map, [id]: job }));
          })
          .catch(() => {});
      }
    }
  }, [doc, jobs, latestRun, setJobs]);
}
