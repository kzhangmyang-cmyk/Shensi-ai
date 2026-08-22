export type AcquisitionDetailMode = "plan" | "candidates";

export interface AcquisitionDetailOpenRequest {
  mode: AcquisitionDetailMode;
  planId?: string;
  candidateId?: string;
}

export function acquisitionCandidateDetailRequest(
  candidateId: string,
  planId?: string
): AcquisitionDetailOpenRequest | null {
  const selectedCandidateId = candidateId.trim();
  if (!selectedCandidateId) return null;
  const selectedPlanId = planId?.trim();
  return {
    mode: "candidates",
    ...(selectedPlanId ? { planId: selectedPlanId } : {}),
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
