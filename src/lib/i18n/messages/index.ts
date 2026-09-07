import type { Locale } from "../locales";
import * as zh from "./zh-CN";
import * as en from "./en";

/**
 * 字典装配。每个视图一个命名空间文件（`zh-CN/<ns>.ts` 是键的事实源，`en/<ns>.ts`
 * 的类型由它推导，漏键即编译错误）。键值是扁平字符串，占位用 `{name}`（见 `format.ts`）。
 *
 * 各命名空间由各自视图的维护者独占，避免多人同时改一个大字典文件。
 */
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void
  ? I
  : never;

function assemble<T extends Record<string, Record<string, string>>>(mods: T) {
  return Object.assign({}, ...Object.values(mods)) as UnionToIntersection<T[keyof T]>;
}

export const ZH_CN = assemble(zh);
export type MessageKey = keyof typeof ZH_CN;
export type Messages = Record<MessageKey, string>;

export const MESSAGES: Record<Locale, Messages> = {
  "zh-CN": ZH_CN as Messages,
  en: assemble(en) as Messages,
};
