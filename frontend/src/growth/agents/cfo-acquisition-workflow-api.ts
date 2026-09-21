import type { GrowthHttpClient } from "../http";

export type CfoAcquisitionWorkflowStage =
  | "preparing_plan"
  | "awaiting_plan_approval"
  | "running_acquisition"
  | "awaiting_candidate_review"
  | "completed"
  | "completed_empty"
  | "cancelled"
  | "failed";

export interface CfoAcquisitionWorkflow {
  workflowId: string;
  instruction: string;
  stage: CfoAcquisitionWorkflowStage;
  summary: string;
  planId: string | null;
  planEtag: string | null;
  planReview: {
    targetPlatform: string;
    objective: string;
    providers: Array<{ providerId: string; status: string }>;
    operations: Array<{
      kind: string;
      query: string;
      allocatedBudget: { requests: number; results: number; amountMinor: number; durationSeconds: number };
    }>;
    budget: { currency: string; requests: number; results: number; amountMinor: number; durationSeconds: number };
  } | null;
  runId: string | null;
  runStatus: string | null;
  candidates: Array<{
    candidateId: string;
    displayName: string;
    decisionVersion: string;
    discoveredEventId: string;
    decision: "pending" | "approved" | "rejected" | "do_not_contact";
    customerId: string | null;
    todoId: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface CfoCandidateDecisionInput {
  candidateId: string;
  action: "approved" | "rejected" | "do_not_contact";
  reason: string | null;
  dueAt?: string;
  priority?: "high" | "medium" | "normal";
}

export function createCfoAcquisitionWorkflowApi(http: GrowthHttpClient) {
  const base = "/api/v1/acquisition/cfo-workflows";
  return Object.freeze({
    async create(instruction: string, idempotencyKey: string) {
      return (await http.request<CfoAcquisitionWorkflow>(base, {
        method: "POST",
        body: { instruction },
        idempotencyKey
      })).body;
    },
    async latest() {
      return (await http.request<CfoAcquisitionWorkflow | null>(`${base}/latest`)).body;
    },
    async get(workflowId: string) {
      return (await http.request<CfoAcquisitionWorkflow>(`${base}/${encodeURIComponent(workflowId)}`)).body;
    },
    async approve(workflowId: string, reason: string, idempotencyKey: string) {
      return (await http.request<CfoAcquisitionWorkflow>(`${base}/${encodeURIComponent(workflowId)}/approval`, {
        method: "POST",
        body: { reason },
        idempotencyKey
      })).body;
    },
    async decide(
      workflowId: string,
      input: CfoCandidateDecisionInput,
      idempotencyKey: string
    ) {
      return (await http.request<CfoAcquisitionWorkflow>(`${base}/${encodeURIComponent(workflowId)}/candidate-decisions`, {
        method: "POST",
        body: input,
        idempotencyKey
      })).body;
    },
    async decideMany(
      workflowId: string,
      decisions: CfoCandidateDecisionInput[],
      idempotencyKey: string
    ) {
      return (await http.request<CfoAcquisitionWorkflow>(`${base}/${encodeURIComponent(workflowId)}/candidate-decisions/batch`, {
        method: "POST",
        body: { decisions },
        idempotencyKey
      })).body;
    },
    async cancel(workflowId: string, reason: string) {
      return (await http.request<CfoAcquisitionWorkflow>(`${base}/${encodeURIComponent(workflowId)}/cancel`, {
        method: "POST",
        body: { reason },
        idempotencyKey: `cfo-workflow-cancel-${workflowId}`
      })).body;
    }
  });
}
