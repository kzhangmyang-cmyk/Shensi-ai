import { strict as assert } from "node:assert";
import {
  createPerformanceGenerationGuard,
  defaultPerformanceDateValues,
  isUnauthorizedPerformanceError,
  performanceFiltersFromDates,
  performanceStatusFor
} from "./performance-controller";
import { AcquisitionPerformanceApiError } from "./performance-api";

assert.deepEqual(
  performanceFiltersFromDates("2026-08-01", "2026-08-07", "douyin"),
  {
    platform: "douyin",
    from: "2026-08-01",
    to: "2026-08-07"
  }
);
assert.equal(
  performanceFiltersFromDates("2026-01-01", "2026-08-07", "").from,
  "2026-05-10",
  "the controller must clamp user date ranges to the 90-day contract"
);
assert.deepEqual(
  defaultPerformanceDateValues(new Date("2026-08-07T15:59:59.999Z")),
  { from: "2026-07-09", to: "2026-08-07" },
  "before 16:00Z the current Shanghai calendar day is unchanged"
);
assert.deepEqual(
  defaultPerformanceDateValues(new Date("2026-08-07T16:00:00.000Z")),
  { from: "2026-07-10", to: "2026-08-08" },
  "at 16:00Z Shanghai has entered the next calendar day"
);
for (const invalid of ["2026-13-01", "2026-02-30"]) {
  assert.throws(
    () => performanceFiltersFromDates(invalid, "2026-08-07", ""),
    (error: unknown) =>
      error instanceof Error
      && !(error instanceof RangeError)
      && error.message === "请选择有效的时间范围",
    `${invalid} must return the product validation error`
  );
}
assert.equal(isUnauthorizedPerformanceError(
  new AcquisitionPerformanceApiError("session expired", 401)
), true);
assert.equal(isUnauthorizedPerformanceError(
  new AcquisitionPerformanceApiError("请先登录", 503)
), false);
assert.equal(isUnauthorizedPerformanceError(new Error("upstream unavailable")), false);
assert.equal(performanceStatusFor({ discovered: 0 }), "empty");
assert.equal(performanceStatusFor({ discovered: 1 }), "ready");

const guard = createPerformanceGenerationGuard();
const first = guard.begin({
  platform: "douyin",
  from: "2026-08-01",
  to: "2026-08-07"
}, "real");
const second = guard.begin({
  platform: "web",
  from: "2026-08-01",
  to: "2026-08-07"
}, "real");
assert.equal(first.signal.aborted, true);
assert.equal(guard.isCurrent(first), false);
assert.equal(guard.isCurrent(second), true);
guard.invalidate();
assert.equal(second.signal.aborted, true);
assert.equal(guard.isCurrent(second), false);
