import type { GrowthBootstrapResponse } from "./contracts";
import type { GrowthContractManifest } from "./http";

export type GrowthMode =
  | { kind: "demo" }
  | {
      kind: "real";
      bootstrap: GrowthBootstrapResponse;
    };

export type GrowthUnavailable = {
  kind: "unavailable";
  reason: "workspace_selection_required" | "contract_mismatch";
};

export interface ResolveGrowthModeInput {
  requested: "real" | "demo";
  pinned: GrowthContractManifest;
  bootstrap: GrowthBootstrapResponse;
}

export function resolveGrowthMode(
  input: ResolveGrowthModeInput
): GrowthMode | GrowthUnavailable {
  if (input.requested === "demo") return { kind: "demo" };
  if (input.bootstrap.status !== "ready") {
    return { kind: "unavailable", reason: "workspace_selection_required" };
  }
  const pinnedMajor = input.pinned.contractVersion.split(".")[0];
  const serverMajor = input.bootstrap.contractVersion.split(".")[0];
  if (pinnedMajor !== serverMajor
    || input.bootstrap.contractHash !== input.pinned.contractHash) {
    return { kind: "unavailable", reason: "contract_mismatch" };
  }
  return { kind: "real", bootstrap: input.bootstrap };
}
