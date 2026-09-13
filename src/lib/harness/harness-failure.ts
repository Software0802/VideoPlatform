/**
 * Harness 级失败（预算、质检、计划不可用……）。独立成文件是因为 Director / 视觉 QC
 * 也要抛它，而他们不能被 orchestrator import 回来造成循环依赖。
 */
export class HarnessFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HarnessFailure";
  }
}
