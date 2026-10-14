import type { OutcomeAttributionInput } from "./acquisition-domain.js";

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Shape only. Run/job/workspace authority must still be resolved server-side. */
export function isOutcomeAttributionShape(
  value: unknown
): value is OutcomeAttributionInput {
  if (!isAcquisitionSourceShape(value)) return false;
  const item = value as unknown as Record<string, unknown>;
  return ["qualificationDecisionId", "decisionVersion", "decisionSnapshotHash"]
    .every((field) => text(item[field]));
}

export type AcquisitionSourceAttribution = OutcomeAttributionInput extends infer T
  ? T extends OutcomeAttributionInput
    ? Omit<T, "qualificationDecisionId" | "decisionVersion" | "decisionSnapshotHash">
    : never : never;

export function isAcquisitionSourceShape(value: unknown): value is AcquisitionSourceAttribution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!["runId", "planId", "planVersionId", "planSnapshotHash",
    "discoveredEventId", "discoveredAt", "strategyVersion"]
    .every((field) => text(item[field]))
    || !Number.isSafeInteger(item.planVersion) || Number(item.planVersion) < 1
    || !Number.isFinite(Date.parse(item.discoveredAt as string))
    || !["evidenceIds", "providerIds", "queryIds"].every((field) =>
      Array.isArray(item[field]) && (item[field] as unknown[]).every(text))) {
    return false;
  }
  const sourceFields = ["shardId", "operationId", "connectionId", "providerId"];
  if (item.attributionVersion === "acquisition-run.v1") {
    return sourceFields.every((field) => text(item[field])) && !("jobId" in item);
  }
  return item.attributionVersion === "douyin-crawler.v1"
    && text(item.jobId)
    && sourceFields.every((field) => item[field] === null)
    && (item.evidenceIds as unknown[]).length > 0
    && (item.providerIds as unknown[]).length === 0
    && (item.queryIds as unknown[]).length === 0;
}
