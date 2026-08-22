import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Request } from "express";
import mysql from "mysql2/promise";
import { AcquisitionCostLedgerService, type CreatePendingCostInput } from "./acquisition-cost-ledger.js";
import {
  deriveRevenueAndCogs,
  FinancialFactLedgerService
} from "./financial-fact-ledger.js";
import type { AuthoritativeDealDecisionRef } from "./authoritative-quote-reader.js";
import type { CommercialBindingSnapshot } from "./commercial-binding-snapshot.js";
import { MysqlVerifiedFinancialLedgerSealedReader } from "./financial-ledger-as-of-mysql-reader.js";
import { ensureFinancialLedgerMysqlSchema, MysqlFinancialLedgerRepository } from "./financial-ledger-mysql-repository.js";
import {
  MysqlFinanceImportRepository
} from "./finance-import-mysql-repository.js";
import {
  FinanceImportWorker
} from "./finance-import-worker.js";
import {
  DefaultFinanceImportRecoverySweeper
} from "./finance-import-recovery-sweeper.js";
import {
  type FinanceImportOperationEvent,
  type FinanceImportOperationInput,
  type FinanceImportRowResult,
  type FinanceImportStoredRowInput
} from "./finance-import-repository.js";
import { wonQuoteFixture } from "./growth-finance-test-fixtures.js";
import { growthInstantMilliseconds } from "./growth-as-of.js";
import {
  ensureAttributionAllocationMysqlSchema,
  MysqlAttributionAllocationRepository
} from "./acquisition-attribution-allocation-mysql-repository.js";
import {
  AttributionAllocationService
} from "./acquisition-attribution-allocation.js";
import {
  FoundationRoiCommandExecutor
} from "./growth-roi-command-executor.js";
import {
  ensureFinancialSettlementMysqlSchema,
  MysqlFinancialSettlementRepository
} from "./financial-settlement-allocation-mysql-repository.js";
import {
  CashSettlementAllocationService
} from "./financial-settlement-allocation.js";
import {
  ensureRoiClosureMysqlSchema,
  MysqlRoiClosureRepository
} from "./acquisition-roi-closure-mysql-repository.js";
import type { CommandContext } from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import { ensureGrowthHttpIdempotencyMysqlSchema, MysqlGrowthHttpIdempotencyRepository } from "./growth-http-idempotency-mysql-repository.js";
import { canonicalGrowthRequestHash } from "./growth-http-idempotency-repository.js";
import { commandContextFromRequest } from "./growth-http-preconditions.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import { MysqlGrowthTemporalBarrier, growthMysqlDate, growthMysqlInstant } from "./growth-temporal-barrier-mysql-repository.js";
import type { GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";
import { createGrowthAcquisitionWorkspaceResolver, type ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { ensureGrowthWorkspaceSettingsMysqlSchema, MysqlGrowthWorkspaceSettingsRepository } from "./growth-workspace-settings-mysql-repository.js";

const DEFAULT_NOW = "2026-08-09T03:00:00.000Z";

function connectionOptions(url: URL) {
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    timezone: "Z" as const,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true
  };
}

export function requireGrowthFinanceMysqlTestAdminUrl(): URL {
  const configured = process.env.MYSQL_TEST_ADMIN_URL?.trim();
  if (!configured) throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:growth-finance");
  const url = new URL(configured);
  if (url.protocol !== "mysql:") {
    throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:growth-finance:mysql-protocol");
  }
  return url;
}

function workspaceContext(workspaceId: string, actorId = "finance-a"): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId,
    kind: "team" as const,
    actorId,
    role: "admin" as const,
    teamId: workspaceId,
    capabilities: Object.freeze([
      "ledger.pending.create" as const,
      "ledger.verify" as const,
      "roi.close" as const,
      "growth.performance.workspace.read" as const,
      "pricing.sensitive.read" as const
    ]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

function command(workspaceId: string, key: string, expectedRevision: number | null = null): CommandContext {
  return Object.freeze({
    workspace: workspaceContext(workspaceId),
    actorId: "finance-a",
    idempotencyKey: key,
    expectedRevision,
    requestHash: canonicalGrowthRequestHash({ workspaceId, key, expectedRevision })
  });
}

export interface HistoricalLedgerSeed {
  entryId: string;
  businessOccurredAt: string;
  recordedAt: string;
  amountMinor: number;
  factType: "contract_won" | "payment_received" | "revenue_recognized" | "cogs_recognized" | "refund" | "bad_debt_written_off";
  candidateId: string | null;
  customerId: string | null;
  dealId: string | null;
  quoteVersionId: string | null;
  commercialBindingHash: string;
  evidenceHash: string;
  verificationRecordedAt: string;
  reversalRecordedAt?: string | null;
}

export interface GrowthFinanceMysqlTestDatabase {
  databaseName: string;
  pool: mysql.Pool;
  connectionA: mysql.PoolConnection;
  connectionB: mysql.PoolConnection;
  idempotency: MysqlGrowthHttpIdempotencyRepository;
  foundation: GrowthFoundationServices;
  verifiedSealedReader: MysqlVerifiedFinancialLedgerSealedReader;
  workspaceContext: typeof workspaceContext;
  command: typeof command;
  newCostInput(overrides?: Partial<CreatePendingCostInput>): CreatePendingCostInput;
  costLedgerOnConnection(name: "a" | "b"): AcquisitionCostLedgerService;
  factServiceOnConnection(name: "a" | "b"): FinancialFactLedgerService;
  seedWonAuthority(input: {
    quotedAmountMinor: number;
    currency: string;
    commercialAmountHash: string;
  }): Promise<void>;
  replaceCurrentBinding(
    overrides: Partial<CommercialBindingSnapshot>
  ): void;
  createDirectRevenueAndGrossProfit(input: {
    revenueMinor: number;
    grossProfitMinor: number;
    currency: string;
  }): Promise<{ ids: string[] }>;
  correctDirectRevenueAndGrossProfit(input: {
    ids: string[];
    expectedRevision: number;
    revenueMinor: number;
    grossProfitMinor: number;
    currency: string;
  }): Promise<void>;
  readFactAmounts(ids: readonly string[]): Promise<Array<number | undefined>>;
  verifyFacts(ids: readonly string[], input: {
    expectedRevision: number;
  }): Promise<void>;
  financialLedgerCounts(): Promise<{
    facts: number;
    events: number;
    sourceHeads: number;
  }>;
  setSessionTimestamp3(name: "a" | "b", value: string): Promise<void>;
  currentTimestamp3OnConnection(name: "a" | "b"): Promise<string>;
  sealReadCutoffOnConnection(name: "a", workspace: ActiveWorkspaceContext,
    effectiveCutoff: string): Promise<GrowthSealedReadCutoff>;
  businessLockTrace(key: string): readonly string[];
  reReadOldCutoffAfterLaterAppend(cutoff: GrowthSealedReadCutoff,
    entryId: string): Promise<readonly unknown[]>;
  seedHistoricalLedger(input: HistoricalLedgerSeed): Promise<void>;
  importRepository: MysqlFinanceImportRepository;
  financeImportWorker(input: { connection: "a" | "b" }): FinanceImportWorker;
  financeImportRecoverySweeper(): DefaultFinanceImportRecoverySweeper;
  insertFinanceImportOperation(input: {
    status?: "queued" | "running";
    rows?: number;
    factType?: "contract_won" | "revenue_recognized" | "cogs_recognized";
    amountMinor?: number;
    currency?: string;
    revenueMinor?: number;
    grossProfitMinor?: number;
    bypassPreviewForCommitIntegrityTest?: boolean;
    expiredOwner?: string;
    frozenCandidateId?: string;
  }): Promise<string>;
  commandContext(operationId: string): CommandContext;
  rowResult(): FinanceImportRowResult;
  countCreatedLedgerRows(operationId?: string): Promise<number>;
  countFinanceImportRowResults(operationId: string): Promise<number>;
  listImportOperationEvents(
    operationId: string
  ): Promise<FinanceImportOperationEvent[]>;
  writeLockTraces(operationId: string): string[][];
  tamperOperationPreviewLink(
    operationId: string,
    input: { fileHash: string }
  ): Promise<void>;
  setNow(value: string): void;
  advanceNowBy(milliseconds: number): string;
  replaceWonAuthority(overrides: Partial<AuthoritativeDealDecisionRef>): void;
  restoreWonAuthorityFor(quoteVersionId: string): void;
  attributionService(): AttributionAllocationService;
  repository: MysqlAttributionAllocationRepository;
  context(key: string): CommandContext;
  settlementService(): CashSettlementAllocationService;
  settlementRepository: MysqlFinancialSettlementRepository;
  insertVerifiedRevenue(
    id: string,
    dealId: string,
    amountMinor: number
  ): Promise<void>;
  insertVerifiedPayment(
    id: string,
    dealId: string,
    amountMinor: number
  ): Promise<void>;
  insertVerifiedBadDebt(
    id: string,
    dealId: string,
    amountMinor: number
  ): Promise<void>;
  closureRepository(): MysqlRoiClosureRepository;
}

export async function withGrowthFinanceMysqlTestDatabase<T>(
  testBody: (fixture: GrowthFinanceMysqlTestDatabase) => Promise<T>
): Promise<T> {
  const adminUrl = requireGrowthFinanceMysqlTestAdminUrl();
  const databaseName = `goodjob_growth_finance_${process.pid}_${randomUUID()
    .replaceAll("-", "").slice(0, 12)}`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let pool: mysql.Pool | undefined;
  let connectionA: mysql.PoolConnection | undefined;
  let connectionB: mysql.PoolConnection | undefined;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${databaseName}\`
      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    pool = mysql.createPool({
      ...connectionOptions(adminUrl), database: databaseName, connectionLimit: 4
    });
    await ensureGrowthHttpIdempotencyMysqlSchema(pool);
    await ensureFinancialLedgerMysqlSchema(pool);
    await ensureAttributionAllocationMysqlSchema(pool);
    await ensureFinancialSettlementMysqlSchema(pool);
    await ensureRoiClosureMysqlSchema(pool);
    await ensureGrowthWorkspaceSettingsMysqlSchema(pool);
    // Schema installation is an upgrade path and must remain retry-safe.
    await ensureFinancialLedgerMysqlSchema(pool);
    connectionA = await pool.getConnection();
    connectionB = await pool.getConnection();
    assert.notEqual(connectionA.threadId, connectionB.threadId,
      "growth Finance gate requires two physical connections");

    const repositoryA = new MysqlFinancialLedgerRepository(connectionA);
    const repositoryB = new MysqlFinancialLedgerRepository(connectionB);
    const temporalBarrier = new MysqlGrowthTemporalBarrier(repositoryA);
    const idempotency = new MysqlGrowthHttpIdempotencyRepository(pool);
    const acquisitionWorkspace = createGrowthAcquisitionWorkspaceResolver({
      async resolve(scope) {
        return { workspaceId: scope.teamId, kind: "team" as const,
          bindingRevision: "finance-mysql-test.v1" };
      }
    });
    const foundation: GrowthFoundationServices = Object.freeze({
      httpIdempotency: idempotency,
      workspaceSettings: new MysqlGrowthWorkspaceSettingsRepository(pool, temporalBarrier),
      workspaceContext: (request: Request) => {
        if (!request.activeWorkspace) throw new Error("workspace_required");
        return request.activeWorkspace;
      },
      acquisitionWorkspace,
      temporalTransactions: repositoryA,
      temporalBarrier,
      commandContextFactory: commandContextFromRequest
    });
    const repositories = { a: repositoryA, b: repositoryB } as const;
    const connections = { a: connectionA, b: connectionB } as const;
    const services = {
      a: new AcquisitionCostLedgerService({ repository: repositoryA, foundation }),
      b: new AcquisitionCostLedgerService({ repository: repositoryB, foundation })
    } as const;
    let wonDecision: AuthoritativeDealDecisionRef | null = null;
    let currentBinding: CommercialBindingSnapshot | null = null;
    const factServices = {
      a: new FinancialFactLedgerService({
        repository: repositoryA,
        foundation,
        bindingVerifier: {
          async verify() {
            if (!currentBinding) {
              throw new Error("commercial_binding_authority_mismatch");
            }
            return currentBinding;
          }
        },
        dealQuoteReader: {
          async getDecisionAt() {
            return wonDecision;
          }
        }
      }),
      b: new FinancialFactLedgerService({
        repository: repositoryB,
        foundation,
        bindingVerifier: {
          async verify() {
            if (!currentBinding) {
              throw new Error("commercial_binding_authority_mismatch");
            }
            return currentBinding;
          }
        },
        dealQuoteReader: {
          async getDecisionAt() {
            return wonDecision;
          }
        }
      })
    } as const;
    const verifiedSealedReader = new MysqlVerifiedFinancialLedgerSealedReader(connectionA);
    const lockLabels: string[] = [];
    let importClock = growthInstantMilliseconds(DEFAULT_NOW);
    const importNow = () => new Date(importClock).toISOString();
    wonDecision = wonQuoteFixture();
    currentBinding = Object.freeze({
      ...wonDecision.commercialBindingSnapshot,
      verifiedAt: "2026-08-09T02:00:00.000Z"
    }) as CommercialBindingSnapshot;
    const importRepository = new MysqlFinanceImportRepository(
      pool, temporalBarrier, (label) => {
        lockLabels.push(label);
      }
    );
    const importLedgerRepository = new MysqlFinancialLedgerRepository(pool);
    const importFactService = new FinancialFactLedgerService({
      repository: importLedgerRepository,
      foundation,
      bindingVerifier: {
        async verify() {
          if (!currentBinding) {
            throw new Error("commercial_binding_authority_mismatch");
          }
          return currentBinding;
        }
      },
      dealQuoteReader: {
        async getDecisionAt() {
          return wonDecision;
        }
      }
    });
    const importCostService = new AcquisitionCostLedgerService({
      repository: importLedgerRepository,
      foundation
    });
    const importWorker = new FinanceImportWorker({
      repository: importRepository,
      foundation,
      costLedger: importCostService,
      financialFactLedger: importFactService,
      bindingVerifier: {
        async verify() {
          if (!currentBinding) {
            throw new Error("commercial_binding_authority_mismatch");
          }
          return currentBinding;
        }
      },
      dealQuoteReader: {
        async getDecisionAt() {
          return wonDecision;
        }
      },
      now: importNow,
      leaseDurationMs: 5 * 60_000
    });
    const attributionRepository =
      new MysqlAttributionAllocationRepository(pool, temporalBarrier);
    const attributionService = new AttributionAllocationService({
      repository: attributionRepository,
      foundation,
      commandExecutor: new FoundationRoiCommandExecutor({
        foundation,
        now: importNow
      }),
      sources: {
        async requireEffectiveAmountMinor() {
          return 10_000;
        }
      },
      now: importNow
    });
    const settlementRepository =
      new MysqlFinancialSettlementRepository(pool, temporalBarrier);
    const settlementService = new CashSettlementAllocationService({
      repository: settlementRepository,
      foundation,
      commandExecutor: new FoundationRoiCommandExecutor({
        foundation,
        now: importNow
      }),
      facts: {
        async requireFact() {
          return {
            id: "fact",
            factType: "payment_received",
            dealId: "deal-a",
            quoteVersionId: "quote-1",
            amountMinor: 100,
            currency: "CNY",
            commercialBindingSnapshot: null
          };
        }
      },
      now: importNow
    });
    const roiClosureRepository =
      new MysqlRoiClosureRepository(pool, temporalBarrier);
    const fixture: GrowthFinanceMysqlTestDatabase = {
      databaseName,
      pool,
      connectionA,
      connectionB,
      idempotency,
      foundation,
      verifiedSealedReader,
      workspaceContext,
      command,
      newCostInput: (overrides = {}) => ({
        platform: "douyin", planId: null, runId: null, providerId: null,
        category: "media", amountMinor: 10_000, currency: "CNY",
        businessOccurredAt: "2026-08-09T08:00:00.000Z",
        provenance: "portal_export", sourceRef: "portal://new-cost",
        evidenceHash: "sha256:new-cost", externalId: "new-cost",
        sourceIdentityRoot: "external:portal:new-cost",
        estimateReconciliationId: null, ...overrides
      }),
      costLedgerOnConnection: (name) => services[name],
      factServiceOnConnection: (name) => factServices[name],
      seedWonAuthority: async (input) => {
        const attributionSnapshot = {
          attributionVersion: "acquisition-run.v1", runId: "run-1",
          planId: "plan-1", planVersionId: "plan-version-1", planVersion: 1,
          planSnapshotHash: "sha256:plan", discoveredEventId: "discovered-1",
          discoveredAt: "2026-08-01T00:00:00.000Z", shardId: "shard-1",
          operationId: "operation-1", connectionId: "connection-1",
          providerId: "provider-1", evidenceIds: ["evidence-1"],
          providerIds: ["provider-1"], queryIds: ["query-1"],
          strategyVersion: "strategy-1", qualificationDecisionId: "qualification-1",
          decisionVersion: "decision-1", decisionSnapshotHash: "sha256:decision"
        };
        const bindingBase = {
          candidateId: "candidate-1", handoffId: "handoff-1",
          leadId: "lead-1", customerId: "customer-1", dealId: "deal-1",
          candidateVersion: 1, handoffContentHash: "sha256:handoff",
          dealContentHash: "sha256:deal",
          bindingHashSchemaVersion: "commercial-binding.v1",
          attributionSnapshot,
          verifiedAt: "2026-08-08T02:00:00.000Z"
        };
        const bindingHash = `sha256:${createHash("sha256")
          .update(canonicalJsonStringify({
            customerId: bindingBase.customerId,
            handoffContentHash: bindingBase.handoffContentHash,
            dealContentHash: bindingBase.dealContentHash,
            bindingHashSchemaVersion: bindingBase.bindingHashSchemaVersion
          }) ?? "")
          .digest("hex")}` as `sha256:${string}`;
        const snapshot = Object.freeze({
          ...bindingBase,
          bindingHash
        }) as unknown as CommercialBindingSnapshot;
        const evidence = Object.freeze({
          candidateId: snapshot.candidateId,
          customerId: snapshot.customerId,
          dealId: snapshot.dealId,
          handoffContentHash: snapshot.handoffContentHash,
          dealContentHash: snapshot.dealContentHash,
          bindingHashSchemaVersion: snapshot.bindingHashSchemaVersion,
          bindingHash: snapshot.bindingHash
        });
        wonDecision = Object.freeze({
          type: "won",
          dealId: "deal-1",
          quoteCaseId: "case-1",
          quoteVersionId: "quote-1",
          currency: input.currency,
          quotedAmountMinor: input.quotedAmountMinor,
          commercialAmountHash: input.commercialAmountHash as
            `sha256:${string}`,
          commercialBindingEvidence: evidence,
          commercialBindingSnapshot: snapshot,
          authorityRevision: 3,
          decidedAt: "2026-08-08T00:00:00.000Z"
        });
        currentBinding = Object.freeze({
          ...snapshot,
          verifiedAt: "2026-08-09T02:00:00.000Z"
        });
      },
      replaceCurrentBinding: (overrides) => {
        if (!currentBinding) {
          throw new Error("won_authority_required");
        }
        currentBinding = Object.freeze({
          ...currentBinding,
          ...overrides
        });
      },
      createDirectRevenueAndGrossProfit: async ({
        revenueMinor, grossProfitMinor, currency
      }) => {
        const derived = deriveRevenueAndCogs({
          revenueMinor, grossProfitMinor
        });
        if (!derived) throw new Error("revenue_required");
        const base = {
          candidateId: null,
          customerId: null,
          dealId: null,
          currency,
          businessOccurredAt: "2026-08-08T00:00:00.000Z",
          provenance: "derived_from_import" as const,
          sourceRef: null,
          externalId: null
        };
        const revenue = await factServices.a.createPending(
          command("workspace-a", `direct-revenue-${randomUUID()}`),
          {
            ...base,
            factType: "revenue_recognized",
            amountMinor: derived.revenueMinor,
            evidenceHash: `sha256:revenue-${randomUUID()}`,
            sourceIdentityRoot: `external:direct:revenue-${randomUUID()}`
          }
        );
        const cogs = await factServices.a.createPending(
          command("workspace-a", `direct-cogs-${randomUUID()}`),
          {
            ...base,
            factType: "cogs_recognized",
            amountMinor: derived.cogsMinor ?? 0,
            evidenceHash: `sha256:cogs-${randomUUID()}`,
            sourceIdentityRoot: `external:direct:cogs-${randomUUID()}`
          }
        );
        return { ids: [revenue.fact.id, cogs.fact.id] };
      },
      correctDirectRevenueAndGrossProfit: async ({
        ids, expectedRevision, revenueMinor, grossProfitMinor, currency
      }) => {
        const derived = deriveRevenueAndCogs({
          revenueMinor, grossProfitMinor
        });
        if (!derived) throw new Error("revenue_required");
        const [revenueId, cogsId] = ids;
        if (!revenueId || !cogsId) throw new Error("invalid_fact_ids");
        const revenueFact = await repositoryA.getFinancialFact(
          "workspace-a", revenueId
        );
        const cogsFact = await repositoryA.getFinancialFact(
          "workspace-a", cogsId
        );
        if (!revenueFact || !cogsFact) {
          throw new Error("financial_fact_not_found");
        }
        await factServices.a.correct(
          command("workspace-a", `correct-revenue-${randomUUID()}`, expectedRevision),
          {
            factId: revenueId,
            replacement: {
              candidateId: null, customerId: null, dealId: null,
              factType: "revenue_recognized",
              amountMinor: derived.revenueMinor,
              currency,
              businessOccurredAt: "2026-08-08T00:00:00.000Z",
              provenance: "derived_from_import",
              sourceRef: null,
              evidenceHash: `sha256:revenue-corrected-${randomUUID()}`,
              externalId: null,
              sourceIdentityRoot: revenueFact.sourceIdentityRoot
            },
            reason: "reissue"
          }
        );
        await factServices.a.correct(
          command("workspace-a", `correct-cogs-${randomUUID()}`, expectedRevision),
          {
            factId: cogsId,
            replacement: {
              candidateId: null, customerId: null, dealId: null,
              factType: "cogs_recognized",
              amountMinor: derived.cogsMinor ?? 0,
              currency,
              businessOccurredAt: "2026-08-08T00:00:00.000Z",
              provenance: "derived_from_import",
              sourceRef: null,
              evidenceHash: `sha256:cogs-corrected-${randomUUID()}`,
              externalId: null,
              sourceIdentityRoot: cogsFact.sourceIdentityRoot
            },
            reason: "reissue"
          }
        );
      },
      readFactAmounts: async (ids) => {
        const rows = await Promise.all(ids.map((id) =>
          repositoryA.getFinancialFact("workspace-a", id)));
        return rows.map((row) => row?.amountMinor);
      },
      verifyFacts: async (ids, { expectedRevision }) => {
        for (const id of ids) {
          await factServices.a.verify(
            command("workspace-a", `verify-fact-${id}`, expectedRevision),
            { factId: id, reason: "checked" }
          );
        }
      },
      financialLedgerCounts: async () => {
        const [factRows] = await pool!.query(
          `SELECT COUNT(*) AS count FROM financial_facts
           WHERE workspace_id = 'workspace-a'`
        );
        const [eventRows] = await pool!.query(
          `SELECT COUNT(*) AS count FROM ledger_verification_events
           WHERE workspace_id = 'workspace-a' AND ledger_type = 'financial'`
        );
        const [headRows] = await pool!.query(
          `SELECT COUNT(*) AS count FROM ledger_source_heads
           WHERE workspace_id = 'workspace-a' AND ledger_type = 'financial'`
        );
        return {
          facts: Number((factRows as Array<{ count: string }>)[0]?.count),
          events: Number((eventRows as Array<{ count: string }>)[0]?.count),
          sourceHeads: Number((headRows as Array<{ count: string }>)[0]?.count)
        };
      },
      setSessionTimestamp3: async (name, value) => {
        const seconds = Math.floor(Date.parse(value) / 1000);
        if (!Number.isSafeInteger(seconds)) throw new Error("invalid_test_timestamp");
        await connections[name].query("SET timestamp = ?", [seconds]);
      },
      currentTimestamp3OnConnection: async (name) => {
        const [rows] = await connections[name].query(
          "SELECT CURRENT_TIMESTAMP(3) AS current_timestamp_3"
        );
        const row = (rows as Array<Record<string, unknown>>)[0];
        if (!row) throw new Error("growth_database_clock_missing");
        return growthMysqlInstant(row.current_timestamp_3);
      },
      sealReadCutoffOnConnection: async (_name, workspace, effectiveCutoff) =>
        foundation.temporalBarrier.sealReadCutoff(workspace, effectiveCutoff),
      businessLockTrace: (_key) => repositories.b.lockTraces.find((trace) =>
        trace.some((lock) => lock.startsWith("source:"))) ?? [],
      reReadOldCutoffAfterLaterAppend: (cutoff, entryId) =>
        verifiedSealedReader.listVerifiedCostsAt(cutoff, {
          currency: "CNY", entryIds: [entryId]
        }),
      seedHistoricalLedger: async (input) => {
        if (!Number.isSafeInteger(input.amountMinor)) throw new Error("invalid_ledger_amount_minor");
        const bindingHash = `sha256:${createHash("sha256")
          .update(canonicalJsonStringify({
            customerId: input.customerId,
            handoffContentHash: "sha256:handoff",
            dealContentHash: "sha256:deal",
            bindingHashSchemaVersion: "commercial-binding.v1"
          }) ?? "")
          .digest("hex")}`;
        const binding = JSON.stringify({
          candidateId: input.candidateId, handoffId: "handoff-1", leadId: "lead-1",
          customerId: input.customerId, dealId: input.dealId, candidateVersion: 1,
          handoffContentHash: "sha256:handoff", dealContentHash: "sha256:deal",
          bindingHashSchemaVersion: "commercial-binding.v1",
          attributionSnapshot: {
            attributionVersion: "acquisition-run.v1", runId: "run-1", planId: "plan-1",
            planVersionId: "plan-version-1", planVersion: 1,
            planSnapshotHash: "sha256:plan", discoveredEventId: "discovered-1",
            discoveredAt: "2026-08-01T00:00:00.000Z", shardId: "shard-1",
            operationId: "operation-1", connectionId: "connection-1",
            providerId: "provider-1", evidenceIds: ["evidence-1"],
            providerIds: ["provider-1"], queryIds: ["query-1"],
            strategyVersion: "strategy-1", qualificationDecisionId: "qualification-1",
            decisionVersion: "decision-1", decisionSnapshotHash: "sha256:decision"
          },
          bindingHash,
          verifiedAt: "2026-08-01T00:00:00.000Z"
        });
        await pool!.query(
          `INSERT INTO financial_facts (
            id, workspace_id, candidate_id, customer_id, deal_id, quote_version_id,
            fact_type, amount_minor, currency, business_occurred_at, recorded_at,
            temporal_sequence, provenance, source_ref, evidence_hash, external_id,
            source_identity_root, source_version, attribution_snapshot_json,
            commercial_binding_snapshot_json, commercial_amount_hash,
            deal_authority_revision, corrects_fact_id, correction_group_id, created_by
          ) VALUES (${Array(25).fill("?").join(", ")})`,
          [input.entryId, "workspace-a", input.candidateId, input.customerId,
            input.dealId, input.quoteVersionId, input.factType, input.amountMinor,
            "CNY", growthMysqlDate(input.businessOccurredAt),
            growthMysqlDate(input.recordedAt), 1, "invoice_confirmed", "seed://fact",
            input.evidenceHash, input.entryId, `external:seed:${input.entryId}`, 1,
            null, binding, "sha256:commercial", 1, null, null, "finance-a"]
        );
        await pool!.query(
          `INSERT INTO ledger_verification_events (
            id, workspace_id, ledger_type, ledger_entry_id, event_type,
            reverses_event_id, event_sequence, revision, correction_group_id,
            reason, decided_by, recorded_at, temporal_sequence
          ) VALUES (?, 'workspace-a', 'financial', ?, 'verified', NULL, 1, 2,
            NULL, 'checked', 'finance-a', ?, 2)`,
          [`verify-${input.entryId}`, input.entryId,
            growthMysqlDate(input.verificationRecordedAt)]
        );
        let sequence = 2;
        let lastRecordedAt = input.verificationRecordedAt;
        if (input.reversalRecordedAt) {
          await pool!.query(
            `INSERT INTO ledger_verification_events (
              id, workspace_id, ledger_type, ledger_entry_id, event_type,
              reverses_event_id, event_sequence, revision, correction_group_id,
              reason, decided_by, recorded_at, temporal_sequence
            ) VALUES (?, 'workspace-a', 'financial', ?, 'reversed', ?, 2, 3,
              NULL, 'reversed', 'finance-a', ?, 3)`,
            [`reverse-${input.entryId}`, input.entryId, `verify-${input.entryId}`,
              growthMysqlDate(input.reversalRecordedAt)]
          );
          sequence = 3;
          lastRecordedAt = input.reversalRecordedAt;
        }
        await pool!.query(
          `INSERT INTO growth_workspace_temporal_barriers (
            workspace_id, last_recorded_at, temporal_sequence
          ) VALUES ('workspace-a', ?, ?)
          ON DUPLICATE KEY UPDATE last_recorded_at = VALUES(last_recorded_at),
            temporal_sequence = VALUES(temporal_sequence)`,
          [growthMysqlDate(lastRecordedAt), sequence]
        );
      },
      importRepository,
      financeImportWorker: () => importWorker,
      financeImportRecoverySweeper: () =>
        new DefaultFinanceImportRecoverySweeper({
          repository: importRepository,
          worker: importWorker,
          authorizer: {
            async commandFor(current) {
              return command(current.workspaceId, current.idempotencyKey);
            }
          },
          workerId: "finance-mysql-recovery",
          intervalMs: 5_000,
          batchSize: 10,
          now: importNow,
          onError: () => undefined
        }),
      insertFinanceImportOperation: async (input) => {
        const previewId = `preview-${randomUUID()}`;
        const operationId = `operation-${randomUUID()}`;
        const rows = input.rows ?? 1;
        const factType = input.factType ?? "revenue_recognized";
        const amountMinor = input.amountMinor ?? 1000;
        const currency = input.currency ?? "CNY";
        const fileHash = `sha256:file-${randomUUID()}`;
        const derivedFacts = input.revenueMinor !== undefined
          ? (() => {
              const bypass = input.bypassPreviewForCommitIntegrityTest;
              const revenue = input.revenueMinor!;
              const grossProfit = input.grossProfitMinor ?? null;
              if (bypass) {
                return [
                  { factType: "revenue_recognized" as const,
                    amountMinor: revenue },
                  { factType: "cogs_recognized" as const,
                    amountMinor: revenue - (grossProfit ?? 0),
                    provenance: "derived_from_import" as const }
                ];
              }
              const derived = deriveRevenueAndCogs({
                revenueMinor: revenue,
                grossProfitMinor: grossProfit
              });
              const facts: Array<{
                factType: "revenue_recognized" | "cogs_recognized";
                amountMinor: number;
                provenance?: "derived_from_import";
              }> = derived ? [{
                factType: "revenue_recognized",
                amountMinor: derived.revenueMinor
              }] : [];
              if (derived?.cogsMinor !== null && derived) {
                facts.push({
                  factType: "cogs_recognized",
                  amountMinor: derived.cogsMinor!,
                  provenance: "derived_from_import"
                });
              }
              return facts;
            })()
          : [{ factType, amountMinor }];
        const storedRows: FinanceImportStoredRowInput[] = Array.from(
          { length: rows },
          (_, rowIndex) => {
            const rowNumber = rowIndex + 1;
            const isContract = factType === "contract_won";
            return Object.freeze({
              id: `row-${previewId}-${rowNumber}`,
              previewId,
              rowNumber,
              sheetName: "CSV",
              status: "valid",
              sourceIdentityRoot: `finance-import-row:${previewId}:${rowNumber}`,
              normalized: Object.freeze({
                kind: "financial_fact",
                candidateId: isContract
                  ? input.frozenCandidateId ?? "candidate-1" : null,
                customerId: isContract ? "customer-1" : null,
                dealId: isContract ? "deal-1" : null,
                currency,
                businessOccurredAt: "2026-08-08T16:00:00.000Z",
                externalId: `external-${previewId}-${rowNumber}`,
                evidenceHash: `sha256:row-${previewId}-${rowNumber}`,
                derivedFacts: derivedFacts.map((fact) => ({ ...fact })),
                authoritativeDecision: isContract ? wonDecision : null,
                derivationInputs: input.revenueMinor !== undefined
                  ? {
                      revenueMinor: input.revenueMinor,
                      grossProfitMinor: input.grossProfitMinor ?? null
                    }
                  : null
              }),
              errors: []
            });
          }
        );
        const previewRequestHash = canonicalGrowthRequestHash({
          workspaceId: "workspace-a",
          fileHash
        });
        await importRepository.appendPreview({
          id: previewId,
          workspaceId: "workspace-a",
          createdBy: "finance-a",
          previewRequestHash,
          fileHash,
          templateVersion: "finance-fact-import.v1",
          kind: "financial_fact",
          resolvedTimeZone: "Asia/Shanghai",
          workspaceSettingsRevision: "settings-1",
          workspaceSettingsRecordedAt: DEFAULT_NOW,
          workspaceSettingsEventSequence: 1,
          validRows: rows,
          invalidRows: 0,
          authorityEffectiveAsOf: DEFAULT_NOW,
          authorityTemporalSequence: 1
        }, storedRows);
        const operationInput: FinanceImportOperationInput = Object.freeze({
          id: operationId,
          previewId,
          workspaceId: "workspace-a",
          requestingActorId: "finance-a",
          idempotencyKey: "finance-commit-0001",
          requestHash: canonicalGrowthRequestHash({
            workspaceId: "workspace-a",
            previewId,
            operationId
          }),
          previewRequestHash,
          fileHash,
          templateVersion: "finance-fact-import.v1",
          status: input.status === "running" ? "running" : "queued",
          validRows: rows,
          invalidRows: 0,
          leaseOwner: input.expiredOwner ?? null,
          leaseExpiresAt: input.status === "running"
            ? new Date(importClock - 60_000).toISOString() : null,
          fencingToken: input.status === "running" ? 1 : 0,
          resultCreatedIds: [],
          lastErrorCode: null
        });
        await importRepository.appendOperation(operationInput);
        return operationId;
      },
      commandContext: (operationId) => command(
        "workspace-a", "finance-commit-0001"
      ),
      rowResult: () => ({
        rowId: "row-1",
        status: "created",
        createdLedgerIds: []
      }),
      countCreatedLedgerRows: async (operationId) => {
        const [rows] = await pool!.query(
          `SELECT COUNT(*) AS count FROM financial_facts
           WHERE workspace_id = 'workspace-a'
             AND source_identity_root LIKE 'import:%'`
        );
        void operationId;
        return Number((rows as Array<{ count: string }>)[0]?.count);
      },
      countFinanceImportRowResults: async (operationId) =>
        (await importRepository.listRowResults(operationId)).length,
      listImportOperationEvents: (operationId) =>
        importRepository.listOperationEvents(operationId),
      writeLockTraces: (operationId) => {
        const traces: string[][] = [];
        let current: string[] = [];
        for (const label of lockLabels) {
          if (label.startsWith("temporal:")) {
            if (current.length > 0) traces.push(current);
            current = [label];
          } else {
            current.push(label);
          }
        }
        if (current.length > 0) traces.push(current);
        return traces.filter((trace) =>
          trace.includes(`operation:${operationId}`)
          || trace.length === 1);
      },
      tamperOperationPreviewLink: async (operationId, { fileHash }) => {
        await pool!.query(
          "UPDATE finance_import_operations SET file_hash = ? WHERE id = ?",
          [fileHash, operationId]
        );
      },
      setNow: (value) => {
        importClock = growthInstantMilliseconds(value);
      },
      advanceNowBy: (milliseconds) => {
        importClock += milliseconds;
        return importNow();
      },
      replaceWonAuthority: (overrides) => {
        if (!wonDecision) throw new Error("won_authority_required");
        wonDecision = Object.freeze({ ...wonDecision, ...overrides });
      },
      restoreWonAuthorityFor: () => {
        wonDecision = wonQuoteFixture();
      },
      attributionService: () => attributionService,
      repository: attributionRepository,
      context: (key: string) => command("workspace-a", key),
      settlementService: () => settlementService,
      settlementRepository,
      insertVerifiedRevenue: async (id: string, dealId: string, amountMinor: number) => {
        await pool!.query(
          `INSERT INTO financial_facts (
            id, workspace_id, candidate_id, customer_id, deal_id,
            quote_version_id, fact_type, amount_minor, currency,
            business_occurred_at, recorded_at, temporal_sequence,
            provenance, source_ref, evidence_hash, external_id,
            source_identity_root, source_version, attribution_snapshot_json,
            commercial_binding_snapshot_json, commercial_amount_hash,
            deal_authority_revision, corrects_fact_id, correction_group_id,
            created_by
          ) VALUES (?, 'workspace-a', NULL, NULL, ?, 'quote-1',
            'revenue_recognized', ?, 'CNY', '2026-08-09 00:00:00.000',
            '2026-08-09 00:00:00.000', 1, 'invoice_confirmed', NULL,
            'sha256:test', NULL, ?, 1, NULL, NULL, NULL, NULL, NULL, NULL,
            'finance-a')`,
          [id, dealId, amountMinor, `external:${id}`]
        );
      },
      insertVerifiedPayment: async (id: string, dealId: string, amountMinor: number) => {
        await pool!.query(
          `INSERT INTO financial_facts (
            id, workspace_id, candidate_id, customer_id, deal_id,
            quote_version_id, fact_type, amount_minor, currency,
            business_occurred_at, recorded_at, temporal_sequence,
            provenance, source_ref, evidence_hash, external_id,
            source_identity_root, source_version, attribution_snapshot_json,
            commercial_binding_snapshot_json, commercial_amount_hash,
            deal_authority_revision, corrects_fact_id, correction_group_id,
            created_by
          ) VALUES (?, 'workspace-a', NULL, NULL, ?, 'quote-1',
            'payment_received', ?, 'CNY', '2026-08-09 00:00:00.000',
            '2026-08-09 00:00:00.000', 1, 'bank_statement', NULL,
            'sha256:test', NULL, ?, 1, NULL, NULL, NULL, NULL, NULL, NULL,
            'finance-a')`,
          [id, dealId, amountMinor, `external:${id}`]
        );
      },
      insertVerifiedBadDebt: async (id: string, dealId: string, amountMinor: number) => {
        await pool!.query(
          `INSERT INTO financial_facts (
            id, workspace_id, candidate_id, customer_id, deal_id,
            quote_version_id, fact_type, amount_minor, currency,
            business_occurred_at, recorded_at, temporal_sequence,
            provenance, source_ref, evidence_hash, external_id,
            source_identity_root, source_version, attribution_snapshot_json,
            commercial_binding_snapshot_json, commercial_amount_hash,
            deal_authority_revision, corrects_fact_id, correction_group_id,
            created_by
          ) VALUES (?, 'workspace-a', NULL, NULL, ?, 'quote-1',
            'bad_debt_written_off', ?, 'CNY', '2026-08-09 00:00:00.000',
            '2026-08-09 00:00:00.000', 1, 'manual_verified', NULL,
            'sha256:test', NULL, ?, 1, NULL, NULL, NULL, NULL, NULL, NULL,
            'finance-a')`,
          [id, dealId, amountMinor, `external:${id}`]
        );
      },
      closureRepository: () => roiClosureRepository
    };
    return await testBody(fixture);
  } finally {
    connectionB?.release();
    connectionA?.release();
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  }
}
