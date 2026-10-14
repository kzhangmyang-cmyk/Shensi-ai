export type AcquisitionDetailMode = "plan" | "candidates";

export interface AcquisitionDetailOpenRequest {
  mode: AcquisitionDetailMode;
  planId?: string;
  candidateId?: string;
  candidateRunId?: string;
}

export function acquisitionCandidateDetailRequest(
  candidateId: string,
  planId?: string,
  candidateRunId?: string
): AcquisitionDetailOpenRequest | null {
  const selectedCandidateId = candidateId.trim();
  if (!selectedCandidateId) return null;
  const selectedPlanId = planId?.trim();
  const selectedCandidateRunId = candidateRunId?.trim();
  return {
    mode: "candidates",
    ...(selectedPlanId ? { planId: selectedPlanId } : {}),
    ...(selectedPlanId && selectedCandidateRunId ? { candidateRunId: selectedCandidateRunId } : {}),
    candidateId: selectedCandidateId
  };
}

export function acquisitionDetailRequestForAction(
  acquisitionMode: string | undefined,
  actionId: string,
  planId: string | undefined
): AcquisitionDetailOpenRequest | null {
  const selectedPlanId = planId?.trim();
  if (acquisitionMode !== "real" || !selectedPlanId) return null;
  if (actionId === "replicaEditTask") {
    return { mode: "plan", planId: selectedPlanId };
  }
  if (actionId === "replicaCompleteTask") {
    return { mode: "candidates", planId: selectedPlanId };
  }
  return null;
}
