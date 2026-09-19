import path from "node:path";

/**
 * Where `auth.setup.ts` leaves the logged-in cookie for the other projects.
 * Kept in its own module because `playwright.config.ts` needs the value too, and
 * importing a file that calls `test()` from the config is not allowed.
 *
 * Deliberately outside `test-results/`: that directory is wiped at the start of
 * a run, and it also holds the isolated `DATA_DIR`.
 */
export const STORAGE_STATE = path.join(__dirname, ".auth/session.json");

/**
 * 服务跑在哪个端口，以及浏览器与管理 CLI 都该打的地址。
 *
 * 一份推导，四个调用点（`playwright.config.ts` 的 `baseURL`/`webServer`，以及
 * `auth.setup.ts` / `genius.spec.ts` / `subscription.spec.ts` 里调管理 CLI 的
 * `LUMEN_ADMIN_BASE_URL`）。之前这段是各处手抄的，`subscription.spec.ts` 那份
 * 干脆没抄、改传 `--offline` 直写文件——`--offline` 要求服务确实没在跑，于是
 * 本机（挪开 `E2E_PORT`，3000 空着）绿、CI（不设 `E2E_PORT`，服务正在 3000）红，
 * 定时 e2e 连红六次。共用一个函数就没有「某一处没跟上」的余地。
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3000);

export function e2eBaseUrl(): string {
  return process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;
}

/**
 * Which `DATA_DIR` the running server turned out to read, written by
 * `auth.setup.ts` once registration succeeded. Other specs need it to mint an
 * invite the server will actually see.
 */
export const DATA_DIR_HINT = path.join(__dirname, ".auth/data-dir.txt");

/**
 * 管理 CLI 走 HTTP 后（R4.1），`auth.setup.ts` 的充值需要服务端也配同一个
 * 令牌。固定的 e2e 专用值，和生产令牌一样是「不进聊天记录的随机串」级别
 * 之外的例外：它只出现在 Playwright 自起的服务进程与测试进程里。
 */
export const E2E_ADMIN_TOKEN = "e2e-only-admin-token-not-for-production";

/**
 * 与 webServer env 的 `LUMEN_SESSION_SECRET` 同值（playwright.config.ts）。固定 e2e 专用值，
 * `admin.spec.ts` 用它给 file-seeded 的管理员账号算会话签名——服务只认这个 HMAC，
 * 换用 dev server 自己的 secret 时该 spec 会整组 skip（cookie 验签失败 → /api/me 401）。
 */
export const E2E_SESSION_SECRET = "e2e-only-session-secret-not-for-production";

/**
 * `LUMEN_ADMIN_USER_ID` 的 e2e 固定值（`usr_` + 16 hex）。管理员账号是
 * `admin.spec.ts` 直接写进 `data/users/` 的 user.json——用户索引是 email→id 的
 * 派生缓存且按进程缓存，中途文件播种不可见；会话只按 id 读 user.json，不走索引，
 * 所以这条路不需要注册流程。复用的 dev server 需自带同名 env。
 */
export const E2E_ADMIN_USER_ID = "usr_e2ead0000000000a";
