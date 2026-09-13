/**
 * 兼容薄壳（N3.4）：实现已搬到 `@/lib/providers/health.ts`——「耗尽 6h」是
 * 分级冷却里 `quota_exhausted` 的那一档，签名与语义不变，既有调用方与测试不动。
 */
export {
  exhaustedList,
  isExhausted,
  markExhausted,
  type ExhaustionEntry,
  type ExhaustionKind,
} from "@/lib/providers/health";
