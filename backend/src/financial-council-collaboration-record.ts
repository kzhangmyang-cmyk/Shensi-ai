import type { FinancialCfoNarrative } from "./financial-council-model-port.js";
import type { FinancialCouncilAnalysisLease } from "./financial-council-repository.js";
import { financialCouncilError, immutableFinancialCouncilInput } from "./financial-council-domain.js";

export interface FinancialCouncilCollaborationEvent {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly role: "cfo" | "finance" | "profit" | "cost" | "cashflow" | "tax" | null;
  readonly phase: "analysis" | "review" | "synthesis";
  readonly state: "running" | "completed" | "missing_data" | "failed" | "degraded";
  readonly occurredAt: string;
  readonly message: string;
  readonly reasonCode: string | null;
  readonly findingIds: readonly string[];
  readonly narrative: FinancialCfoNarrative | null;
}

export function validateCollaborationEvent(lease: Pick<FinancialCouncilAnalysisLease, "workspaceId" | "runId">,
  raw: FinancialCouncilCollaborationEvent): FinancialCouncilCollaborationEvent {
  const event = immutableFinancialCouncilInput(raw);
  const keys = ["eventId", "workspaceId", "runId", "role", "phase", "state", "occurredAt", "message", "reasonCode", "findingIds", "narrative"];
  if (Object.keys(event).length !== keys.length || Object.keys(event).some(key => !keys.includes(key))
    || event.workspaceId !== lease.workspaceId || event.runId !== lease.runId
    || typeof event.eventId !== "string" || event.eventId.length < 1 || event.eventId.length > 255
    || ![null, "cfo", "finance", "profit", "cost", "cashflow", "tax"].includes(event.role)
    || !["analysis", "review", "synthesis"].includes(event.phase)
    || !["running", "completed", "missing_data", "failed", "degraded"].includes(event.state)
    || !Number.isFinite(Date.parse(event.occurredAt))
    || typeof event.message !== "string" || event.message.length > 2000
    || (event.reasonCode !== null && (typeof event.reasonCode !== "string" || !/^[a-z_]+$/u.test(event.reasonCode)))
    || !Array.isArray(event.findingIds) || event.findingIds.length > 500
    || event.findingIds.some(id => typeof id !== "string" || id.length > 255)
    || (event.narrative !== null && (event.role !== "cfo" || event.phase !== "synthesis"
      || !validNarrativeRecord(event.narrative)))) {
    throw financialCouncilError("financial_council_input_invalid");
  }
  return event;
}

function validNarrativeRecord(narrative: FinancialCfoNarrative): boolean {
  const keys = ["overallDiagnosis", "priorityFindingIds", "minorityFindingIds", "riskNotes", "narrativeStatus"];
  const ids = (value: unknown): value is readonly string[] => Array.isArray(value)
    && value.length <= 100 && value.every(id => typeof id === "string" && id.length > 0 && id.length <= 255)
    && new Set(value).size === value.length;
  return !!narrative && typeof narrative === "object"
    && Object.keys(narrative).length === keys.length && Object.keys(narrative).every(key => keys.includes(key))
    && typeof narrative.overallDiagnosis === "string" && narrative.overallDiagnosis.length > 0
    && narrative.overallDiagnosis.length <= 10000
    && ["model_valid", "model_invalid", "model_unavailable"].includes(narrative.narrativeStatus)
    && ids(narrative.priorityFindingIds) && ids(narrative.minorityFindingIds)
    && Array.isArray(narrative.riskNotes) && narrative.riskNotes.length <= 500
    && narrative.riskNotes.every(note => typeof note === "string" && note.length > 0 && note.length <= 10000);
}

export function collaborationEvent(lease: FinancialCouncilAnalysisLease,
  input: Omit<FinancialCouncilCollaborationEvent, "workspaceId" | "runId" | "eventId" | "findingIds" | "narrative" | "reasonCode"> & {
    readonly key?: string; readonly findingIds?: readonly string[];
    readonly narrative?: FinancialCfoNarrative | null; readonly reasonCode?: string | null;
  }): FinancialCouncilCollaborationEvent {
  const { key, ...fields } = input;
  return { workspaceId: lease.workspaceId, runId: lease.runId,
    eventId: `${input.phase}:${input.role ?? "council"}:${key ?? input.state}${input.state === "running" ? `:${lease.attempt}` : ""}`,
    findingIds: [], narrative: null, reasonCode: null, ...fields };
}
