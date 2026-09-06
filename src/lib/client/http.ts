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

type ErrorEnvelope = { error?: { code?: string; message?: string } };

/** `{error:{code,message}}` in, `ApiError` out. Leaves 401 to the caller. */
export async function parseJson<T>(res: Response, fallback: string): Promise<T> {
  const data = (await res.json().catch(() => null)) as (T & ErrorEnvelope) | null;
  if (!res.ok) throw new ApiError(data?.error?.message ?? fallback, res.status, data?.error?.code);
  return data as T;
}

/** Same, for routes that require a session: a 401 sends the browser to `/login`. */
export async function parseAuthed<T>(res: Response, fallback: string): Promise<T> {
  if (res.status === 401) redirectToLogin();
  return parseJson<T>(res, fallback);
}
