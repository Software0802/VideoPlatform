/**
 * 管理员 CLI 共用的用户存储读写（`reset-password.mjs` / `disable-user.mjs` / `usage.mjs`）。
 *
 * ⚠️ 与服务端逐字对应，`.mjs` 无法 import TypeScript：
 * - 口令散列格式 = `src/lib/users/password.ts` 的 `scrypt$N$r$p$saltHex$hashHex`，
 *   参数 N=16384 / r=8 / p=1 / keylen=64 / 盐 16 字节 / 口令先 `normalize("NFKC")`；
 * - 原子写 = `src/lib/storage/atomic-json.ts` 的临时文件 + rename；
 * - 邮箱 → id 的解析 = `src/lib/users/store.ts` 的「先查 index.json，未命中就扫目录，
 *   同一邮箱多条记录时最早创建的算数」。
 * 改动任何一边都必须同步改另一边。
 *
 * ⚠️ 已知限制（与 `scripts/grant-balance.mjs` 头部那条同源）：这些 CLI 与线上服务之间
 * **没有跨进程锁**。服务端的 `withUserLock` 只在那个进程内串行，管不到脚本；两边都是
 * 「读 user.json → 改字段 → 原子替换」，所以改密 / 停用的同一瞬间若恰好发生同一用户的
 * 扣款，后写的那次会覆盖先写的整份记录。缓解办法就是错开时间——内测规模下「跑之前看
 * 一眼没人在用」就够了。
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

export const USER_ID_RE = /^usr_[0-9a-f]{16}$/;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export function resolveDataDir() {
  return path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
}

export function usersDirOf(dataDir) {
  return path.join(dataDir, "users");
}

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** 与服务端同款：临时文件 + rename 原子替换。 */
export async function writeJsonAtomic(destination, value) {
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function normalizeEmail(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

/**
 * 邮箱 → 用户 id。index.json 只是派生缓存（服务端会自愈），它没命中就照样扫一遍目录——
 * 失败的正确原因只能是「这个人真的没注册」。
 */
export async function findUserIdByEmail(usersDir, email) {
  const wanted = normalizeEmail(email);
  const index = await readJson(path.join(usersDir, "index.json"));
  const indexed = index && typeof index === "object" ? index[wanted] : undefined;
  if (typeof indexed === "string" && USER_ID_RE.test(indexed)) return indexed;

  const users = await listUsers(usersDir);
  const hits = users.filter((user) => normalizeEmail(user.email) === wanted);
  if (!hits.length) return null;
  // 与服务端 buildFromDisk 同一个判据：万一两条记录抢同一个邮箱，最早创建的算数。
  hits.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  return hits[0].id;
}

/** 读出全部用户记录（跳过读不出来的）。目录不存在时返回空数组。 */
export async function listUsers(usersDir) {
  let names = [];
  try {
    names = await readdir(usersDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => USER_ID_RE.test(n))) {
    const user = await readJson(path.join(usersDir, name, "user.json"));
    if (user && user.id === name) out.push(user);
  }
  return out;
}

export function userFileOf(usersDir, userId) {
  if (!USER_ID_RE.test(userId)) throw new Error(`非法用户 id: ${userId}`);
  return path.join(usersDir, userId, "user.json");
}

/** 口令散列，格式与 `src/lib/users/password.ts` 的 `hashPassword` 逐字一致。 */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(String(password).normalize("NFKC"), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R + 1024 * 1024,
  });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("hex"), key.toString("hex")].join("$");
}

/**
 * 自检：脚本生成的散列必须能被同一套参数验回来。
 *
 * 存在的理由是这份实现是**抄**过去的：抄错一个参数（比如漏掉 NFKC）不会报错，只会
 * 生成一个服务端永远验不过的散列，而管理员要等用户回来说「登不上」才知道。
 */
export async function verifyPassword(password, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltHex, keyHex] = parts;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");
  const candidate = await scrypt(String(password).normalize("NFKC"), salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) + 1024 * 1024,
  });
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/**
 * 随机口令。字母表去掉了会看错的字符（0/O、1/l/I），因为这串东西要靠人念或抄一次。
 * 用拒绝采样而不是 `% 字母表长度`，免得靠前的字符出现概率更高。
 */
const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 12) {
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

/**
 * 读 → 改 → 原子写，并把 `updatedAt` 刷新到现在。
 *
 * `mutate` 收到的是记录的浅拷贝，返回改完的那份；返回 `null` 表示不写。
 */
export async function updateUser(usersDir, userId, mutate) {
  const file = userFileOf(usersDir, userId);
  const user = await readJson(file);
  if (!user || user.id !== userId) throw new Error(`用户记录损坏: ${file}`);
  const next = mutate({ ...user });
  if (!next) return null;
  const written = { ...next, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(file, written);
  return written;
}

/**
 * `sessionEpoch` 加一 = 撤销这个账号已签发的所有会话。
 *
 * 与服务端 `revokeUserSessions` 同一个机制：epoch 是签名会话载荷的一部分，
 * `sessionUser` 每次请求都拿它与 `user.json` 对一次，对不上就当没登录。
 */
export function bumpEpoch(user) {
  const current = Number.isInteger(user.sessionEpoch) && user.sessionEpoch >= 1 ? user.sessionEpoch : 1;
  return { ...user, sessionEpoch: current + 1 };
}

/** 用法错误统一出口：说明写 stderr，退出码非 0。 */
export function usage(message, howto) {
  process.stderr.write(`${message}\n用法: ${howto}\n`);
  process.exit(1);
}

/** `--flag value` 取值；没有这个 flag 返回 undefined，有 flag 没值就报用法错误。 */
export function optionValue(argv, flag, howto) {
  const at = argv.indexOf(flag);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) usage(`${flag} 需要一个值`, howto);
  return value;
}
