import { AcquisitionCostEstimateService } from "./acquisition-cost-estimate-service.js";
import {
  type ProviderRequestAccountingEvidenceRow,
  type ProviderRequestAccountingEvidenceSource
} from "./acquisition-cost-evidence-source.js";
import { AcquisitionCostLedgerService } from "./acquisition-cost-ledger.js";
import type { CommandContext } from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import { canonicalGrowthRequestHash } from "./growth-http-idempotency-repository.js";
import { decimalMajorToMinor } from "./growth-money.js";
import type { FinancialLedgerRepository } from "./financial-ledger-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

type Checkpoint = { recordedAt: string; id: string };

interface ProjectionPersistence {
  getProviderEvidenceProjection(workspaceId: string, sourceId: string): Promise<{
    targetKind: "cost_entry" | "estimate";
    targetId: string;
    evidenceFingerprint: string;
    sourceVersion: number;
  } | null>;
  recordProviderEvidenceProjection(input: {
    workspaceId: string;
    sourceId: string;
    targetKind: "cost_entry" | "estimate";
    targetId: string;
    evidenceFingerprint: string;
    sourceVersion: number;
    projectedAt: string;
  }): Promise<void>;
}

function projectionPersistence(repository: FinancialLedgerRepository):
ProjectionPersistence | null {
  const candidate = repository as FinancialLedgerRepository
    & Partial<ProjectionPersistence>;
  return typeof candidate.getProviderEvidenceProjection === "function"
    && typeof candidate.recordProviderEvidenceProjection === "function"
    ? candidate as ProjectionPersistence : null;
}

function projectionWorkspace(workspaceId: string): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team" as const,
    actorId: "finance-provider-evidence-projector",
    role: "admin" as const,
    teamId: workspaceId,
    capabilities: Object.freeze(["ledger.pending.create" as const]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

function command(row: ProviderRequestAccountingEvidenceRow,
  operation: "actual" | "estimate"): CommandContext {
  const workspace = projectionWorkspace(row.workspaceId);
  const requestHash = canonicalGrowthRequestHash({
    projectionContract: "provider-accounting-evidence-to-finance.v1",
    operation,
    evidence: row
  });
  return Object.freeze({
    workspace,
    actorId: workspace.actorId,
    idempotencyKey: `provider-evidence:${operation}:${row.id}`,
    requestHash,
    expectedRevision: null
  });
}

function normalizedRows(rows: readonly ProviderRequestAccountingEvidenceRow[],
  workspaceId: string, checkpoint: Checkpoint | null) {
  let prior = checkpoint;
  return rows.map((row) => {
    if (row.workspaceId !== workspaceId || !row.id.trim()
      || !Number.isFinite(Date.parse(row.recordedAt))
      || (row.provenance !== "provider_reported"
        && row.provenance !== "estimated" && row.provenance !== "unknown")) {
      throw new Error("invalid_provider_evidence_row");
    }
    if (prior && (row.recordedAt < prior.recordedAt
      || (row.recordedAt === prior.recordedAt && row.id <= prior.id))) {
      throw new Error("provider_evidence_order_invalid");
    }
    prior = { recordedAt: row.recordedAt, id: row.id };
    return row;
  });
}

export class AcquisitionCostEvidenceProjector {
  private readonly costs: AcquisitionCostLedgerService;
  private readonly estimates: AcquisitionCostEstimateService;

  constructor(private readonly input: {
    repository: FinancialLedgerRepository;
    foundation: GrowthFoundationServices;
    source: ProviderRequestAccountingEvidenceSource;
  }) {
    this.costs = new AcquisitionCostLedgerService(input);
    this.estimates = new AcquisitionCostEstimateService(input);
  }

  async projectAfter(workspaceId: string, checkpoint: Checkpoint | null,
    limit: number) {
    const rows = normalizedRows(await this.input.source.listAfter(
      workspaceId, checkpoint, limit
    ), workspaceId, checkpoint);
    let projectedCostEntries = 0;
    let projectedEstimates = 0;
    let nextCheckpoint = checkpoint;
    const persistence = projectionPersistence(this.input.repository);
    for (const row of rows) {
      const amountMinor = decimalMajorToMinor(row.costAmountMajor, row.currency);
      if (amountMinor < 1) throw new Error("provider_evidence_amount_invalid");
      const sourceIdentityRoot = `provider-request:${row.id}`;
      const evidenceFingerprint = canonicalGrowthRequestHash({
        projectionContract: "provider-accounting-evidence-to-finance.v1",
        evidence: row
      });
      const sourceVersion = row.evidenceSequence ?? row.ledgerVersion ?? 1;
      if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
        throw new Error("provider_evidence_version_invalid");
      }
      const persisted = await persistence?.getProviderEvidenceProjection(
        workspaceId, row.id
      );
      if (persisted && (persisted.evidenceFingerprint !== evidenceFingerprint
        || persisted.sourceVersion !== sourceVersion)) {
        throw new Error("cost_evidence_projection_conflict");
      }
      if (row.provenance === "provider_reported") {
        const estimateEvents = await this.input.repository
          .listCostEstimateLifecycleEvents(workspaceId, row.currency,
            sourceIdentityRoot, "9999-12-31T23:59:59.999Z");
        if (estimateEvents.length > 0) {
          throw new Error("cost_evidence_projection_conflict");
        }
        if (persisted && persisted.targetKind !== "cost_entry") {
          throw new Error("cost_evidence_projection_conflict");
        }
        const result = await this.costs.createPending(command(row, "actual"), {
          platform: row.providerId,
          planId: null,
          runId: row.runId,
          providerId: row.providerId,
          category: "api",
          amountMinor,
          currency: row.currency,
          businessOccurredAt: row.recordedAt,
          provenance: "provider_reported",
          sourceRef: row.ledgerId,
          evidenceHash: row.evidenceHash,
          externalId: row.id,
          sourceIdentityRoot,
          estimateReconciliationId: null
        });
        await persistence?.recordProviderEvidenceProjection({
          workspaceId, sourceId: row.id, targetKind: "cost_entry",
          targetId: result.entry.id, evidenceFingerprint, sourceVersion,
          projectedAt: result.entry.recordedAt
        });
        projectedCostEntries += 1;
      } else {
        if (await this.input.repository.getCostEntryBySource(
          workspaceId, sourceIdentityRoot
        )) {
          throw new Error("cost_evidence_projection_conflict");
        }
        if (persisted && persisted.targetKind !== "estimate") {
          throw new Error("cost_evidence_projection_conflict");
        }
        const snapshotHash = canonicalGrowthRequestHash({
          projectionContract: "provider-accounting-estimate.v1",
          evidence: row
        });
        const result = await this.estimates.createAndActivateProjected(
          command(row, "estimate"), {
            runId: row.runId,
            amountMinor,
            currency: row.currency,
            sourceStableKey: sourceIdentityRoot,
            inputSnapshotHash: snapshotHash,
            validFrom: row.recordedAt
          }
        );
        await persistence?.recordProviderEvidenceProjection({
          workspaceId, sourceId: row.id, targetKind: "estimate",
          targetId: result.id, evidenceFingerprint, sourceVersion,
          projectedAt: result.activatedAt ?? result.createdAt
        });
        projectedEstimates += 1;
      }
      nextCheckpoint = { recordedAt: row.recordedAt, id: row.id };
    }
    return Object.freeze({ projectedCostEntries, projectedEstimates, nextCheckpoint });
  }
}
