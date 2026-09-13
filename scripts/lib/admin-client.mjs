// @ts-check
/**
 * 管理 CLI 的 HTTP 通道（R4.1，D-4=b）：默认打本机 `/api/admin/*`，
 * `Authorization: Bearer $LUMEN_ADMIN_TOKEN`；`--offline` 才退回直写文件，
 * 且必须先探测服务确实没在跑。
 *
 * 令牌来源：进程 env 优先，其次 `--env-file <路径>`，再次按惯例依次试
 * `/opt/genius/.env`（服务器）与 `./.env.local`（本机开发）。
 * 服务地址：`LUMEN_ADMIN_BASE_URL`，默认 `http://127.0.0.1:3000`。
 * 令牌通道只在 loopback 链路生效（XFF 缺失或全 loopback + loopback host；
 * 判据见 `src/lib/admin-token.ts`），把 BASE_URL 指向远端没有用处。
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

/**
 * 把 `--env-file <路径>` 从 argv 里摘出来（它是所有管理 CLI 的公共参数，
 * 留在 argv 里会被各脚本的位置参数解析误吞）。
 * @param {string[]} argv
 * @returns {{ envFile: string | null, argv: string[] }}
 */
export function splitAdminArgs(argv) {
  /** @type {string[]} */
  const rest = [];
  /** @type {string | null} */
  let envFile = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--env-file") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        process.stderr.write("--env-file 需要一个文件路径\n");
        process.exit(1);
      }
      envFile = value;
    } else {
      rest.push(/** @type {string} */ (argv[i]));
    }
  }
  return { envFile, argv: rest };
}

export function adminBaseUrl() {
  return (process.env.LUMEN_ADMIN_BASE_URL?.trim() || "http://127.0.0.1:3000").replace(/\/+$/, "");
}

/**
 * 读令牌：env → --env-file → /opt/genius/.env → ./.env.local。
 * 只认 `LUMEN_ADMIN_TOKEN=` 整行，不解析引号转义（.env 里不需要）。
 * @param {string | null} envFile
 */
export async function readAdminToken(envFile) {
  const fromEnv = process.env.LUMEN_ADMIN_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const candidates = envFile ? [envFile] : ["/opt/genius/.env", ".env.local"];
  for (const file of candidates) {
    try {
      const raw = await readFile(file, "utf8");
      const match = raw.match(/^\s*LUMEN_ADMIN_TOKEN\s*=\s*["']?([^"'\r\n]+?)["']?\s*$/m);
      if (match?.[1]) return match[1];
    } catch {
      // 文件不存在就读下一个候选。
    }
  }
  return null;
}

/**
 * @param {string} message
 * @returns {never}
 */
export function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * POST 一条管理接口，返回解析后的 JSON。失败一律非零退出并把服务端
 * `error.code`/`error.message` 带到 stderr。
 * @param {string | null} envFile
 * @param {string} pathname
 * @param {Record<string, unknown>} body
 */
export async function adminPost(envFile, pathname, body) {
  const token = await readAdminToken(envFile);
  if (!token) {
    die("未配置 LUMEN_ADMIN_TOKEN：放进环境变量、--env-file 指定的文件、/opt/genius/.env 或 ./.env.local");
  }
  let res;
  try {
    res = await fetch(`${adminBaseUrl()}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    die(`连不上服务（${adminBaseUrl()}）：${e instanceof Error ? e.message : String(e)}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data && typeof data === "object" ? /** @type {any} */ (data).error : null;
    const suffix = err?.code === "unauthorized" ? "（令牌不对或服务端未配 LUMEN_ADMIN_TOKEN）" : "";
    die(`请求失败 ${res.status}${err?.code ? ` ${err.code}` : ""}${err?.message ? `：${err.message}` : ""}${suffix}`);
  }
  return data;
}

/**
 * `--offline` 的真互斥（D-4）：探测 `GET /api/health`，**只有 ECONNREFUSED**
 * 才说明服务没在跑、允许直写文件；能连上或报别的错一律拒绝——连得上但
 * 不是本服务（端口被占）时直写同样危险。
 */
export async function assertServiceStopped() {
  try {
    await fetch(`${adminBaseUrl()}/api/health`, { signal: AbortSignal.timeout(3_000) });
  } catch (e) {
    const code = e && typeof e === "object" ? /** @type {any} */ (e).cause?.code ?? /** @type {any} */ (e).code : undefined;
    if (code === "ECONNREFUSED") return;
    die(`探测服务状态失败（${adminBaseUrl()}/api/health）：${e instanceof Error ? e.message : String(e)}；不确定服务是否停了就不许直写`);
  }
  die(`服务在跑（${adminBaseUrl()}/api/health 可连），请不带 --offline 走管理接口`);
}
