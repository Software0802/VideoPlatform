import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * scrypt from node's built-in crypto — no new dependency. Parameters follow the
 * usual interactive-login profile (N = 2^14, r = 8, p = 1), which costs
 * 128 · N · r = 16 MiB of memory per verification.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/** Refuse absurd stored parameters so a tampered user.json cannot exhaust memory. */
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;
const MAX_KEY_LENGTH = 128;
/** scrypt needs 128 · N · r bytes; hard-cap the working set at 64 MiB. */
const MAX_SCRYPT_MEMORY = 64 * 1024 * 1024;

function scryptMemory(n: number, r: number): number {
  return 128 * n * r;
}

function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  keylen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      keylen,
      { N: n, r, p, maxmem: scryptMemory(n, r) + 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` — self-describing so parameters can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LENGTH);
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("hex"),
    key.toString("hex"),
  ].join("$");
}

type ParsedHash = {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
};

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || n < 2 || n > MAX_N || (n & (n - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > MAX_R) return null;
  if (!Number.isInteger(p) || p < 1 || p > MAX_P) return null;
  if (scryptMemory(n, r) > MAX_SCRYPT_MEMORY) return null;
  if (!/^[0-9a-f]+$/.test(parts[4]) || !/^[0-9a-f]+$/.test(parts[5])) return null;
  const salt = Buffer.from(parts[4], "hex");
  const key = Buffer.from(parts[5], "hex");
  if (salt.length === 0 || key.length === 0 || key.length > MAX_KEY_LENGTH) return null;
  return { n, r, p, salt, key };
}

/** Constant-time comparison of the derived key; never throws, never logs the password. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const candidate = await derive(password, parsed.salt, parsed.n, parsed.r, parsed.p, parsed.key.length);
    return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
  } catch {
    return false;
  }
}

/**
 * 随机口令。字母表去掉了会看错的字符（0/O、1/l/I）——这串东西要靠人念或
 * 抄一次；与 `scripts/lib/users-store.mjs` 的 `generatePassword` 同一字母表，
 * 用拒绝采样而不是 `% 字母表长度`。
 */
const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 12): string {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

let dummyHash: Promise<string> | undefined;

/**
 * Spend the same scrypt work when the email is unknown, so a login attempt
 * cannot be timed to tell "no such account" from "wrong password".
 */
export async function burnPasswordTiming(password: string): Promise<void> {
  dummyHash ??= hashPassword("lumen-timing-equalizer");
  await verifyPassword(password, await dummyHash);
}
