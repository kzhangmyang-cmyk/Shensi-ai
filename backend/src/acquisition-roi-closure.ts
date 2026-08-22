import { randomUUID } from "node:crypto";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import {
  GrowthHttpError,
  requireExpectedRevision,
  type CommandContext
} from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import { hashCanonicalJson } from "./growth-roi-command-executor.js";
import type {
  RoiCommandExecutor,
  RoiCommandExecutionIds
} from "./growth-roi-command-executor.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";
import {
  calculateActualRoiForClosure,
  calculateContractRoas,
  calculateCashMultiple,
  calculateCollectionRate,
  type ClosedActualRoiResult,
  type ClosureCalculationEvidence,
  type RoiGapCode
} from "./acquisition-roi-calculation.js";

export class RoiClosureError extends GrowthHttpError {
  constructor(code: string, status = 400) {
    super(status, code);
    this.name = "RoiClosureError";
  }
}

export type ClosureAspect =
  | "acquisition_cost"
  | "revenue"
  | "cogs"
  | "cash"
  | "refund_bad_debt"
  | "attribution";

export type ClosureEvidenceRef =
  | { kind: "source_report"; sourceReportId: string; reportHash: string }
  | {
      kind: "ledger_entry";
      ledgerType: "cost" | "financial";
      ledgerEntryId: string;
      evidenceHash: string;
    }
  | {
      kind: "verification";
      ledgerType: "cost" | "financial";
      ledgerEntryId: string;
      verificationEventId: string;
    }
  | {
      kind: "allocation_set";
      allocationKind: "attribution" | "settlement";
      allocationSetId: string;
      version: number;
    };

export interface RoiCoverageSnapshot {
  costCoverageBps: number;
  marginCoverageBps: number;
  cashCoverageBps: number;
  attributionCoverageBps: number;
  gapCodes: RoiGapCode[];
}

export interface ClosureAttestation {
  id: string;
  workspaceId: string;
  cohortId: string;
  currency: string;
  aspect: ClosureAspect;
  periodFrom: string;
  periodTo: string;
  asOf: string;
  declaredTotalMinor: number | null;
  sourceSystem: string;
  sourceCursor: string | null;
  sourceReportId: string | null;
  reportAllocationSetId: string | null;
  reportHash: string;
  evidenceRefs: ClosureEvidenceRef[];
  status: "signed" | "superseded";
  signedBy: string;
  signedAt: string;
}

export interface RoiClosureSeries {
  id: string;
  workspaceId: string;
  cohortId: string;
  currency: string;
  status: "open" | "closed";
  currentClosureVersionId: string | null;
  revision: number;
  updatedAt: string;
}

export interface RoiClosureVersion {
  id: string;
  workspaceId: string;
  cohortId: string;
  currency: string;
  version: number;
  asOf: string;
  status: "closed" | "superseded";
  previousClosureVersionId: string | null;
  formulaVersion: "verified-gross-profit-roi.v1";
  membershipSnapshotHash: string;
  attestationSetHash: string;
  factSetHash: string;
  costSetHash: string;
  allocationSetHash: string;
  settlementSetHash: string;
  closedBy: string;
  closedAt: string;
}

export interface ClosedCommercialRatioSnapshot {
  verifiedContractWonMinor: number;
  allocatedPaymentMinor: number;
  netCashMinor: number;
  verifiedAcquisitionCostMinor: number;
  contractRoas: ReturnType<typeof calculateContractRoas>;
  cashMultiple: ReturnType<typeof calculateCashMultiple>;
  collectionRate: ReturnType<typeof calculateCollectionRate>;
}

export interface RoiSnapshot {
  closureVersionId: string;
  sliceKey: "all" | `plan:${string}`;
  planId: string | null;
  memberCount: number;
  memberSetHash: string;
  computedMetrics: ClosedActualRoiResult;
  commercialRatios: ClosedCommercialRatioSnapshot;
  commercialAuthoritySetHash: `sha256:${string}`;
  coverage: RoiCoverageSnapshot;
  calculationHash: string;
}

export interface RoiSnapshotSliceMember {
  closureVersionId: string;
  sliceKey: "all" | `plan:${string}`;
  cohortMemberId: string;
  ownershipVersionId: string;
}

export interface RoiSnapshotEntry {
  closureVersionId: string;
  sourceType: "cohort_member" | "attestation" | "cost" | "financial"
    | "verification" | "allocation_set" | "settlement_set";
  sourceId: string;
  effectiveAmountMinor: number | null;
  sourceHash: string;
}

export interface RoiClosureOperation {
  id: string;
  workspaceId: string;
  cohortId: string;
  currency: string;
  inputHash: string;
  expectedSeriesRevision: number;
  requestedBy: string;
  domainCommandHash: `sha256:${string}`;
  requestHash: `sha256:${string}`;
  status: "queued" | "running" | "succeeded" | "failed";
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  closureVersionId: string | null;
  errorCode: RoiGapCode | "revision_mismatch" | "stale_fencing_token" | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoiClosureService {
  createAttestationAt(
    context: CommandContext,
    input: {
      cohortId: string;
      currency: string;
      aspect: ClosureAspect;
      periodFrom: string;
      periodTo: string;
      declaredTotalMinor: number | null;
      sourceSystem: string;
      sourceCursor: string | null;
      sourceReportId: string | null;
      reportAllocationSetId: string | null;
      reportHash: string;
      evidenceRefs: ClosureEvidenceRef[];
    },
    cutoff: GrowthSealedReadCutoff
  ): Promise<ClosureAttestation>;
  closeAt(
    context: CommandContext,
    input: {
      cohortId: string;
      currency: string;
      attestationIds: string[];
    },
    cutoff: GrowthSealedReadCutoff
  ): Promise<RoiClosureVersion>;
  reopen(
    context: CommandContext,
    closureVersionId: string
  ): Promise<RoiClosureSeries>;
  getVersion(
    workspace: ActiveWorkspaceContext,
    closureVersionId: string
  ): Promise<{
    closure: RoiClosureVersion;
    snapshots: RoiSnapshot[];
    sliceMembers: RoiSnapshotSliceMember[];
    entries: RoiSnapshotEntry[];
  } | null>;
}

export interface ClosureFixtureReader {
  freezeEvidence(input: {
    workspace: ActiveWorkspaceContext;
    cutoff: GrowthSealedReadCutoff;
    attestations: ClosureAttestation[];
  }): Promise<{
    closureEvidence: ClosureCalculationEvidence;
    verifiedRevenueMinor: number;
    verifiedCogsMinor: number;
    verifiedRefundMinor: number;
    verifiedBadDebtMinor: number;
    verifiedAcquisitionCostMinor: number;
    allCoverageBps: number;
    cashReconciled: boolean;
    members: Array<{
      cohortMemberId: string;
      ownershipVersionId: string;
      firstPlanId: string;
    }>;
    verifiedContractWonMinor: number;
    allocatedPaymentMinor: number;
    netCashMinor: number;
  }>;
}

export interface RoiClosureRepository {
  getSeries(
    workspaceId: string,
    cohortId: string,
    currency: string
  ): Promise<RoiClosureSeries | null>;
  getSeriesById(
    workspaceId: string,
    seriesId: string
  ): Promise<RoiClosureSeries | null>;
  createSeries(series: RoiClosureSeries): Promise<void>;
  appendAttestation(
    attestation: ClosureAttestation,
    domainCommandHash: `sha256:${string}`
  ): Promise<ClosureAttestation>;
  findAttestationByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<ClosureAttestation | null>;
  listAttestations(
    workspaceId: string,
    cohortId: string,
    currency: string
  ): Promise<ClosureAttestation[]>;
  appendClosureVersion(input: {
    version: RoiClosureVersion;
    snapshots: RoiSnapshot[];
    sliceMembers: RoiSnapshotSliceMember[];
    entries: RoiSnapshotEntry[];
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
    requestedBy: string;
  }): Promise<RoiClosureVersion>;
  findClosureVersionByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<RoiClosureVersion | null>;
  getVersion(workspaceId: string, id: string): Promise<RoiClosureVersion | null>;
  listSnapshots(
    workspaceId: string,
    closureVersionId: string
  ): Promise<RoiSnapshot[]>;
  listSliceMembers(
    workspaceId: string,
    closureVersionId: string
  ): Promise<RoiSnapshotSliceMember[]>;
  listEntries(
    workspaceId: string,
    closureVersionId: string
  ): Promise<RoiSnapshotEntry[]>;
  markClosed(
    series: RoiClosureSeries,
    closureVersionId: string
  ): Promise<RoiClosureSeries>;
  appendReopenEvent(
    series: RoiClosureSeries,
    closureVersionId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<RoiClosureSeries>;
  findReopenByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<RoiClosureSeries | null>;
  countReopenEvents(closureVersionId: string): Promise<number>;
  countCloseOperations(): Promise<number>;
  countClosureVersions(): Promise<number>;
  countAttestations(): Promise<number>;
}

export class RoiClosureService {
  private readonly repository: RoiClosureRepository;
  private readonly foundation: GrowthFoundationServices;
  private readonly commandExecutor: RoiCommandExecutor;
  private readonly reader: ClosureFixtureReader;
  private readonly now: () => string;

  constructor(input: {
    repository: RoiClosureRepository;
    foundation: GrowthFoundationServices;
    commandExecutor: RoiCommandExecutor;
    reader: ClosureFixtureReader;
    now?: () => string;
  }) {
    this.repository = input.repository;
    this.foundation = input.foundation;
    this.commandExecutor = input.commandExecutor;
    this.reader = input.reader;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  async createAttestationAt(
    context: CommandContext,
    input: {
      cohortId: string;
      currency: string;
      aspect: ClosureAspect;
      periodFrom: string;
      periodTo: string;
      declaredTotalMinor: number | null;
      sourceSystem: string;
      sourceCursor: string | null;
      sourceReportId: string | null;
      reportAllocationSetId: string | null;
      reportHash: string;
      evidenceRefs: ClosureEvidenceRef[];
    },
    cutoff: GrowthSealedReadCutoff
  ): Promise<ClosureAttestation> {
    requireGrowthCapabilities(context.workspace, ["roi.close"]);
    if (cutoff.workspaceId !== context.workspace.workspaceId) {
      throw new RoiClosureError("sealed_cutoff_workspace_mismatch", 409);
    }
    if (!(input.periodFrom < input.periodTo
      && input.periodTo <= cutoff.effectiveAsOf)) {
      throw new RoiClosureError("invalid_as_of", 422);
    }
    const domainCommandHash = hashCanonicalJson({
      workspaceId: context.workspace.workspaceId,
      actorId: context.actorId,
      canonicalPath: "/api/v1/acquisition/cohorts/:id/attestations",
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      cohortId: input.cohortId,
      aspect: input.aspect,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      reportHash: input.reportHash
    });
    return this.commandExecutor.execute(
      context,
      {
        method: "POST",
        canonicalPath: "/api/v1/acquisition/cohorts/:id/attestations",
        resourceKind: "attestation"
      },
      {
        authorizeAndProject: async (ids) => {
          requireGrowthCapabilities(context.workspace, ["roi.close"]);
          if (!ids.resourceId || ids.operationId !== null) {
            throw new RoiClosureError("idempotency_reference_invalid", 409);
          }
          const existing = (await this.repository.listAttestations(
            context.workspace.workspaceId, input.cohortId, input.currency
          )).find((attestation) => attestation.id === ids.resourceId);
          if (!existing) {
            throw new RoiClosureError("idempotency_conflict", 409);
          }
          return existing;
        },
        executeClaimed: async (hash) => {
          const replay = await this.repository.findAttestationByDomainHash(
            context.workspace.workspaceId, hash
          );
          if (replay) {
            return { resourceId: replay.id, operationId: null };
          }
          const attestation = await this.repository.appendAttestation({
            id: randomUUID(),
            workspaceId: context.workspace.workspaceId,
            cohortId: input.cohortId,
            currency: input.currency,
            aspect: input.aspect,
            periodFrom: input.periodFrom,
            periodTo: input.periodTo,
            asOf: cutoff.effectiveAsOf,
            declaredTotalMinor: input.declaredTotalMinor,
            sourceSystem: input.sourceSystem,
            sourceCursor: input.sourceCursor,
            sourceReportId: input.sourceReportId,
            reportAllocationSetId: input.reportAllocationSetId,
            reportHash: input.reportHash,
            evidenceRefs: input.evidenceRefs,
            status: "signed",
            signedBy: context.actorId,
            signedAt: this.now()
          }, hash);
          return { resourceId: attestation.id, operationId: null };
        }
      }
    );
  }

  async closeAt(
    context: CommandContext,
    input: {
      cohortId: string;
      currency: string;
      attestationIds: string[];
    },
    cutoff: GrowthSealedReadCutoff
  ): Promise<RoiClosureVersion> {
    requireGrowthCapabilities(context.workspace, ["roi.close"]);
    const expectedSeriesRevision = requireExpectedRevision(context);
    if (cutoff.workspaceId !== context.workspace.workspaceId) {
      throw new RoiClosureError("sealed_cutoff_workspace_mismatch", 409);
    }
    const attestationIds = [...input.attestationIds].sort();
    const domainCommandHash = hashCanonicalJson({
      workspaceId: context.workspace.workspaceId,
      actorId: context.actorId,
      canonicalPath: "/api/v1/acquisition/cohorts/:id/close",
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      cohortId: input.cohortId,
      currency: input.currency,
      asOf: cutoff.effectiveAsOf,
      attestationIds,
      expectedSeriesRevision
    });
    return this.commandExecutor.execute(
      context,
      {
        method: "POST",
        canonicalPath: "/api/v1/acquisition/cohorts/:id/close",
        resourceKind: "closure"
      },
      {
        authorizeAndProject: async (ids) => {
          requireGrowthCapabilities(context.workspace, ["roi.close"]);
          if (!ids.resourceId || ids.operationId === null) {
            throw new RoiClosureError("idempotency_reference_invalid", 409);
          }
          const version = await this.repository.getVersion(
            context.workspace.workspaceId, ids.resourceId
          );
          if (!version) {
            throw new RoiClosureError("idempotency_conflict", 409);
          }
          return version;
        },
        executeClaimed: async (hash) => {
          const replay = await this.repository.findClosureVersionByDomainHash(
            context.workspace.workspaceId, hash
          );
          if (replay) {
            return {
              resourceId: replay.id,
              operationId: `op-${replay.id}`
            };
          }
          let series = await this.repository.getSeries(
            context.workspace.workspaceId, input.cohortId, input.currency
          );
          if (!series) {
            series = Object.freeze({
              id: `series-${input.cohortId}-${input.currency}`,
              workspaceId: context.workspace.workspaceId,
              cohortId: input.cohortId,
              currency: input.currency,
              status: "open",
              currentClosureVersionId: null,
              revision: 1,
              updatedAt: this.now()
            });
            await this.repository.createSeries(series);
          }
          if (series.status !== "open") {
            throw new RoiClosureError("closure_series_closed", 409);
          }
          if (series.revision !== expectedSeriesRevision) {
            throw new RoiClosureError("revision_mismatch", 412);
          }
          const attestations = (await this.repository.listAttestations(
            context.workspace.workspaceId, input.cohortId, input.currency
          )).filter((attestation) =>
            attestationIds.includes(attestation.id)
            && attestation.status === "signed");
          if (attestations.length !== attestationIds.length) {
            throw new RoiClosureError("attestation_incomplete", 422);
          }
          const aspects = new Set(attestations.map((item) => item.aspect));
          for (const aspect of [
            "acquisition_cost",
            "revenue",
            "cogs",
            "cash",
            "refund_bad_debt",
            "attribution"
          ]) {
            if (!aspects.has(aspect as ClosureAspect)) {
              throw new RoiClosureError("attestation_incomplete", 422);
            }
          }
          const frozen = await this.reader.freezeEvidence({
            workspace: context.workspace,
            cutoff,
            attestations
          });
          const closureEvidence = frozen.closureEvidence;
          const computedMetrics = calculateActualRoiForClosure({
            verifiedRevenueMinor: frozen.verifiedRevenueMinor,
            verifiedCogsMinor: frozen.verifiedCogsMinor,
            verifiedRefundMinor: frozen.verifiedRefundMinor,
            verifiedBadDebtMinor: frozen.verifiedBadDebtMinor,
            verifiedAcquisitionCostMinor: frozen.verifiedAcquisitionCostMinor,
            allCoverageBps: frozen.allCoverageBps,
            cashReconciled: frozen.cashReconciled,
            closureEvidence
          });
          if (computedMetrics.status !== "computed") {
            throw new RoiClosureError(computedMetrics.reason, 422);
          }
          const commercialRatios: ClosedCommercialRatioSnapshot = {
            verifiedContractWonMinor: frozen.verifiedContractWonMinor,
            allocatedPaymentMinor: frozen.allocatedPaymentMinor,
            netCashMinor: frozen.netCashMinor,
            verifiedAcquisitionCostMinor: frozen.verifiedAcquisitionCostMinor,
            contractRoas: calculateContractRoas({
              verifiedContractWonMinor: frozen.verifiedContractWonMinor,
              verifiedAcquisitionCostMinor: frozen.verifiedAcquisitionCostMinor
            }),
            cashMultiple: calculateCashMultiple({
              allocatedPaymentMinor: frozen.allocatedPaymentMinor,
              verifiedAcquisitionCostMinor: frozen.verifiedAcquisitionCostMinor
            }),
            collectionRate: calculateCollectionRate({
              allocatedPaymentMinor: frozen.allocatedPaymentMinor,
              verifiedContractWonMinor: frozen.verifiedContractWonMinor
            })
          };
          const versionNumber = series.revision;
          const versionId = `closure-${input.cohortId}-${versionNumber}`;
          const memberSetHash = hashCanonicalJson(
            frozen.members.map((member) =>
              `${member.cohortMemberId}\u0000${member.ownershipVersionId}`)
              .sort()
          );
          const coverage: RoiCoverageSnapshot = {
            costCoverageBps: frozen.allCoverageBps,
            marginCoverageBps: 10000,
            cashCoverageBps: frozen.cashReconciled ? 10000 : 0,
            attributionCoverageBps: 10000,
            gapCodes: []
          };
          const snapshot: RoiSnapshot = {
            closureVersionId: versionId,
            sliceKey: "all",
            planId: null,
            memberCount: frozen.members.length,
            memberSetHash,
            computedMetrics,
            commercialRatios,
            commercialAuthoritySetHash: hashCanonicalJson([]),
            coverage,
            calculationHash: hashCanonicalJson({
              closureVersionId: versionId,
              planId: null,
              memberSetHash,
              computedMetrics,
              commercialRatios,
              evidenceHashes: closureEvidence,
              effectiveAsOf: cutoff.effectiveAsOf
            })
          };
          const sliceMembers: RoiSnapshotSliceMember[] = frozen.members.map(
            (member) => ({
              closureVersionId: versionId,
              sliceKey: "all",
              cohortMemberId: member.cohortMemberId,
              ownershipVersionId: member.ownershipVersionId
            })
          );
          const entries: RoiSnapshotEntry[] = frozen.members.map((member) => ({
            closureVersionId: versionId,
            sourceType: "cohort_member",
            sourceId: member.cohortMemberId,
            effectiveAmountMinor: null,
            sourceHash: member.ownershipVersionId
          }));
          const version: RoiClosureVersion = Object.freeze({
            id: versionId,
            workspaceId: context.workspace.workspaceId,
            cohortId: input.cohortId,
            currency: input.currency,
            version: versionNumber,
            asOf: cutoff.effectiveAsOf,
            status: "closed",
            previousClosureVersionId: series.currentClosureVersionId,
            formulaVersion: "verified-gross-profit-roi.v1",
            membershipSnapshotHash: closureEvidence.membershipSnapshotHash,
            attestationSetHash: closureEvidence.attestationSetHash,
            factSetHash: closureEvidence.factSetHash,
            costSetHash: closureEvidence.costSetHash,
            allocationSetHash: closureEvidence.allocationSetHash,
            settlementSetHash: closureEvidence.settlementSetHash,
            closedBy: context.actorId,
            closedAt: this.now()
          });
          await this.repository.appendClosureVersion({
            version,
            snapshots: [snapshot],
            sliceMembers,
            entries,
            domainCommandHash: hash,
            requestHash: context.requestHash,
            requestedBy: context.actorId
          });
          await this.repository.markClosed(series, versionId);
          return {
            resourceId: version.id,
            operationId: `op-${version.id}`
          };
        }
      }
    );
  }

  async reopen(
    context: CommandContext,
    closureVersionId: string
  ): Promise<RoiClosureSeries> {
    requireGrowthCapabilities(context.workspace, ["roi.close"]);
    const expectedRevision = requireExpectedRevision(context);
    const domainCommandHash = hashCanonicalJson({
      workspaceId: context.workspace.workspaceId,
      actorId: context.actorId,
      canonicalPath: "/api/v1/acquisition/roi-closures/:closureVersionId/reopen",
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      closureVersionId
    });
    return this.commandExecutor.execute(
      context,
      {
        method: "POST",
        canonicalPath:
          "/api/v1/acquisition/roi-closures/:closureVersionId/reopen",
        resourceKind: "closure_series"
      },
      {
        authorizeAndProject: async (ids) => {
          requireGrowthCapabilities(context.workspace, ["roi.close"]);
          if (!ids.resourceId || ids.operationId !== null) {
            throw new RoiClosureError("idempotency_reference_invalid", 409);
          }
          const series = await this.repository.getSeriesById(
            context.workspace.workspaceId, ids.resourceId
          );
          if (!series) throw new RoiClosureError("idempotency_conflict", 409);
          return series;
        },
        executeClaimed: async (hash) => {
          const replay = await this.repository.findReopenByDomainHash(
            context.workspace.workspaceId, hash
          );
          if (replay) {
            return { resourceId: replay.id, operationId: null };
          }
          const version = await this.repository.getVersion(
            context.workspace.workspaceId, closureVersionId
          );
          if (!version) throw new RoiClosureError("closure_not_found", 404);
          const series = await this.repository.getSeries(
            context.workspace.workspaceId, version.cohortId, version.currency
          );
          if (!series) throw new RoiClosureError("closure_series_not_found", 404);
          if (series.revision !== expectedRevision) {
            throw new RoiClosureError("revision_mismatch", 412);
          }
          const updated = await this.repository.appendReopenEvent(
            series, closureVersionId, hash
          );
          return { resourceId: updated.id, operationId: null };
        }
      }
    );
  }

  async getVersion(
    workspace: ActiveWorkspaceContext,
    closureVersionId: string
  ) {
    requireGrowthCapabilities(workspace, ["growth.performance.workspace.read"]);
    const version = await this.repository.getVersion(
      workspace.workspaceId, closureVersionId
    );
    if (!version) return null;
    return {
      closure: version,
      snapshots: await this.repository.listSnapshots(
        workspace.workspaceId, closureVersionId
      ),
      sliceMembers: await this.repository.listSliceMembers(
        workspace.workspaceId, closureVersionId
      ),
      entries: await this.repository.listEntries(
        workspace.workspaceId, closureVersionId
      )
    };
  }
}
