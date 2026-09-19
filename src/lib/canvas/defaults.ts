/**
 * 画布下单时那些「没有界面能选」的缺省值。
 *
 * 画布节点不带时长 / 画幅 / 分辨率选项，视频节点一律按这个时长报价与下单
 * （`canvas/graph.ts` 的 `planNodeJob`，与 `createJob` 的缺省同一档）。节点上的模型
 * 芯片要按同一个数筛产品，否则会把一个时长档接不下 8 秒的产品摆上去，报价那一刻
 * `assertProductFits` 400「所选模型不支持该时长」。两边共用这一份，改一处就一起改。
 *
 * 纯常量、无依赖：服务端与浏览器都直接 import。
 */
export const CANVAS_VIDEO_DURATION_SEC = 8;
