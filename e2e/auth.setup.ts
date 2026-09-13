import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test as setup, type APIRequestContext } from "@playwright/test";
import { dataDirCandidates, newInviteCode, writeInvite } from "./invites";
import { DATA_DIR_HINT, E2E_ADMIN_TOKEN, STORAGE_STATE } from "./paths";

/**
 * Every `/api/*` route now needs a session (plan §4), so the smoke suite has to
 * arrive logged in. This project runs before the others and leaves the cookie in
 * `storageState`, which `playwright.config.ts` hands to the chromium project.
 *
 * There is deliberately no test-only bypass in the server: the account is created
 * through the real `POST /api/auth/register`. The one thing that cannot go over
 * HTTP is minting an invite code (by design — see plan §4), so the setup writes
 * an invite file straight into the server's `data/invites/`.
 *
 * Which data dir that is depends on how the server was started, and a reused dev
 * server keeps its own (see the config's note). So the candidates are tried in
 * order and an invite the server did not see is deleted again, leaving no unused
 * code behind.
 */

// Fresh credentials every run. A reused dev server keeps its real `data/`, and a
// fixed email + password would leave an account anyone with the source could log
// into. Random ones are unguessable, and the cookie is all the suite needs.
const EMAIL = `e2e-${randomBytes(6).toString("hex")}@lumen.test`;
const PASSWORD = randomBytes(18).toString("base64url");

async function mintInvite(dataDir: string): Promise<{ code: string; file: string }> {
  const code = newInviteCode();
  return { code, file: await writeInvite(dataDir, code) };
}

/**
 * 余额模型（方案 §3.2）上线后，新账号只有注册赠送的 ¥5，跑不完整套用例——冒烟要真的
 * 出片，就得先充值。R4.1 起管理 CLI 默认走 HTTP 管理接口（`--offline` 直写文件要求
 * 服务确实没在跑，而这里服务正在跑），所以这里调真正的 CLI + 管理令牌：既省掉一份
 * 重复的落盘逻辑，也顺带在每次 e2e 里验证令牌通道还能跑。
 * 复用 dev server 时它自己的 env 里必须有同一个 LUMEN_ADMIN_TOKEN。
 */
async function fundAccount(): Promise<void> {
  const script = path.resolve(__dirname, "../scripts/grant-balance.mjs");
  const base = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? 3000}`;
  // --ref 让 setup 重跑同一账号时不重复入账（同 ref 重放返回原记录）。
  await promisify(execFile)(
    process.execPath,
    [script, EMAIL, "1000", "--ref", `e2e-fund:${EMAIL}`, "--note", "playwright e2e"],
    {
      env: {
        ...process.env,
        LUMEN_ADMIN_TOKEN: E2E_ADMIN_TOKEN,
        LUMEN_ADMIN_BASE_URL: base,
      },
    },
  );
}

async function login(request: APIRequestContext): Promise<boolean> {
  const res = await request.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD } });
  return res.ok();
}

setup("注册并登录一个 e2e 用户，Cookie 交给后续用例", async ({ request }) => {
  // Credentials are random per run, so there is never an existing account to
  // fall back to: always register fresh.
  const failures: string[] = [];
  let liveDataDir = "";
  for (const dataDir of dataDirCandidates()) {
    const invite = await mintInvite(dataDir);
    const res = await request.post("/api/auth/register", {
      data: { email: EMAIL, password: PASSWORD, inviteCode: invite.code },
    });
    if (res.ok()) {
      liveDataDir = dataDir;
      break;
    }
    // The server reads a different data dir (or refused for another reason):
    // take the unused code back out so no live invite is left lying around.
    await rm(invite.file, { force: true });
    failures.push(`${dataDir} → ${res.status()} ${await res.text()}`);
  }
  expect(
    await login(request),
    `无法为 e2e 建立会话，已尝试的 DATA_DIR：\n${failures.join("\n")}`,
  ).toBeTruthy();
  await fundAccount();

  await mkdir(path.dirname(STORAGE_STATE), { recursive: true });
  await request.storageState({ path: STORAGE_STATE });
  // Hand the winning dir to `auth.spec.ts`, which mints its own code for the
  // sign-up flow and must not have to guess.
  await writeFile(DATA_DIR_HINT, liveDataDir, "utf8");
});
