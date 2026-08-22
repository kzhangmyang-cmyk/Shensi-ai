import type { AttributionAllocationLifecycleEvent } from "./acquisition-attribution-allocation.js";

export function activeAttributionSetIdAsOf(
  events: readonly AttributionAllocationLifecycleEvent[],
  asOf: string
): string | null {
  const recorded = events
    .filter((event) => event.recordedAt <= asOf)
    .sort((a, b) => a.eventSequence - b.eventSequence);
  for (const [index, event] of recorded.entries()) {
    if (event.eventSequence !== index + 1
      || event.revision !== index + 1) {
      throw new Error("attribution_history_invalid");
    }
  }
  let activeSetId: string | null = null;
  const effective = recorded
    .filter((event) => event.effectiveAt <= asOf)
    .sort((a, b) =>
      a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : 0
      || a.eventSequence - b.eventSequence);
  for (const event of effective) {
    if (event.eventType === "superseded"
      && activeSetId !== event.allocationSetId) {
      throw new Error("attribution_history_invalid");
    }
    activeSetId = event.eventType === "activated"
      ? event.allocationSetId : null;
  }
  return activeSetId;
}
