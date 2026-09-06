import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ffmpeg-static", "sharp"],
  // ThreeUI 织物源文档（src/shaders/**/*.html）按 `?raw` 语义作为字符串导入
  turbopack: {
    rules: {
      "*.html": { loaders: ["raw-loader"], as: "*.js" },
    },
  },
  outputFileTracingIncludes: {
    "/*": ["./node_modules/ffmpeg-static/ffmpeg*", "./src/lib/media/fonts/**"],
  },
  outputFileTracingExcludes: {
    "/*": ["./data/**/*"],
  },
};

export default nextConfig;
