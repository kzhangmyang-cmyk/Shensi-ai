const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;

function calendarDayMs(value: string) {
  if (!DATE_ONLY.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

export function normalizeShanghaiPerformanceWindow(input: {
  from: string;
  to: string;
}):
  | {
      ok: true;
      value: {
        fromInclusiveUtc: string;
        toInclusiveUtc: string;
      };
    }
  | {
      ok: false;
      issue: {
        field: "from" | "to";
        message: string;
      };
    } {
  const fromDay = calendarDayMs(input.from);
  if (fromDay === null) {
    return {
      ok: false,
      issue: {
        field: "from",
        message: "must be a real calendar date in YYYY-MM-DD form"
      }
    };
  }
  const toDay = calendarDayMs(input.to);
  if (toDay === null) {
    return {
      ok: false,
      issue: {
        field: "to",
        message: "must be a real calendar date in YYYY-MM-DD form"
      }
    };
  }
  if (fromDay > toDay) {
    return {
      ok: false,
      issue: { field: "from", message: "from must not be after to" }
    };
  }
  if ((toDay - fromDay) / DAY_MS >= 90) {
    return {
      ok: false,
      issue: { field: "to", message: "performance window cannot exceed 90 days" }
    };
  }
  return {
    ok: true,
    value: {
      fromInclusiveUtc: new Date(fromDay - SHANGHAI_OFFSET_MS).toISOString(),
      toInclusiveUtc: new Date(
        toDay + DAY_MS - SHANGHAI_OFFSET_MS - 1
      ).toISOString()
    }
  };
}
