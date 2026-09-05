import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("round-trips a password and rejects the wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(stored).not.toContain("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batter", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("uses a fresh salt per hash", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("normalizes unicode so an equivalent encoding still verifies", async () => {
    const stored = await hashPassword("mañana-2026");
    expect(await verifyPassword("mañana-2026", stored)).toBe(true);
  });

  it("returns false instead of throwing on malformed or hostile stored hashes", async () => {
    const cases = [
      "",
      "not-a-hash",
      "scrypt$16384$8$1$deadbeef",
      "scrypt$16384$8$1$zz$deadbeef",
      "bcrypt$16384$8$1$aa$bb",
      // N is not a power of two.
      "scrypt$16385$8$1$aa$bb",
      // 128 · N · r would be 4 GiB.
      "scrypt$1048576$32$1$aa$bb",
    ];
    for (const stored of cases) {
      expect(await verifyPassword("whatever", stored)).toBe(false);
    }
  });
});
