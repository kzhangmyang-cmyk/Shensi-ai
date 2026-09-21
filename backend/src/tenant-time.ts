function zonedWallClockUtc(timeZone: string, utcMilliseconds: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date(utcMilliseconds));
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour") % 24,
    value("minute"),
    value("second")
  );
}

function offsetAt(timeZone: string, utcMilliseconds: number): number {
  return zonedWallClockUtc(timeZone, utcMilliseconds) - utcMilliseconds;
}

function resolveZonedWallClock(
  timeZone: string,
  wallUtc: number
): number | null {
  const candidates = new Set<number>();
  for (const probe of [
    wallUtc - 43_200_000,
    wallUtc,
    wallUtc + 43_200_000
  ]) {
    const offset = offsetAt(timeZone, probe);
    const candidate = wallUtc - offset;
    if (zonedWallClockUtc(timeZone, candidate) === wallUtc) {
      candidates.add(candidate);
    }
  }
  if (candidates.size !== 1) return null;
  const [resolved] = candidates;
  return resolved!;
}

/**
 * Resolve a business timestamp string against the trusted tenant time zone.
 *
 * - Date-only values (`YYYY-MM-DD`) resolve at 00:00:00 in the tenant zone.
 * - Wall-clock values without an explicit zone (`YYYY-MM-DD HH:mm:ss`) are
 *   interpreted in the tenant zone.
 * - Values carrying an explicit `Z` or `±HH:MM` offset parse independently.
 *
 * DST gaps and ambiguous wall times return null instead of guessing.
 */
export function resolveTenantBusinessInstant(
  value: string,
  timeZone: string
): string | null {
  const normalized = value.trim();
  const wall = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/u
    .exec(normalized);
  if (wall) {
    const wallUtc = Date.UTC(
      Number(wall[1]),
      Number(wall[2]) - 1,
      Number(wall[3]),
      Number(wall[4] ?? 0),
      Number(wall[5] ?? 0),
      Number(wall[6] ?? 0)
    );
    const resolved = resolveZonedWallClock(timeZone, wallUtc);
    return resolved === null ? null : new Date(resolved).toISOString();
  }
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

export function isDateOnlyBusinessValue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value.trim());
}
