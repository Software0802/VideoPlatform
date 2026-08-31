"use client";

export function LiveMockBanner({
  mock,
  upstream = mock ? "mock" : "xai",
  mockReason = "missing-key",
}: {
  mock: boolean;
  upstream?: "mock" | "xai" | "sub2api";
  mockReason?: "missing-key" | "forced";
}) {
  const isMock = mock || upstream === "mock";
  const label = isMock
    ? mockReason === "forced"
      ? "模拟模式：已强制，生成带水印的占位视频"
      : "模拟模式：未配置 XAI_API_KEY，生成带水印的占位视频"
    : upstream === "sub2api"
      ? "Sub2API · Grok 订阅反代"
      : "已连接 Grok Imagine";
  return (
    <p
      className={`live-mock-banner flex min-w-0 max-w-[min(100%,360px)] items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] ${
        isMock
          ? "border-accent/35 bg-accent/10 text-accent-strong"
          : "border-ok/30 bg-ok/10 text-ok"
      }`}
      title={isMock ? "请求不会调用 Grok，上游结果会带有模拟水印。" : label}
    >
      <span
        className={`inline-block size-1.5 rounded-full ${
          isMock ? "bg-accent" : "animate-pulse-dot bg-ok"
        }`}
      />
      <span className="min-w-0 truncate">{label}</span>
    </p>
  );
}
