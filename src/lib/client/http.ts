/**
 * Browser-side plumbing shared by `jobs.ts` and `auth.ts`.
 *
 * Every `/api/*` route needs a session (plan §4), so a 401 on a protected call
 * means the cookie expired or was revoked, not that the caller mistyped
 * something. The old single-user access-token dialog is gone; the recovery is
 * the login page (plan §7).
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** `error.code` from the server envelope, when there was one. */
    readonly code?: string,
    /** `x-request-id` response header, for reporting a failure back to us. */
    readonly requestId?: string,
    /**
     * 服务端在错误信封里显式声明可下发的那几个标量（`ProviderHttpError` 的
     * `publicFields`）：重试涨价的新价、限流剩余秒数之类。界面要按里面的数做事。
     */
    readonly fields?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Concurrent pollers can all see the same expired session, and each one calling
 * `assign` would queue a stack of navigations. Latch on the first.
 */
let redirecting = false;

export function redirectToLogin(): void {
  if (typeof window === "undefined" || redirecting) return;
  if (window.location.pathname === "/login") return;
  redirecting = true;
  // 普通模块，拿不到 useRouter；而且会话失效时本来就该整页重来，丢掉全部客户端状态
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/login");
}

/**
 * 轮询类请求的超时信号。
 *
 * 浏览器这边一次 `fetch` 没有默认时限：弱网或中间代理吞包时它既不 resolve 也不 reject。
 * 任务页的轮询是「上一拍回来才排下一拍」的链，一次永不 settle 的请求会把整条链静悄悄
 * 掐断——成片早就好了，界面还在转圈，只有刷新才恢复。给这类请求一个上限，超时按普通
 * 失败处理（下一拍照常继续）。
 *
 * `AbortSignal.timeout` 在老浏览器上可能没有；拿不到就返回 undefined，行为与从前一致，
 * 绝不能因为探测失败把轮询本身弄崩。
 */
export function pollTimeoutSignal(ms = 20_000): AbortSignal | undefined {
  try {
    return AbortSignal.timeout?.(ms);
  } catch {
    return undefined;
  }
}

type ErrorEnvelope = { error?: { code?: string; message?: string } & Record<string, unknown> };

/** `{error:{code,message}}` in, `ApiError` out. Leaves 401 to the caller. */
export async function parseJson<T>(res: Response, fallback: string): Promise<T> {
  const data = (await res.json().catch(() => null)) as (T & ErrorEnvelope) | null;
  if (!res.ok) {
    const envelope = data?.error;
    const fields = envelope
      ? Object.fromEntries(Object.entries(envelope).filter(([k]) => k !== "code" && k !== "message"))
      : undefined;
    throw new ApiError(
      envelope?.message ?? fallback,
      res.status,
      envelope?.code,
      res.headers.get("x-request-id") ?? undefined,
      fields && Object.keys(fields).length ? fields : undefined,
    );
  }
  return data as T;
}

/** Same, for routes that require a session: a 401 sends the browser to `/login`. */
export async function parseAuthed<T>(res: Response, fallback: string): Promise<T> {
  if (res.status === 401) redirectToLogin();
  return parseJson<T>(res, fallback);
}
