export type ByteRange = { start: number; end: number };

/** Parse a single RFC 7233 Range on a known size. Returns null → 416. */
export function parseByteRange(header: string, size: number): ByteRange | null {
  if (size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const left = m[1];
  const right = m[2];
  if (left === "" && right === "") return null;

  let start: number;
  let end: number;
  if (left === "") {
    const suffix = Number(right);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(left);
    end = right === "" ? size - 1 : Number(right);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  }
  if (start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}
