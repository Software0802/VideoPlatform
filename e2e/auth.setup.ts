import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as setup, type APIRequestContext } from "@playwright/test";
import { dataDirCandidates, newInviteCode, writeInvite } from "./invites";
import { DATA_DIR_HINT, STORAGE_STATE } from "./paths";

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

  await mkdir(path.dirname(STORAGE_STATE), { recursive: true });
  await request.storageState({ path: STORAGE_STATE });
  // Hand the winning dir to `auth.spec.ts`, which mints its own code for the
  // sign-up flow and must not have to guess.
  await writeFile(DATA_DIR_HINT, liveDataDir, "utf8");
});
