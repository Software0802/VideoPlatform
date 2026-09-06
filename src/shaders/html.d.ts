// `*.html` 由 next.config.ts 的 turbopack 规则经 raw-loader 作为字符串导入（ThreeUI 源码里的 `?raw` 约定）。
declare module "*.html" {
  const source: string;
  export default source;
}
