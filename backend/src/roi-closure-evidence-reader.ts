import type { GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type {
  RoiClosureRepository
} from "./acquisition-roi-closure.js";
import type { GrowthRoiSliceKey } from "./growth-contract-types.js";

export interface RoiClosureEvidenceSnapshot {
  readonly closureVersionId: string;
  readonly workspaceId: string;
  readonly cohortId: string;
  readonly currency: string;
  readonly version: number;
  readonly asOf: string;
  readonly status: "closed" | "superseded";
  readonly sliceKey: GrowthRoiSliceKey;
  readonly planId: string | null;
  readonly calculationHash: `sha256:${string}`;
  readonly membershipSnapshotHash: string;
  readonly closedAt: string;
  readonly commercialAuthoritySetHash: `sha256:${string}`;
}

export interface RoiClosureEvidenceSealedReader {
  getAt(
    context: ActiveWorkspaceContext,
    input: {
      closureVersionId: string;
      sliceKey: GrowthRoiSliceKey;
      cutoff: GrowthSealedReadCutoff;
    }
  ): Promise<RoiClosureEvidenceSnapshot | null>;
}

function assertSliceKey(value: string): GrowthRoiSliceKey {
  if (!/^(?:all|plan:.+)$/u.test(value)) {
    throw new Error("advisor_reference_invalid");
  }
  return value as GrowthRoiSliceKey;
}

/** Token-only sealed closure evidence reader. It reads only the immutable
 *  closure version plus its materialized slice at the one sealed cutoff; a
 *  closure recorded after the cutoff or a missing/mismatched slice returns
 *  null and never falls back to a mutable head. */
export class RoiClosureEvidenceReader
implements RoiClosureEvidenceSealedReader {
  constructor(private readonly repository: RoiClosureRepository) {}

  async getAt(
    context: ActiveWorkspaceContext,
    input: {
      closureVersionId: string;
      sliceKey: GrowthRoiSliceKey;
      cutoff: GrowthSealedReadCutoff;
    }
  ): Promise<RoiClosureEvidenceSnapshot | null> {
    if (input.cutoff.workspaceId !== context.workspaceId) {
      throw new Error("sealed_cutoff_workspace_mismatch");
    }
    const sliceKey = assertSliceKey(input.sliceKey);
    const closure = await this.repository.getVersion(
      context.workspaceId, input.closureVersionId
    );
    if (!closure || closure.workspaceId !== context.workspaceId) return null;
    if (closure.closedAt > input.cutoff.effectiveAsOf) return null;
    const snapshots = await this.repository.listSnapshots(
      context.workspaceId, closure.id
    );
    const snapshot = snapshots.find((row) => row.sliceKey === sliceKey);
    if (!snapshot) return null;
    return Object.freeze({
      closureVersionId: closure.id,
      workspaceId: closure.workspaceId,
      cohortId: closure.cohortId,
      currency: closure.currency,
      version: closure.version,
      asOf: closure.asOf,
      status: closure.status,
      sliceKey,
      planId: snapshot.planId,
      calculationHash: snapshot.calculationHash as `sha256:${string}`,
      membershipSnapshotHash: snapshot.memberSetHash,
      closedAt: closure.closedAt,
      commercialAuthoritySetHash:
        snapshot.commercialAuthoritySetHash
    });
  }
}
