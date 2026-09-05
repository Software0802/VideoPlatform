import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UserRecord } from "./schema";
import {
  ensureUserIndex,
  findUserByEmail,
  findUserIdByEmail,
  loadUserIndex,
  newUserId,
  readUser,
  resetUserIndexCache,
  setIndexEntry,
  userIndexPath,
  writeUser,
} from "./store";

let dataRoot = "";

async function makeUser(id: string, email: string): Promise<UserRecord> {
  const now = new Date().toISOString();
  return writeUser({
    id,
    email,
    passwordHash: "scrypt$16384$8$1$00$00",
    sessionEpoch: 1,
    plan: "free",
    createdAt: now,
    updatedAt: now,
  });
}

async function readIndex(): Promise<Record<string, string>> {
  return JSON.parse(await readFile(userIndexPath(), "utf8")) as Record<string, string>;
}

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-user-store-test-"));
  process.env.DATA_DIR = dataRoot;
  await makeUser("usr_aaaaaaaaaaaaaaaa", "a@example.com");
  await makeUser("usr_bbbbbbbbbbbbbbbb", "b@example.com");
  await setIndexEntry("a@example.com", "usr_aaaaaaaaaaaaaaaa");
  await setIndexEntry("b@example.com", "usr_bbbbbbbbbbbbbbbb");
});

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  resetUserIndexCache();
});

beforeEach(() => {
  resetUserIndexCache();
});

describe("user id and record round-trip", () => {
  it("mints ids that the record schema accepts", async () => {
    const id = newUserId();
    expect(id).toMatch(/^usr_[0-9a-f]{16}$/);
    await makeUser(id, "minted@example.com");
    expect((await readUser(id))?.email).toBe("minted@example.com");
    await rm(path.join(dataRoot, "users", id), { recursive: true, force: true });
    resetUserIndexCache();
  });

  it("refuses ids that could escape the users directory", async () => {
    expect(await readUser("../jobs")).toBeNull();
    expect(await readUser("usr_../../etc")).toBeNull();
  });
});

describe("index.json is a derived cache", () => {
  it("rebuilds after the file is deleted", async () => {
    await rm(userIndexPath(), { force: true });
    resetUserIndexCache();

    const map = await loadUserIndex();
    expect(map.get("a@example.com")).toBe("usr_aaaaaaaaaaaaaaaa");
    expect(map.get("b@example.com")).toBe("usr_bbbbbbbbbbbbbbbb");
    expect(await readIndex()).toEqual({
      "a@example.com": "usr_aaaaaaaaaaaaaaaa",
      "b@example.com": "usr_bbbbbbbbbbbbbbbb",
    });
  });

  it("rebuilds after the file is corrupted", async () => {
    await writeFile(userIndexPath(), "{ this is not json", "utf8");
    resetUserIndexCache();

    expect(await findUserIdByEmail("b@example.com")).toBe("usr_bbbbbbbbbbbbbbbb");
    expect(await readIndex()).toHaveProperty("a@example.com");
  });

  it("rebuilds when the shape is wrong", async () => {
    await writeFile(userIndexPath(), JSON.stringify({ "a@example.com": 42 }), "utf8");
    resetUserIndexCache();

    expect((await loadUserIndex()).size).toBe(2);
  });

  it("heals an index that lost an entry after a crash between the two writes", async () => {
    await writeFile(
      userIndexPath(),
      JSON.stringify({ "a@example.com": "usr_aaaaaaaaaaaaaaaa" }),
      "utf8",
    );
    resetUserIndexCache();

    // b/user.json exists but the index never learned about it (plan §2 table).
    const user = await findUserByEmail("b@example.com");
    expect(user?.id).toBe("usr_bbbbbbbbbbbbbbbb");
    expect(await readIndex()).toHaveProperty("b@example.com", "usr_bbbbbbbbbbbbbbbb");
  });

  it("drops entries whose user directory is gone", async () => {
    await writeFile(
      userIndexPath(),
      JSON.stringify({
        "a@example.com": "usr_aaaaaaaaaaaaaaaa",
        "b@example.com": "usr_bbbbbbbbbbbbbbbb",
        "ghost@example.com": "usr_cccccccccccccccc",
      }),
      "utf8",
    );
    resetUserIndexCache();

    expect(await findUserIdByEmail("ghost@example.com")).toBeUndefined();
    expect(await readIndex()).not.toHaveProperty("ghost@example.com");
  });

  it("verifies the index at startup", async () => {
    await rm(userIndexPath(), { force: true });
    await ensureUserIndex();
    expect(Object.keys(await readIndex()).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("matches emails case-insensitively", async () => {
    expect(await findUserIdByEmail("  A@Example.com ")).toBe("usr_aaaaaaaaaaaaaaaa");
  });
});
