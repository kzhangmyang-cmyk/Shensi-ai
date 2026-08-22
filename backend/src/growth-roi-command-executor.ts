import { randomUUID } from "node:crypto";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import {
  executeGrowthIdempotentCommand
} from "./growth-http-idempotency-repository.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import { createHash } from "node:crypto";
import type { CommandContext } from "./growth-command-context.js";

export type RoiMutationRouteTemplate =
  | "/api/v1/acquisition/cohorts"
  | "/api/v1/acquisition/cohorts/:id/attestations"
  | "/api/v1/acquisition/cohorts/:id/close"
  | "/api/v1/acquisition/roi-closures/:closureVersionId/reopen"
  | "/api/v1/acquisition/attribution-allocation-sets"
  | "/api/v1/acquisition/attribution-allocation-sets/:id/activate"
  | "/api/v1/finance/source-reports"
  | "/api/v1/finance/settlement-allocation-sets"
  | "/api/v1/finance/settlement-allocation-sets/:id/activate";

export interface RoiCommandSpec {
  method: "POST";
  canonicalPath: RoiMutationRouteTemplate;
  resourceKind: "cohort" | "source_report" | "attribution_set"
    | "settlement_set" | "attestation" | "closure" | "closure_series";
}

export interface RoiCommandExecutionIds {
  resourceId: string | null;
  operationId: string | null;
}

export interface RoiCommandExecutor {
  execute<T>(
    context: CommandContext,
    spec: RoiCommandSpec,
    hooks: {
      authorizeAndProject(ids: RoiCommandExecutionIds): Promise<T>;
      executeClaimed(
        domainCommandHash: `sha256:${string}`
      ): Promise<RoiCommandExecutionIds>;
    }
  ): Promise<T>;
}

export function hashCanonicalJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "").digest("hex")}`;
}

export class FoundationRoiCommandExecutor implements RoiCommandExecutor {
  private readonly foundation: GrowthFoundationServices;
  private readonly now: () => string;

  constructor(input: {
    foundation: GrowthFoundationServices;
    now?: () => string;
  }) {
    this.foundation = input.foundation;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  async execute<T>(
    context: CommandContext,
    spec: RoiCommandSpec,
    hooks: {
      authorizeAndProject(ids: RoiCommandExecutionIds): Promise<T>;
      executeClaimed(
        domainCommandHash: `sha256:${string}`
      ): Promise<RoiCommandExecutionIds>;
    }
  ): Promise<T> {
    const domainCommandHash = hashCanonicalJson({
      workspaceId: context.workspace.workspaceId,
      actorId: context.actorId,
      method: spec.method,
      canonicalPath: spec.canonicalPath,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      expectedRevision: context.expectedRevision ?? null
    });
    const executed = await executeGrowthIdempotentCommand({
      repository: this.foundation.httpIdempotency,
      reservation: {
        workspaceId: context.workspace.workspaceId,
        actorId: context.actorId,
        method: spec.method,
        canonicalPath: spec.canonicalPath,
        key: context.idempotencyKey,
        requestHash: context.requestHash,
        attemptedAt: this.now(),
        leaseOwner: randomUUID(),
        leaseDurationMs: 30_000
      }
    },
    (resourceId, operationId) =>
      hooks.authorizeAndProject({ resourceId, operationId }),
    () => hooks.executeClaimed(domainCommandHash));
    return executed.value;
  }
}
