import assert from "node:assert/strict";
import test from "node:test";
import { allocateMinorByBps } from "./acquisition-allocation-math.js";

test("largest remainder preserves every minor unit", () => {
  assert.deepEqual(allocateMinorByBps(10, [
    { targetStableKey: "b", allocationBps: 3333 },
    { targetStableKey: "a", allocationBps: 3333 },
    { targetStableKey: "c", allocationBps: 3334 }
  ]), [
    { targetStableKey: "a", amountMinor: 3 },
    { targetStableKey: "b", amountMinor: 3 },
    { targetStableKey: "c", amountMinor: 4 }
  ]);
});

test("equal fractional remainders break ties lexically", () => {
  assert.deepEqual(allocateMinorByBps(1, [
    { targetStableKey: "z", allocationBps: 5000 },
    { targetStableKey: "a", allocationBps: 5000 }
  ]), [
    { targetStableKey: "a", amountMinor: 1 },
    { targetStableKey: "z", amountMinor: 0 }
  ]);
});

test("code-point order is locale-independent and duplicate targets fail closed", () => {
  assert.deepEqual(allocateMinorByBps(1, [
    { targetStableKey: "é", allocationBps: 5000 },
    { targetStableKey: "Z", allocationBps: 5000 }
  ]), [
    { targetStableKey: "Z", amountMinor: 1 },
    { targetStableKey: "é", amountMinor: 0 }
  ]);
  assert.throws(() => allocateMinorByBps(1, [
    { targetStableKey: "same", allocationBps: 5000 },
    { targetStableKey: "same", allocationBps: 5000 }
  ]), /allocation_target_duplicate/);
});

test("allocated sum always equals the input across a property sweep", () => {
  for (let amount = 0; amount <= 10_000; amount += 1) {
    const allocated = allocateMinorByBps(amount, [
      { targetStableKey: "a", allocationBps: 3333 },
      { targetStableKey: "b", allocationBps: 3333 },
      { targetStableKey: "c", allocationBps: 3334 }
    ]);
    assert.equal(
      allocated.reduce((sum, item) => sum + item.amountMinor, 0),
      amount
    );
  }
});
