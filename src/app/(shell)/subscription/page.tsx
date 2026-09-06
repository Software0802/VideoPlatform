"use client";

import SubscriptionView from "@/components/genius/subscription/SubscriptionView";
import { useShell } from "@/components/genius/ShellContext";

/**
 * `/subscription` 订阅。方案里唯一要读真实数据的无后端视图：「我的方案」卡上的 ⚡ 是
 * 真实积分（`¥1 = 100 积分`，来自 `/api/me` 的可用余额），所以这一页是客户端组件——
 * 积分在壳的 ShellContext 里，不再单独请求一次。
 */
export default function SubscriptionPage() {
  const { credits } = useShell();
  return <SubscriptionView credits={credits} />;
}
