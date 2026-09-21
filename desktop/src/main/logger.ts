import { appendFileSync, chmodSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";

const SENSITIVE_KEY = /authorization|token|secret|account.*(?:id|key|handle)|session.*id/i;
const MAX_DEPTH = 6;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("log fields must contain finite numbers");
    return value;
  }
  if (typeof value === "string") return value.slice(0, 2_000);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError("log fields must contain only plain JSON values");
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100)
    .map(([key, item]) => [key.slice(0, 100), SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, depth + 1)]));
}

export interface DesktopLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createDesktopLogger(path: string): DesktopLogger {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, "a", 0o600);
  closeSync(descriptor);
  chmodSync(path, 0o600);
  const write = (level: "info" | "warn" | "error", event: string,
    fields: Record<string, unknown> = {}) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(event)) throw new TypeError("invalid log event");
    const safeFields = sanitize(fields);
    appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), level, event,
      fields: safeFields })}\n`, { encoding: "utf8", mode: 0o600 });
  };
  return { info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields) };
}
