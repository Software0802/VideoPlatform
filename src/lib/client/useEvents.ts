"use client";

import { useEffect, useRef } from "react";
import type { JobPublic } from "@/lib/jobs/schema";

/**
 * 账号级事件流：`GET /api/events`（SSE，本人**所有**任务，`{ type:"job", job }`）。
 *
 * 与 `useJobLive` 的分工：那个盯住「当前任务」一条并以 2s 轮询为真相（任务链路的进度
 * 与终态由它负责）；这里只负责「壳」——不管用户此刻在哪个视图，任何一条任务转终态都
 * 要能弹出通知、更新顶栏铃铛。所以这里**只订阅、不轮询**：断了就退避重连，一直连不上
 * 也只是少一次通知，不影响任何一条任务自己的进度（那条路径有轮询兜底）。
 *
 * 单独成文件而不是塞进 `useJobLive.ts`：两者的生命周期不同（一条任务 vs 整个会话），
 * 而且 `useJobLive` 正在被另一条改动（轮询退避）动着。
 */

/** 退避：1s → 2s → 4s → 8s → 15s 封顶。SSE 断线多半是服务重启或睡眠唤醒，不必秒重连。 */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000] as const;

export function useEvents(
  enabled: boolean,
  onJob: (job: JobPublic) => void,
  /**
   * SSE 每次 `open`（含断线重连成功）时调用——H1 用它补拉断线期间漏掉的
   * 终态通知。可选；不给时行为与之前完全一致。
   */
  onOpen?: () => void,
) {
  // 回调每次 render 都是新的（组件里的闭包），但订阅不该因此重建——否则每次状态更新
  // 都会断开重连一次 SSE。用 ref 转发，effect 只依赖 `enabled`。
  // 赋值放在 effect 里而不是 render 中：render 期间写 ref 会被 react-hooks/refs 拦下，
  // 而且 StrictMode 的双渲染下语义也不明确。事件是异步到的，晚一个 commit 更新没影响。
  const handler = useRef(onJob);
  const openHandler = useRef(onOpen);
  useEffect(() => {
    handler.current = onJob;
    openHandler.current = onOpen;
  }, [onJob, onOpen]);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    let stopped = false;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const apply = (event: Event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as { type?: string; job?: JobPublic } | JobPublic;
        // 契约是 `{ type:"job", job }`；顺手也认裸 job（与 `/api/jobs/:id/events` 同形状）
        const job = "job" in data && data.job ? data.job : ("id" in data ? (data as JobPublic) : null);
        if (job && typeof job.id === "string" && job.id) handler.current(job);
      } catch {
        // 坏帧丢掉：一条读不懂的事件不该把整条订阅带走
      }
    };

    const connect = () => {
      if (stopped) return;
      try {
        source = new EventSource("/api/events");
      } catch {
        source = undefined;
        return;
      }
      source.addEventListener("open", () => {
        attempt = 0;
        // 建连 / 重连成功那一刻是补拉落盘通知的时机：断线期间的终态事件已经丢了。
        openHandler.current?.();
      });
      source.addEventListener("message", apply);
      source.addEventListener("job", apply);
      source.addEventListener("error", () => {
        // EventSource 自带重连，但路由不存在（后端还没落地）时它会空转重试；
        // 这里接管：关掉再按退避重来，次数越多间隔越长。
        source?.close();
        source = undefined;
        if (stopped) return;
        const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt += 1;
        timer = setTimeout(connect, wait);
      });
    };

    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, [enabled]);
}
