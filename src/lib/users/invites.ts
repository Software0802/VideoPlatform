import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";
import {
  INVITE_ALPHABET,
  INVITE_CODE_LENGTH,
  INVITE_CODE_RE,
  inviteRecordSchema,
  normalizeInviteCode,
  type InviteRecord,
} from "@/lib/users/schema";

export function invitesDir(): string {
  return path.join(dataDir(), "invites");
}

export function invitePath(code: string): string {
  if (!INVITE_CODE_RE.test(code)) throw new Error("invalid invite code");
  return path.join(invitesDir(), `${code}.json`);
}

/**
 * 12 symbols drawn uniformly from a 32-char alphabet (60 bits). 256 % 32 === 0,
 * so masking a random byte stays uniform — no rejection loop needed.
 */
export function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  let out = "";
  for (const byte of bytes) out += INVITE_ALPHABET[byte & 31];
  return out;
}

export async function readInvite(rawCode: string): Promise<InviteRecord | null> {
  const code = normalizeInviteCode(rawCode);
  if (!INVITE_CODE_RE.test(code)) return null;
  try {
    const raw = await readFile(invitePath(code), "utf8");
    const parsed = inviteRecordSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.code !== code) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export async function writeInvite(record: InviteRecord): Promise<InviteRecord> {
  const parsed = inviteRecordSchema.parse(record);
  await writeJsonAtomic(invitePath(parsed.code), parsed);
  return parsed;
}

/** Mint one unused code. Callers must not print it anywhere but the operator's terminal. */
export async function createInvite(note?: string): Promise<InviteRecord> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateInviteCode();
    if (await readInvite(code)) continue;
    return writeInvite({
      code,
      createdAt: new Date().toISOString(),
      ...(note ? { note } : {}),
    });
  }
  throw new Error("invite code generation failed");
}

/**
 * True when the code exists and has not been consumed. The caller checks this
 * inside `withUserLock` and marks it used in the same critical section, so two
 * concurrent registrations with one code cannot both pass.
 */
export function isInviteUsable(invite: InviteRecord | null): invite is InviteRecord {
  return Boolean(invite && !invite.usedBy);
}

export async function markInviteUsed(invite: InviteRecord, userId: string): Promise<InviteRecord> {
  return writeInvite({ ...invite, usedBy: userId, usedAt: new Date().toISOString() });
}
