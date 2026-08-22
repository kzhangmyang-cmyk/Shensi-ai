import { randomUUID } from "node:crypto";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import {
  GrowthHttpError,
  type CommandContext
} from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import { hashCanonicalJson } from "./growth-roi-command-executor.js";
import type {
  RoiCommandExecutor,
  RoiCommandExecutionIds
} from "./growth-roi-command-executor.js";
import {
  canonicalSubjectStableKey
} from "./acquisition-canonical-subject.js";
import type {
  AuthoritativeDiscoveryEvent,
  AcquisitionCohort,
  AcquisitionCohortCatchUpOperation,
  AcquisitionCohortMember,
  AcquisitionCohortMemberSource,
  AcquisitionCohortRepository,
  CohortCatchUpResult
} from "./acquisition-cohort-repository.js";
import type {
  AuthoritativeDiscoverySource
} from "./acquisition-authoritative-discovery-projection.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";

export class CohortError extends GrowthHttpError {
  constructor(code: string, status = 400) {
    super(status, code);
    this.name = "CohortError";
  }
}

export interface AcquisitionCohortService {
  create(
    context: CommandContext,
    input: {
      platform: string;
      cohortFrom: string;
      cohortTo: string;
      definitionVersion: string;
      firstTouchRuleVersion: string;
    }
  ): Promise<AcquisitionCohort>;
  get(
    workspace: ActiveWorkspaceContext,
    cohortId: string
  ): Promise<AcquisitionCohort | null>;
  listMembersAt(
    workspace: ActiveWorkspaceContext,
    cohortId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<Array<AcquisitionCohortMember & {
    sources: AcquisitionCohortMemberSource[];
  }>>;
}

export interface CohortProjectionReadCatchUpPort {
  ensureAt(
    workspace: ActiveWorkspaceContext,
    cohortId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<CohortCatchUpResult>;
}

export interface CohortClosureCatchUpPort {
  ensureForClosure(
    context: CommandContext,
    input: {
      closureOperationId: string;
      cohortId: string;
      cutoff: GrowthSealedReadCutoff;
    }
  ): Promise<CohortCatchUpResult>;
}

export class DefaultAcquisitionCohortService
implements AcquisitionCohortService, CohortProjectionReadCatchUpPort,
  CohortClosureCatchUpPort {
  private readonly repository: AcquisitionCohortRepository;
  private readonly foundation: GrowthFoundationServices;
  private readonly commandExecutor: RoiCommandExecutor;
  private readonly discoveries: AuthoritativeDiscoverySource;
  private readonly now: () => string;
  private readonly ids: { next(): string };

  constructor(input: {
    repository: AcquisitionCohortRepository;
    foundation: GrowthFoundationServices;
    commandExecutor: RoiCommandExecutor;
    discoveries: AuthoritativeDiscoverySource;
    now?: () => string;
    ids?: { next(): string };
  }) {
    this.repository = input.repository;
    this.foundation = input.foundation;
    this.commandExecutor = input.commandExecutor;
    this.discoveries = input.discoveries;
    this.now = input.now ?? (() => new Date().toISOString());
    this.ids = input.ids ?? { next: randomUUID };
  }

  async create(
    context: CommandContext,
    input: {
      platform: string;
      cohortFrom: string;
      cohortTo: string;
      definitionVersion: string;
      firstTouchRuleVersion: string;
    }
  ): Promise<AcquisitionCohort> {
    requireGrowthCapabilities(context.workspace, ["roi.close"]);
    const domainCommandHash = hashCanonicalJson({
      workspaceId: context.workspace.workspaceId,
      actorId: context.actorId,
      canonicalPath: "/api/v1/acquisition/cohorts",
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      platform: input.platform,
      cohortFrom: input.cohortFrom,
      cohortTo: input.cohortTo
    });
    return this.commandExecutor.execute(
      context,
      {
        method: "POST",
        canonicalPath: "/api/v1/acquisition/cohorts",
        resourceKind: "cohort"
      },
      {
        authorizeAndProject: async (ids) => {
          requireGrowthCapabilities(context.workspace, ["roi.close"]);
          if (!ids.resourceId || ids.operationId !== null) {
            throw new CohortError("idempotency_reference_invalid", 409);
          }
          const cohort = await this.repository.requireActive(
            context.workspace.workspaceId, ids.resourceId
          );
          return cohort;
        },
        executeClaimed: async (hash) => {
          const probed = await this.repository.findCohortByDomainHash(
            context.workspace.workspaceId, hash
          );
          if (probed) {
            if (probed.requestedBy !== context.actorId
              || probed.requestHash !== context.requestHash) {
              throw new CohortError("idempotency_conflict", 409);
            }
            return { resourceId: probed.id, operationId: null };
          }
          const cohort = await this.repository.createCohort({
            id: this.ids.next(),
            workspaceId: context.workspace.workspaceId,
            platform: input.platform.trim(),
            cohortFrom: input.cohortFrom,
            cohortTo: input.cohortTo,
            definitionVersion: input.definitionVersion,
            firstTouchRuleVersion: input.firstTouchRuleVersion,
            domainCommandHash: hash,
            requestHash: context.requestHash,
            requestedBy: context.actorId,
            now: this.now()
          });
          return { resourceId: cohort.id, operationId: null };
        }
      }
    );
  }

  async get(
    workspace: ActiveWorkspaceContext,
    cohortId: string
  ): Promise<AcquisitionCohort | null> {
    requireGrowthCapabilities(workspace, ["growth.performance.workspace.read"]);
    return this.repository.getCohort(workspace.workspaceId, cohortId);
  }

  async listMembersAt(
    workspace: ActiveWorkspaceContext,
    cohortId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<Array<AcquisitionCohortMember & {
    sources: AcquisitionCohortMemberSource[];
  }>> {
    requireGrowthCapabilities(workspace, ["growth.performance.workspace.read"]);
    if (cutoff.workspaceId !== workspace.workspaceId) {
      throw new CohortError("sealed_cutoff_workspace_mismatch", 409);
    }
    return this.repository.listMembersAt(
      workspace.workspaceId, cohortId, cutoff
    );
  }

  async ensureAt(
    workspace: ActiveWorkspaceContext,
    cohortId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<CohortCatchUpResult> {
    requireGrowthCapabilities(workspace, ["growth.performance.workspace.read"]);
    const requestIdentity =
      `${workspace.workspaceId}\u0000${workspace.actorId}\u0000`
      + `${cohortId}\u0000${cutoff.effectiveAsOf}`;
    return this.projectMembersClaimed({
      workspace,
      requestedBy: workspace.actorId,
      authorityKind: "performance_read",
      parentClosureOperationId: null,
      requestIdentity
    }, cohortId, cutoff);
  }

  async ensureForClosure(
    context: CommandContext,
    input: {
      closureOperationId: string;
      cohortId: string;
      cutoff: GrowthSealedReadCutoff;
    }
  ): Promise<CohortCatchUpResult> {
    requireGrowthCapabilities(context.workspace, ["roi.close"]);
    const requestIdentity =
      `roi-close:${input.closureOperationId}:${input.cutoff.effectiveAsOf}`;
    return this.projectMembersClaimed({
      workspace: context.workspace,
      requestedBy: context.actorId,
      authorityKind: "roi_close",
      parentClosureOperationId: input.closureOperationId,
      requestIdentity
    }, input.cohortId, input.cutoff);
  }

  private async projectMembersClaimed(
    authority: {
      workspace: ActiveWorkspaceContext;
      requestedBy: string;
      authorityKind: "roi_close" | "performance_read";
      parentClosureOperationId: string | null;
      requestIdentity: string;
    },
    cohortId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<CohortCatchUpResult> {
    if (cutoff.workspaceId !== authority.workspace.workspaceId) {
      throw new CohortError("sealed_cutoff_workspace_mismatch", 409);
    }
    const cohort = await this.repository.requireActive(
      authority.workspace.workspaceId, cohortId
    );
    const operation = await this.repository.createOrReplayCatchUp({
      workspaceId: authority.workspace.workspaceId,
      cohortId,
      cutoff,
      requestedBy: authority.requestedBy,
      authorityKind: authority.authorityKind,
      parentClosureOperationId: authority.parentClosureOperationId,
      requestIdentity: authority.requestIdentity
    });
    const lease = await this.repository.claimCatchUp(
      operation.id, randomUUID(), this.now(), 30_000
    );
    if (lease === null) throw new CohortError("catch_up_in_progress", 409);
    let after = await this.repository.readCheckpoint(operation.id, lease);
    let inserted = 0;
    let reassigned = 0;
    let aliased = 0;
    let unassignable = 0;
    for (;;) {
      const page = await this.discoveries.listDiscoveries(
        authority.workspace.workspaceId,
        {
          platform: cohort.platform,
          from: cohort.cohortFrom,
          to: cohort.cohortTo,
          cutoff,
          after,
          limit: 250
        }
      );
      for (const event of page.items) {
        const resolution = canonicalSubjectStableKey(
          authority.workspace.workspaceId, event.material
        );
        if (resolution.status === "unassignable"
          || resolution.subjectStableKey === null) {
          await this.repository.recordUnassignable(
            operation.id, event.eventId, lease
          );
          unassignable += 1;
          continue;
        }
        const outcome = await this.repository.upsertFirstTouch({
          cohort,
          event: {
            ...event,
            planId: event.attribution.planId,
            runId: event.attribution.runId,
            shardId: event.attribution.shardId,
            evidenceId: event.attribution.evidenceIds[0] ?? null
          },
          resolution,
          now: this.now()
        });
        if (outcome === "inserted") inserted += 1;
        else if (outcome === "reassigned") reassigned += 1;
        else aliased += 1;
      }
      await this.repository.advanceCheckpoint(
        operation.id, page.next, lease
      );
      await this.repository.renewCatchUp(lease, this.now(), 30_000);
      if (page.next === null) {
        const sourceWatermark = await this.discoveries.getWatermark(
          authority.workspace.workspaceId,
          { platform: cohort.platform, cutoff }
        );
        const result = {
          inserted,
          reassigned,
          aliased,
          unassignable,
          complete: true,
          sourceWatermark
        };
        await this.repository.completeCatchUp(
          operation.id, lease, result
        );
        return result;
      }
      after = page.next;
    }
  }
}
