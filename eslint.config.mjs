import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // ThreeUI registered source: keep hashes, skip React Compiler ref rules
    "src/shaders/animated-top-dock/**",
    "src/shaders/warp-field/**",
    // 本地截图/验证临时目录
    ".tmp/**",
  ]),
]);

export default eslintConfig;
