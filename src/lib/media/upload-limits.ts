/**
 * 上传体积上限，服务端与浏览器共用一份（review 2026-09-15 U-01）。
 *
 * 这个文件必须保持可被客户端 import：没有任何 `node:` 依赖，也不读环境变量。前端要按
 * 它在本地先拦一次（并把「6MB」写进错误文案），服务端 `jobs/upload.ts` 用同一组数值做
 * 真正的判定——两边各写一份的话，界面上说的限制迟早和实际拒收的不是同一个数。
 *
 * 数值按生产机（2 核 / 1.8G，`MemoryMax=700M`）定：图片在交给 sharp 之前整份进内存，
 * 而 `preprocessImage` 无论如何都会重编码到 ≤256KB，所以这个上限只会拒掉那些多出来的、
 * 本来也要被丢掉的字节。
 */

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
export const MAX_IMAGE_LABEL = "6MB";
export const MAX_VIDEO_LABEL = "24MB";
