import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { AcquisitionCostLedgerService } from "./acquisition-cost-ledger.js";
import {
  createAcquisitionCostLedgerRouter
} from "./acquisition-cost-ledger-router.js";
import { FinancialFactLedgerService } from "./financial-fact-ledger.js";
import { createFinancialFactRouter } from "./financial-fact-router.js";
import { FinanceImportService } from "./finance-import-service.js";
import { createFinanceImportRouter } from "./finance-import-router.js";
import {
  InMemoryFinanceImportRepository
} from "./finance-import-repository.js";
import {
  InMemoryFinancialLedgerRepository
} from "./financial-ledger-repository.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { commandContextFromRequest } from "./growth-http-preconditions.js";
import {
  foundationServicesFixture,
  wonQuoteFixture
} from "./growth-finance-test-fixtures.js";
import type { GrowthCapability } from "./growth-capabilities.js";
import { GrowthAuthorizationError } from "./growth-capabilities.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const NOW = "2026-08-09T08:00:00.000Z";

export interface MountedGrowthFinanceRouters {
  request(
    path: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    }
  ): Promise<{ response: globalThis.Response; body: any }>;
  close(): Promise<void>;
  domainWriteCounts(): Promise<{
    costEntries: number;
    financialFacts: number;
    importOperations: number;
  }>;
  validPreviewBody(): Record<string, unknown>;
  createPendingCost(key: string): Promise<{
    id: string;
    etag: string;
    response: globalThis.Response;
    body: any;
  }>;
  verifyCost(id: string, etag: string): Promise<{
    response: globalThis.Response;
    body: any;
  }>;
  grant(capability: GrowthCapability): void;
  revoke(capability: GrowthCapability): void;
  previewContractWon(key: string): Promise<{
    response: globalThis.Response;
    body: any;
  }>;
  commitPreview(previewId: string, key: string): Promise<{
    response: globalThis.Response;
    body: any;
  }>;
  internalStoredRow(
    previewId: string,
    rowNumber: number
  ): Promise<import("./finance-import-repository.js").FinanceImportStoredRow | null>;
}

export async function mountGrowthFinanceRouters(options: {
  role?: "sales" | "manager" | "admin";
  capabilities?: GrowthCapability[];
} = {}): Promise<MountedGrowthFinanceRouters> {
  const role = options.role ?? "admin";
  const mutableCapabilities = [...(options.capabilities ?? [
    "ledger.pending.create", "ledger.verify"
  ])];
  const ledgerRepository = new InMemoryFinancialLedgerRepository(
    {}, NOW
  );
  const transactions = new InMemoryGrowthTemporalTransactionRunner(NOW);
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const foundation = foundationServicesFixture({
    temporalTransactions: transactions,
    temporalBarrier: barrier
  });
  const importRepository = new InMemoryFinanceImportRepository(
    transactions, barrier
  );
  const wonDecision = wonQuoteFixture();
  const costLedger = new AcquisitionCostLedgerService({
    repository: ledgerRepository,
    foundation
  });
  const financialFacts = new FinancialFactLedgerService({
    repository: ledgerRepository,
    foundation,
    bindingVerifier: {
      async verify() {
        return Object.freeze({
          ...wonDecision.commercialBindingSnapshot,
          verifiedAt: "2026-08-09T02:00:00.000Z"
        });
      }
    },
    dealQuoteReader: {
      async getDecisionAt() {
        return wonDecision;
      }
    }
  });
  const imports = new FinanceImportService({
    repository: importRepository,
    foundation,
    now: () => NOW,
    bindingVerifier: {
      async verify() {
        return Object.freeze({
          ...wonDecision.commercialBindingSnapshot,
          verifiedAt: "2026-08-09T02:00:00.000Z"
        });
      }
    },
    dealQuoteReader: {
      async getDecisionAt() {
        return wonDecision;
      }
    }
  });
  const workspaceContext = (req: Request): ActiveWorkspaceContext => {
    const workspaceId = req.header("X-Workspace-Id")?.trim() ?? "workspace-a";
    return Object.freeze({
      workspaceId,
      kind: "team",
      actorId: req.header("X-Actor-Id")?.trim() ?? "finance-a",
      role,
      teamId: workspaceId,
      capabilities: Object.freeze([...mutableCapabilities]),
      capabilityRegistryVersion: "growth-capabilities.v1"
    });
  };
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use((req, _res, next) => {
    req.activeWorkspace = workspaceContext(req);
    next();
  });
  app.use(createAcquisitionCostLedgerRouter({
    ledger: costLedger,
    workspaceContext,
    commandContextFactory: commandContextFromRequest
  }));
  app.use(createFinancialFactRouter({
    ledger: financialFacts,
    workspaceContext,
    commandContextFactory: commandContextFromRequest
  }));
  app.use(createFinanceImportRouter({
    imports,
    workspaceContext,
    commandContextFactory: commandContextFromRequest,
    now: () => NOW
  }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof GrowthAuthorizationError
      ? 403
      : typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status : 500;
    const code = typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code : "internal_error";
    res.status(status).json({
      code,
      message: code,
      details: null,
      requestId: randomUUID(),
      retryable: false
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const request = async (
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    } = {}
  ) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "X-Workspace-Id": "workspace-a",
        ...(init.body === undefined ? {} : {
          "Content-Type": "application/json"
        }),
        ...init.headers
      },
      body: init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body)
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { response, body };
  };
  const validPreviewBody = () => {
    const csv = [
      "externalId,factType,amount,currency,businessOccurredAt,provenance,status",
      "fact-1,revenue_recognized,1000.00,CNY,2026-08-09,portal_export,pending"
    ].join("\n");
    return {
      kind: "financial_fact",
      fileName: "facts.csv",
      mediaType: "text/csv",
      contentBase64: Buffer.from(csv).toString("base64"),
      mapping: {
        externalId: "externalId",
        factType: "factType",
        amount: "amount",
        currency: "currency",
        businessOccurredAt: "businessOccurredAt",
        provenance: "provenance",
        status: "status"
      }
    };
  };
  return {
    request,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
    domainWriteCounts: async () => ({
      costEntries: (await ledgerRepository.listCostEntries("workspace-a"))
        .length,
      financialFacts: (await ledgerRepository.listFinancialFacts("workspace-a"))
        .length,
      importOperations: importRepository.countOperations()
    }),
    validPreviewBody,
    createPendingCost: async (key: string) => {
      const result = await request("/api/v1/acquisition/cost-entries", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: {
          platform: "douyin",
          planId: null,
          runId: null,
          providerId: null,
          category: "media",
          amountMinor: 10_000,
          currency: "CNY",
          businessOccurredAt: NOW,
          provenance: "portal_export",
          sourceRef: null,
          evidenceHash: `sha256:${"a".repeat(64)}`,
          externalId: null,
          sourceIdentityRoot: `external:portal:${key}`,
          estimateReconciliationId: null
        }
      });
      return {
        id: (result.body as { id: string }).id,
        etag: `"cost-entry:${(result.body as { id: string }).id}`
          + `:${(result.body as { revision: number }).revision}"`,
        response: result.response,
        body: result.body
      };
    },
    verifyCost: async (id: string, etag: string) =>
      request(`/api/v1/acquisition/cost-entries/${id}/verify`, {
        method: "POST",
        headers: {
          "Idempotency-Key": `verify-${randomUUID()}`,
          "If-Match": etag
        },
        body: { reason: "checked" }
      }),
    grant: (capability) => {
      if (!mutableCapabilities.includes(capability)) {
        mutableCapabilities.push(capability);
      }
    },
    revoke: (capability) => {
      const index = mutableCapabilities.indexOf(capability);
      if (index >= 0) mutableCapabilities.splice(index, 1);
    },
    previewContractWon: async (key: string) => {
      const csv = [
        "externalId,factType,amount,currency,businessOccurredAt,provenance,status,candidateId,customerId,dealId",
        "contract-1,contract_won,2980.00,CNY,2026-08-09,portal_export,pending,candidate-1,customer-1,deal-1"
      ].join("\n");
      return request("/api/v1/finance/imports/preview", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: {
          kind: "financial_fact",
          fileName: "contract.csv",
          mediaType: "text/csv",
          contentBase64: Buffer.from(csv).toString("base64"),
          mapping: {
            externalId: "externalId",
            factType: "factType",
            amount: "amount",
            currency: "currency",
            businessOccurredAt: "businessOccurredAt",
            provenance: "provenance",
            status: "status",
            candidateId: "candidateId",
            customerId: "customerId",
            dealId: "dealId"
          }
        }
      });
    },
    commitPreview: async (previewId: string, key: string) =>
      request(`/api/v1/finance/imports/${previewId}/commit`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: {}
      }),
    internalStoredRow: (previewId, rowNumber) =>
      importRepository.getStoredRow(previewId, rowNumber)
  };
}
