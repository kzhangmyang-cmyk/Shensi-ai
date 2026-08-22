import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertGrowthAsOfNotFuture,
  nextGrowthRecordedAt
} from "./growth-as-of.js";

test("one server-owned as-of boundary permits only the frozen one-second tolerance", () => {
  assert.equal(
    assertGrowthAsOfNotFuture(
      "2026-08-09T08:00:01.000Z",
      "2026-08-09T08:00:00.000Z"
    ),
    "2026-08-09T08:00:00.000Z"
  );
  assert.throws(
    () => assertGrowthAsOfNotFuture(
      "2026-08-09T08:00:01.001Z",
      "2026-08-09T08:00:00.000Z"
    ),
    (error: unknown) => (error as { status?: number; code?: string }).status === 422
      && (error as { code?: string }).code === "invalid_as_of"
  );
});

test("as-of accepts only strict RFC 3339 instants and normalizes offsets to milliseconds", () => {
  assert.equal(
    assertGrowthAsOfNotFuture(
      "2026-08-09T16:00:00.000+08:00",
      "2026-08-09T08:00:00.500Z"
    ),
    "2026-08-09T08:00:00.000Z"
  );
  for (const invalid of [
    "2026-08-09 08:00:00Z",
    "2026-08-09T08:00:00Z",
    "2026-08-09T08:00:00.000",
    "2026-02-30T08:00:00.000Z"
  ]) {
    assert.throws(
      () => assertGrowthAsOfNotFuture(invalid, "2026-08-09T08:00:00.000Z"),
      (error: unknown) => (error as { code?: string }).code === "invalid_as_of"
    );
  }
});

test("callers cannot enlarge the frozen future tolerance", () => {
  assert.throws(
    () => assertGrowthAsOfNotFuture(
      "2026-08-09T08:00:01.001Z",
      "2026-08-09T08:00:00.000Z",
      1_001
    ),
    (error: unknown) => (error as { code?: string }).code === "invalid_as_of"
  );
});

test("recorded time advances one persisted tick after the last event", () => {
  assert.equal(
    nextGrowthRecordedAt(
      "2026-08-09T08:00:00.000Z",
      "2026-08-09T09:00:00.000Z"
    ),
    "2026-08-09T09:00:00.001Z"
  );
  assert.equal(
    nextGrowthRecordedAt(
      "2026-08-09T10:00:00.000Z",
      "2026-08-09T09:00:00.000Z"
    ),
    "2026-08-09T10:00:00.000Z"
  );
});

test("recorded time rejects sub-millisecond inputs and nonstandard storage ticks", () => {
  assert.throws(() => nextGrowthRecordedAt(
    "2026-08-09T08:00:00.000001Z",
    "2026-08-09T08:00:00.000Z"
  ));
  assert.throws(() => nextGrowthRecordedAt(
    "2026-08-09T08:00:00.000Z",
    "2026-08-09T08:00:00.000Z",
    2
  ));
});
