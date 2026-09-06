import type { AsyncLocalStorage as AsyncLocalStorageType } from "node:async_hooks";

export type LogLevel = "info" | "warn" | "error";

/**
 * 一条日志线索里恒定要带的东西（方案 §3.2「可观测性」）。
 *
 * 排障时的第一个问题永远是「用户说的那一次点击，对应哪几行日志」。请求侧靠 `reqId`
 * （proxy 生成、写回响应头 `x-request-id`，用户能直接念给我们），任务侧靠
 * `jobId` / `ownerId`——runner 里一条任务的日志散落在 submit / poll / persist 三处，
 * 没有这两个字段就只能靠时间戳猜。
 */
export type LogContext = {
  reqId?: string;
  jobId?: string;
  ownerId?: string;
};

/**
 * 用 AsyncLocalStorage 而不是给每个 `log()` 调用点加参数：那些调用点（provider、
 * ffmpeg、store）离请求入口十几层深，一路透传只会污染每一个函数签名，而且总有
 * 漏掉的地方。
 */
/**
 * 不能静态 `import "node:async_hooks"`：`@/lib/billing/prices` 与 `@/lib/cost` 会被客户端组件
 * 直接 import（售价要在浏览器里算），静态引入会把 Node 内建模块拉进客户端包，Turbopack
 * 直接 panic、首页 500。这里用 Node 22+ 的 `process.getBuiltinModule` 按需取：浏览器里拿不到
 * 就退化成「无上下文」，`log()` 照常打印，只是不带 reqId / jobId。
 */
const storage: AsyncLocalStorageType<LogContext> | null = (() => {
  if (typeof window !== "undefined") return null;
  const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
    .process?.getBuiltinModule;
  if (typeof getBuiltin !== "function") return null;
  try {
    const mod = getBuiltin("node:async_hooks") as { AsyncLocalStorage: new () => AsyncLocalStorageType<LogContext> } | undefined;
    return mod ? new mod.AsyncLocalStorage() : null;
  } catch {
    return null;
  }
})();

/** 当前异步上下文里的线索字段；不在任何请求 / 任务里时是空对象。 */
export function logContext(): LogContext {
  return storage?.getStore() ?? {};
}

/** 在一段异步工作里带上这些字段。请求入口用它（有明确的开始与结束）。 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  if (!storage) return fn();
  return storage.run({ ...logContext(), ...context }, fn);
}

/**
 * 就地合并进上下文，覆盖当前异步资源的剩余部分。
 *
 * 给 runner 用：`runOne` 不是一个能整体包起来的回调（它由 `pump()` 以
 * `void runOne(id)` 发射，后面还接着 `.finally`），只能在函数入口就地设置。
 * `enterWith` 的影响范围是「当前同步执行的剩余部分 + 由它派生的异步调用」，
 * 而 `runOne` 在第一次 await 之后才调用它，所以不会漏回 `pump()` 的循环里。
 *
 * 与 `runWithLogContext` 一样是**合并**：调用方要丢掉某个继承来的字段时，显式把它写成
 * `undefined`（`JSON.stringify` 会把值为 undefined 的键整个略掉，日志里不会留下空字段）。
 * runner 对 `reqId` 就是这么做的，理由写在那边。
 */
export function enterLogContext(context: LogContext): void {
  storage?.enterWith({ ...logContext(), ...context });
}

export function log(level: LogLevel, message: string, extra?: Record<string, unknown>) {
  const line = {
    t: new Date().toISOString(),
    level,
    message,
    // 上下文在前、显式参数在后：调用点写了同名字段（比如 harness 里带的另一个 id）
    // 时以调用点为准，上下文只负责补上没人记得写的那几个。
    ...logContext(),
    ...extra,
  };
  const s = JSON.stringify(line);
  if (level === "error") console.error(s);
  else if (level === "warn") console.warn(s);
  else console.log(s);
}
