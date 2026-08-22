import { GrowthHttpError } from "./growth-command-context.js";

const STRICT_RFC_3339_MILLISECONDS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})(Z|([+-])(\d{2}):(\d{2}))$/u;
const MAX_FUTURE_TOLERANCE_MS = 1_000;

function invalidAsOf(): never {
  throw new GrowthHttpError(422, "invalid_as_of");
}

export function growthInstantMilliseconds(value: string): number {
  const match = STRICT_RFC_3339_MILLISECONDS.exec(value);
  if (!match) return invalidAsOf();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7]);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (
    month < 1 || month > 12
    || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
  ) {
    return invalidAsOf();
  }
  const local = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const localDate = new Date(local);
  if (
    localDate.getUTCFullYear() !== year
    || localDate.getUTCMonth() !== month - 1
    || localDate.getUTCDate() !== day
    || localDate.getUTCHours() !== hour
    || localDate.getUTCMinutes() !== minute
    || localDate.getUTCSeconds() !== second
    || localDate.getUTCMilliseconds() !== millisecond
  ) {
    return invalidAsOf();
  }
  const direction = match[9] === "-" ? -1 : 1;
  const offset = match[8] === "Z"
    ? 0
    : direction * (offsetHour * 60 + offsetMinute) * 60_000;
  const instant = local - offset;
  if (!Number.isSafeInteger(instant)) return invalidAsOf();
  return instant;
}

export function normalizeGrowthInstant(value: string): string {
  return new Date(growthInstantMilliseconds(value)).toISOString();
}

export function assertGrowthAsOfNotFuture(
  asOf: string,
  startedAt: string,
  toleranceMs = MAX_FUTURE_TOLERANCE_MS
): string {
  if (
    !Number.isSafeInteger(toleranceMs)
    || toleranceMs < 0
    || toleranceMs > MAX_FUTURE_TOLERANCE_MS
  ) {
    return invalidAsOf();
  }
  const asOfMilliseconds = growthInstantMilliseconds(asOf);
  const startedAtMilliseconds = growthInstantMilliseconds(startedAt);
  if (asOfMilliseconds > startedAtMilliseconds + toleranceMs) {
    return invalidAsOf();
  }
  return new Date(Math.min(asOfMilliseconds, startedAtMilliseconds)).toISOString();
}

export function nextGrowthRecordedAt(
  serverNow: string,
  lastRecordedAt: string,
  storageTickMs = 1
): string {
  if (storageTickMs !== 1) return invalidAsOf();
  const serverMilliseconds = growthInstantMilliseconds(serverNow);
  const lastMilliseconds = growthInstantMilliseconds(lastRecordedAt);
  const nextMilliseconds = Math.max(serverMilliseconds, lastMilliseconds + storageTickMs);
  if (!Number.isSafeInteger(nextMilliseconds)) return invalidAsOf();
  return new Date(nextMilliseconds).toISOString();
}
