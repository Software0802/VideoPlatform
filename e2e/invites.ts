import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR_HINT } from "./paths";

/**
 * Minting an invite is the one thing that deliberately cannot go over HTTP
 * (plan §4), so the suite writes the file straight into the server's
 * `data/invites/`. Shared by `auth.setup.ts` (API registration) and
 * `auth.spec.ts` (registration through the login page).
 */

const REPO_ROOT = path.resolve(__dirname, "..");

/** Keep in sync with `src/lib/users/schema.ts` (no I/L/O/U). */
const INVITE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Which data dir the server reads depends on how it was started: Playwright's
 * own server gets `DATA_DIR`, a reused dev server keeps whatever it had. Most
 * likely first.
 */
export function dataDirCandidates(): string[] {
  const raw = [
    process.env.E2E_DATA_DIR,
    path.join(REPO_ROOT, "test-results/e2e-data"),
    process.env.DATA_DIR,
    path.join(REPO_ROOT, "data"),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(raw.map((dir) => path.resolve(dir)))];
}

export function newInviteCode(): string {
  let out = "";
  for (const byte of randomBytes(12)) out += INVITE_ALPHABET[byte & 31];
  return out;
}

export async function writeInvite(dataDir: string, code: string): Promise<string> {
  const file = path.join(dataDir, "invites", `${code}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ code, createdAt: new Date().toISOString(), note: "playwright e2e" }),
  );
  return file;
}

/**
 * The dir `auth.setup.ts` proved the server actually reads. Without it we would
 * have to scatter live invite codes across every candidate — including the
 * developer's real `data/` — just to find out which one counts.
 */
export async function serverDataDir(): Promise<string> {
  const hint = await readFile(DATA_DIR_HINT, "utf8").then(
    (value) => value.trim(),
    () => "",
  );
  return hint || dataDirCandidates()[0];
}
