export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, message: string, extra?: Record<string, unknown>) {
  const line = {
    t: new Date().toISOString(),
    level,
    message,
    ...extra,
  };
  const s = JSON.stringify(line);
  if (level === "error") console.error(s);
  else if (level === "warn") console.warn(s);
  else console.log(s);
}
