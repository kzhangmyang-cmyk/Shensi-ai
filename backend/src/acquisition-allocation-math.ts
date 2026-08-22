import { safeMinor } from "./growth-money.js";

export function allocateMinorByBps(
  amountMinor: number,
  targets: readonly {
    targetStableKey: string;
    allocationBps: number;
  }[]
) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error("allocation_amount_invalid");
  }
  if (targets.length === 0
    || targets.reduce((sum, item) => sum + item.allocationBps, 0) !== 10_000) {
    throw new Error("allocation_bps_incomplete");
  }
  const compareCodePoint = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;
  if (new Set(targets.map((item) => item.targetStableKey)).size
    !== targets.length) {
    throw new Error("allocation_target_duplicate");
  }
  const amount = BigInt(amountMinor);
  const rows = targets.map((item) => {
    if (!item.targetStableKey
      || !Number.isSafeInteger(item.allocationBps)
      || item.allocationBps < 0
      || item.allocationBps > 10_000) {
      throw new Error("allocation_target_invalid");
    }
    const numerator = amount * BigInt(item.allocationBps);
    return {
      targetStableKey: item.targetStableKey,
      amountMinor: numerator / 10_000n,
      remainder: numerator % 10_000n
    };
  });
  let remaining = amount - rows.reduce(
    (sum, item) => sum + item.amountMinor, 0n
  );
  for (const row of [...rows].sort((a, b) =>
    a.remainder === b.remainder
      ? compareCodePoint(a.targetStableKey, b.targetStableKey)
      : a.remainder > b.remainder ? -1 : 1)) {
    if (remaining === 0n) break;
    row.amountMinor += 1n;
    remaining -= 1n;
  }
  return rows
    .sort((a, b) => compareCodePoint(a.targetStableKey, b.targetStableKey))
    .map(({ targetStableKey, amountMinor: value }) => ({
      targetStableKey,
      amountMinor: safeMinor(value, "allocatedAmountMinor")
    }));
}
