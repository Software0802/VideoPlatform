import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enterLogContext, log, logContext, runWithLogContext } from "./log";

/**
 * 可观测性（方案 §3.2）：`log()` 自动带上 AsyncLocalStorage 里的 `reqId` / `jobId` /
 * `ownerId`，不需要每个调用点显式传参。这份测试盯三件事：不在任何上下文里时什么都不带、
 * 在上下文里时自动带上、以及并发的两个上下文互不串号（ALS 存在的全部意义）。
 *
 * `log.ts` 没有任何外部依赖（不碰文件系统 / 环境变量），所以不需要 DATA_DIR 之类的
 * 测试夹具。
 */

type LogLine = { t: string; level: string; message: string; [key: string]: unknown };

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

function lastLine(spy: ReturnType<typeof vi.spyOn>): LogLine {
  const calls = spy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(calls[calls.length - 1][0] as string) as LogLine;
}

describe("log() routes by level and emits structured JSON", () => {
  it("sends info to console.log, warn to console.warn, error to console.error", () => {
    log("info", "hello");
    log("warn", "careful");
    log("error", "boom");

    expect(lastLine(logSpy)).toMatchObject({ level: "info", message: "hello" });
    expect(lastLine(warnSpy)).toMatchObject({ level: "warn", message: "careful" });
    expect(lastLine(errorSpy)).toMatchObject({ level: "error", message: "boom" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("stamps a parseable ISO timestamp and merges in extra fields", () => {
    log("info", "with extra", { jobId: "job_1", n: 3 });
    const line = lastLine(logSpy);
    expect(Number.isNaN(Date.parse(line.t))).toBe(false);
    expect(line).toMatchObject({ jobId: "job_1", n: 3 });
  });

  it("carries no reqId/jobId/ownerId at all outside any log context", () => {
    log("info", "no context here");
    const line = lastLine(logSpy);
    expect("reqId" in line).toBe(false);
    expect("jobId" in line).toBe(false);
    expect("ownerId" in line).toBe(false);
  });
});

describe("runWithLogContext auto-attaches its fields to every log() call inside it", () => {
  it("attaches reqId set at the entry point, synchronously", () => {
    runWithLogContext({ reqId: "req-abc123" }, () => {
      log("info", "inside");
    });
    expect(lastLine(logSpy)).toMatchObject({ reqId: "req-abc123" });
  });

  it("keeps attaching it across an await inside the wrapped async function", async () => {
    await runWithLogContext({ reqId: "req-async" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      log("info", "after await");
    });
    expect(lastLine(logSpy)).toMatchObject({ reqId: "req-async" });
  });

  it("does not leak the context to a log() call made after it returns", async () => {
    await runWithLogContext({ reqId: "req-scoped" }, async () => {
      log("info", "inside");
    });
    log("info", "outside, after the context ended");
    const line = lastLine(logSpy);
    expect("reqId" in line).toBe(false);
  });

  it("passes through the wrapped function's return value, sync and async", async () => {
    expect(runWithLogContext({ reqId: "r" }, () => 42)).toBe(42);
    await expect(runWithLogContext({ reqId: "r" }, async () => "done")).resolves.toBe("done");
  });

  it("merges with an outer context rather than replacing it (reqId + jobId together)", () => {
    runWithLogContext({ reqId: "req-outer" }, () => {
      runWithLogContext({ jobId: "job-inner" }, () => {
        log("info", "nested");
      });
    });
    expect(lastLine(logSpy)).toMatchObject({ reqId: "req-outer", jobId: "job-inner" });
  });

  it("lets an inner context override a field the outer context also set", () => {
    runWithLogContext({ reqId: "req-outer" }, () => {
      runWithLogContext({ reqId: "req-inner" }, () => {
        log("info", "override");
      });
      log("info", "back to outer, after the inner context returned");
    });
    expect(logSpy.mock.calls.map((c: unknown[]) => (JSON.parse(c[0] as string) as LogLine).reqId)).toEqual([
      "req-inner",
      "req-outer",
    ]);
  });

  it("lets an explicit extra field on the call site win over the ambient context", () => {
    runWithLogContext({ reqId: "req-context" }, () => {
      log("info", "explicit wins", { reqId: "req-explicit" });
    });
    expect(lastLine(logSpy)).toMatchObject({ reqId: "req-explicit" });
  });

  it("keeps two concurrent contexts from bleeding into each other's log lines", async () => {
    await Promise.all([
      runWithLogContext({ reqId: "req-A" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        log("info", "from A");
      }),
      runWithLogContext({ reqId: "req-B" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        log("info", "from B");
      }),
    ]);

    const byMessage = Object.fromEntries(
      logSpy.mock.calls.map((c: unknown[]) => {
        const line = JSON.parse(c[0] as string) as LogLine;
        return [line.message, line.reqId];
      }),
    );
    expect(byMessage["from A"]).toBe("req-A");
    expect(byMessage["from B"]).toBe("req-B");
  });
});

describe("enterLogContext sets the context in place, for callbacks that can't be wrapped", () => {
  it("makes the rest of the current flow see the field, without an enclosing callback", () => {
    runWithLogContext({}, () => {
      enterLogContext({ jobId: "job-entered" });
      log("info", "after enterLogContext");
    });
    expect(lastLine(logSpy)).toMatchObject({ jobId: "job-entered" });
  });

  it("merges into whatever ambient context is already active", () => {
    runWithLogContext({ reqId: "req-ambient" }, () => {
      enterLogContext({ jobId: "job-entered" });
      expect(logContext()).toEqual({ reqId: "req-ambient", jobId: "job-entered" });
    });
  });
});
