import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ffmpeg-static", "sharp"],
  outputFileTracingIncludes: {
    "/*": ["./node_modules/ffmpeg-static/ffmpeg*", "./src/lib/media/fonts/**"],
  },
  outputFileTracingExcludes: {
    "/*": ["./data/**/*"],
  },
  // F-15：旧路由页曾是各自 page.tsx 里的 redirect("/")，统一收进 redirects()。
  // source 只匹配页面路径，"/jobs/:id" 不会吞掉 "/api/jobs/..."。
  async redirects() {
    return [
      { source: "/gallery", destination: "/", permanent: false },
      { source: "/studio", destination: "/", permanent: false },
      { source: "/studio/:kind", destination: "/", permanent: false },
      { source: "/jobs/:id", destination: "/", permanent: false },
    ];
  },
};

export default nextConfig;
