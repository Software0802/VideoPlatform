import { transitionShot, type HarnessShotRecord } from "./shot-state";
import type { Shot } from "./types";

export type ShotDependencyResolver = (
  shot: Shot,
  shots: readonly Shot[],
) => readonly string[];

export type ShotCoordinatorOptions = {
  shots: readonly Shot[];
  records: readonly HarnessShotRecord[];
  maxParallel: number;
  execute: (shot: Shot, record: HarnessShotRecord) => Promise<HarnessShotRecord>;
  dependencies?: ShotDependencyResolver;
  onState?: (record: HarnessShotRecord) => Promise<void> | void;
};

export async function executeShotPlan(
  options: ShotCoordinatorOptions,
): Promise<HarnessShotRecord[]> {
  validateOptions(options);
  const shotById = new Map(options.shots.map((shot) => [shot.id, shot]));
  const recordById = new Map(options.records.map((record) => [record.id, { ...record }]));
  const dependencies = options.dependencies ?? defaultDependencies;
  const pending = new Set(
    options.records
      .filter((record) =>
        ["queued", "failed", "submitting", "pending", "persisting"].includes(record.status),
      )
      .map((record) => record.id),
  );
  const running = new Map<string, Promise<{ id: string; record: HarnessShotRecord }>>();

  while (pending.size || running.size) {
    for (const id of [...pending].sort((a, b) => recordById.get(a)!.index - recordById.get(b)!.index)) {
      const shot = shotById.get(id)!;
      const record = recordById.get(id)!;
      const dependencyIds = dependencies(shot, options.shots);
      const waitingToStart = record.status === "queued" || record.status === "failed";
      const missing = dependencyIds.some((dependencyId) => !recordById.has(dependencyId));
      if (missing) {
        if (!waitingToStart) continue;
        const blocked = transitionShot(record, "needs_review", {
          error: { code: "dependency_missing", message: "shot 前置依赖不存在" },
        });
        pending.delete(id);
        recordById.set(id, blocked);
        await options.onState?.(blocked);
        continue;
      }
      const failedDependency = dependencyIds.some((dependencyId) => {
        const dependency = recordById.get(dependencyId)!;
        return ["needs_review", "canceled"].includes(dependency.status) ||
          (dependency.status === "failed" && !pending.has(dependencyId) && !running.has(dependencyId));
      });
      if (failedDependency) {
        if (!waitingToStart) continue;
        const blocked = transitionShot(record, "needs_review", {
          error: { code: "dependency_failed", message: "前置 shot 未成功" },
        });
        pending.delete(id);
        recordById.set(id, blocked);
        await options.onState?.(blocked);
      }
    }

    for (const id of [...pending].sort((a, b) => recordById.get(a)!.index - recordById.get(b)!.index)) {
      if (running.size >= options.maxParallel) break;
      const shot = shotById.get(id)!;
      const record = recordById.get(id)!;
      const dependencyIds = dependencies(shot, options.shots);
      if (!dependencyIds.every((dependencyId) => recordById.get(dependencyId)?.status === "succeeded")) {
        continue;
      }
      pending.delete(id);
      running.set(
        id,
        Promise.resolve(options.execute(shot, record)).then((next) => ({ id, record: next })),
      );
    }

    if (!running.size) {
      if (!pending.size) break;
      // No runnable node remains: the pending subgraph contains a cycle or an unresolved state.
      for (const id of [...pending]) {
        const record = recordById.get(id)!;
        const blocked = transitionShot(record, "needs_review", {
          error: { code: "dependency_cycle", message: "shot 前置依赖存在循环或无法满足" },
        });
        pending.delete(id);
        recordById.set(id, blocked);
        await options.onState?.(blocked);
      }
      continue;
    }

    const settled = await Promise.race(running.values());
    running.delete(settled.id);
    if (settled.record.id !== settled.id) {
      throw new Error("shot 执行器返回了错误 ID");
    }
    recordById.set(settled.id, { ...settled.record });
  }

  return options.records.map((record) => recordById.get(record.id)!);
}

function defaultDependencies(shot: Shot, shots: readonly Shot[]): readonly string[] {
  if (
    shot.index <= 0 ||
    (shot.continuity !== "tail_chain" &&
      shot.continuity !== "extend" &&
      shot.startFrame?.source !== "extracted")
  ) {
    return [];
  }
  const previous = shots.find((candidate) => candidate.index === shot.index - 1);
  return previous ? [previous.id] : ["__missing_previous_shot__"];
}

function validateOptions(options: ShotCoordinatorOptions) {
  if (!Number.isInteger(options.maxParallel) || options.maxParallel < 1) {
    throw new Error("并发上限无效");
  }
  if (!options.shots.length) throw new Error("shot 计划不能为空");
  const shotIds = new Set(options.shots.map((shot) => shot.id));
  if (shotIds.size !== options.shots.length) throw new Error("shot 计划无效");
  const recordIds = new Set(options.records.map((record) => record.id));
  if (recordIds.size !== options.records.length || options.records.length !== options.shots.length) {
    throw new Error("shot 状态与计划不匹配");
  }
  for (const shot of options.shots) {
    if (!recordIds.has(shot.id)) throw new Error("shot 状态与计划不匹配");
  }
}
