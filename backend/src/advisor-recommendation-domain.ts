import type {
  AdvisorRecommendedAction,
  AdvisorMetricRef,
  AdvisorEvidenceRef,
  AdvisorEntityRef
} from "./growth-contract-types.js";

export const ADVISOR_RECOMMENDATION_STATUSES = [
  "proposed",
  "accepted",
  "ignored",
  "completed",
  "expired"
] as const;

export type AdvisorRecommendationStatus =
  typeof ADVISOR_RECOMMENDATION_STATUSES[number];

export interface AdvisorRecommendation {
  id: string;
  workspaceId: string;
  revision: number;
  audienceRole: "sales" | "manager" | "admin" | "super_admin";
  type: "priority_customer" | "quote_risk" | "roi_opportunity" | "data_gap";
  summary: string;
  rationale: string;
  metricRefs: readonly AdvisorMetricRef[];
  evidenceRefs: readonly AdvisorEvidenceRef[];
  entityRefs: readonly AdvisorEntityRef[];
  confidenceBps: number;
  riskLevel: "low" | "medium" | "high";
  recommendedAction: AdvisorRecommendedAction;
  status: AdvisorRecommendationStatus;
  assignedTo: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  outcomeRefs: readonly (
    | { kind: "action_receipt"; id: string }
    | { kind: "deal_outcome"; id: string }
    | { kind: "quote_version"; id: string }
  )[];
  dataAsOf: string;
  inputSnapshotHash: `sha256:${string}`;
  modelSnapshotRef: string;
  promptVersion: string;
  schemaVersion: "advisor-recommendation.v1";
  generationIdempotencyKey: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdvisorRecommendationEvent {
  recommendationId: string;
  eventRevision: number;
  eventType: "created" | AdvisorTransitionKind;
  recordedAt: string;
  temporalSequence: number;
  actorId: string;
  aggregateSnapshotHash: `sha256:${string}`;
  aggregateSnapshot: AdvisorRecommendation;
}

export type AdvisorTransitionKind = "accept" | "ignore" | "complete" | "expire";

export interface AdvisorTransitionInput {
  recommendationId: string;
  kind: AdvisorTransitionKind;
  reason: string | null;
  /** Server-resolved completion outcome (never caller-supplied). */
  outcomeRefs?: AdvisorRecommendation["outcomeRefs"];
}

export interface AdvisorTransitionMetadata {
  actorId: string;
  occurredAt: string;
}

export function applyAdvisorTransition(
  current: AdvisorRecommendation,
  input: AdvisorTransitionInput,
  metadata: AdvisorTransitionMetadata
): AdvisorRecommendation {
  if (input.recommendationId !== current.id) {
    throw recommendationError("invalid_recommendation_transition");
  }
  const nextStatus: AdvisorRecommendationStatus | null =
    current.status === "proposed"
      ? input.kind === "accept" ? "accepted"
        : input.kind === "ignore" ? "ignored"
          : input.kind === "expire" ? "expired" : null
      : current.status === "accepted"
        ? input.kind === "complete" ? "completed"
          : input.kind === "expire" ? "expired" : null
        : null;
  if (nextStatus === null) {
    throw recommendationError("invalid_recommendation_transition");
  }
  const accepted = input.kind === "accept";
  return Object.freeze({
    ...current,
    revision: current.revision + 1,
    status: nextStatus,
    acceptedBy: accepted ? metadata.actorId : current.acceptedBy,
    acceptedAt: accepted ? metadata.occurredAt : current.acceptedAt,
    outcomeRefs: input.outcomeRefs ?? current.outcomeRefs,
    updatedAt: metadata.occurredAt
  });
}

export function recommendationError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export { type AdvisorRecommendedAction, type AdvisorMetricRef };
