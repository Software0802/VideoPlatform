import { describe, expect, it } from "vitest";
import { parseByteRange } from "./range";

describe("parseByteRange", () => {
  it("parses inclusive start-end", () => {
    expect(parseByteRange("bytes=0-499", 1000)).toEqual({ start: 0, end: 499 });
    expect(parseByteRange("bytes=500-999", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("open-ended range goes to last byte", () => {
    expect(parseByteRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("suffix range is the last N bytes (RFC 7233)", () => {
    expect(parseByteRange("bytes=-500", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseByteRange("bytes=-1", 1000)).toEqual({ start: 999, end: 999 });
    expect(parseByteRange("bytes=-2000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("rejects unsatisfiable and malformed ranges", () => {
    expect(parseByteRange("bytes=1000-1001", 1000)).toBeNull();
    expect(parseByteRange("bytes=20-10", 1000)).toBeNull();
    expect(parseByteRange("bytes=-", 1000)).toBeNull();
    expect(parseByteRange("bytes=abc-1", 1000)).toBeNull();
    expect(parseByteRange("items=0-1", 1000)).toBeNull();
  });
});
