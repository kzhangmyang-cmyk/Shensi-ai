import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import { createGrowthCommercialToolPorts } from
  "./growth-commercial-application.js";
import { createGrowthPrivateServiceRegistry } from
  "./growth-commercial-private-services.js";
import { GROWTH_CATALOG_SERVICES } from "./growth-catalog-module.js";
import { GROWTH_FOUNDATION_SERVICES } from "./growth-foundation-module.js";
import { createGrowthQuoteModule } from "./growth-quote-module.js";
import { commandContextFromRequest } from "./growth-http-preconditions.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { createQuoteRouter, projectQuoteVersion } from "./quote-router.js";

const NOW = "2026-08-09T08:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}` as const;

const quoteCase = Object.freeze({
  id: "case-1", workspaceId: "team-a", candidateId: "candidate-1",
  customerId: null, dealId: null, assignedTo: "sales-1", status: "open",
  currentDraftVersionId: "draft-1", revision: 1,
  commercialBindingSnapshot: null, createdAt: NOW, updatedAt: NOW
});

const pricingPolicySnapshot = Object.freeze({
  id: "policy-1", workspaceId: "team-a", catalogItemId: "item-1",
  version: 1, revision: 1, packageVersionId: null, currency: "CNY",
  listUnitPriceMinor: 30_000, unitStandardCostMinor: 10_000,
  defaultOrderDeliveryCostMinor: 1_000, defaultOrderSalesCostMinor: 500,
  defaultOrderServiceCostMinor: 400, absoluteFloorUnitPriceMinor: 20_000,
  standardDiscountLimitBps: 500, absoluteDiscountLimitBps: 1_000,
  targetGrossMarginBps: 3_000, absoluteMinimumGrossMarginBps: 2_000,
  standardPaymentTermDays: 30, absolutePaymentTermDays: 60,
  approvalThresholds: {
    discountCapability: "quote.exception.discount.approve",
    marginCapability: "quote.exception.margin.approve",
    paymentTermsCapability: "quote.exception.payment_terms.approve",
    giftCapability: "quote.exception.gift.approve",
    creditCapability: "quote.exception.credit.approve",
    manualCapability: "quote.exception.manual.approve",
    creditRiskThresholdBps: 6_000, manualEscalationEnabled: true
  },
  surchargePolicies: [], giftPolicies: [], validFrom: NOW, validTo: null,
  status: "active", source: "native", capabilityRegistryVersion:
    "growth-capabilities.v1", createdBy: "admin-1", createdAt: NOW
});

const quoteVersion = Object.freeze({
  id: "draft-1", workspaceId: "team-a", quoteCaseId: "case-1", version: 1,
  lifecycleRevision: 1, versionKind: "draft", sourceDraftVersionId: null,
  currency: "CNY", lineItems: [{ catalogItemId: "item-1",
    pricingPolicyVersionId: "policy-1", packageVersionId: null,
    quantityMicros: 1_000_000, offeredUnitPriceMinor: 29_800,
    lineAmountMinor: 29_800, standardCostMinor: 10_000 }],
  customerTargetPriceMinor: null, discountMinor: 0, surchargeMinor: 0,
  requiredSurchargeMinor: 0, paymentTerms: { days: 30 }, giftItems: [],
  listAmountMinor: 30_000, netProductAmountMinor: 29_800,
  quotedAmountMinor: 29_800, estimatedFulfillmentCostMinor: 11_000,
  estimatedSalesCostMinor: 500, estimatedServiceCostMinor: 400,
  estimatedGrossProfitMinor: 18_800, estimatedContributionMinor: 17_900,
  discountBps: 67, grossMarginBps: 6_309, approvalReasons: [],
  pricingPolicySnapshot, probabilityAssessmentSnapshot: null,
  previewIdentity: { inputSnapshotHash: HASH, calculationHash: HASH,
    pricingPolicyVersionId: "policy-1", pricingPolicyRevision: 1,
    packageVersionId: null, formulaVersion: "quote-calculation.v1" },
  commercialAmountHash: HASH, status: "draft", createdBy: "sales-1",
  createdAt: NOW, effectiveAt: NOW, recordedAt: NOW, temporalSequence: 1,
  stableCommandHash: HASH, requestHash: HASH
});

const approval = Object.freeze({
  id: "approval-1", workspaceId: "team-a", quoteVersionId: "formal-2",
  status: "pending", approvalKind: "confirmation",
  requiredCapabilities: ["quote.confirm"], triggeredRules: [],
  pricingPolicyVersionId: "policy-1", policySnapshotHash: HASH,
  capabilityRegistryVersion: "growth-capabilities.v1", submittedBy: "sales-1",
  submittedAt: NOW, decidedBy: null, decidedAt: null, reason: null
});

const publication = Object.freeze({
  id: "publication-1", workspaceId: "team-a", quoteCaseId: "case-1",
  quoteVersionId: "formal-2", dealId: "deal-1", dealAuthorityRevision: 2,
  commercialAmountHash: HASH, status: "failed", piDocumentId: null,
  dealEventId: null, attempts: 1, lastErrorCode: "crm_failed",
  idempotencyKey: "publication-stable-1", leaseOwner: null, fencingToken: 1,
  leaseExpiresAt: null, createdAt: NOW, updatedAt: NOW
});

const quoteInput = Object.freeze({
  catalogItemId: "item-1", pricingPolicyVersionId: "policy-1",
  quantityMicros: 1_000_000, offeredUnitPriceMinor: 29_800,
  orderDiscountMinor: 0, paymentTermDays: 30, giftItems: [],
  surchargeContext: { region: null, deliveryMethod: null },
  customerTargetPriceMinor: null, creditRiskBps: null,
  manualEscalation: false
});

function context(role: "sales" | "manager" = "manager",
  workspaceId = "team-a"): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId, kind: "team", actorId: role === "sales" ? "sales-1" : "manager-1",
    role, teamId: workspaceId, capabilities: capabilitiesForHumanRole(role),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

async function quoteRouterFixture() {
  const adapterCalls: unknown[] = [];
  let replay = false;
  const calls = { caseListQuery: null as unknown, retryRevision: null as unknown };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.activeWorkspace = context(
      req.header("X-Test-Role") === "sales" ? "sales" : "manager",
      req.header("X-Test-Workspace") || "team-a"
    );
    next();
  });
  app.use(createQuoteRouter({
    cases: {
      async list(_context: unknown, query: unknown) {
        calls.caseListQuery = query;
        return { items: [quoteCase], nextCursor: null };
      },
      async get(_context: ActiveWorkspaceContext, id: string) {
        if (id === "missing") throw Object.assign(new Error("missing"),
          { code: "quote_case_not_found" });
        return { ...quoteCase, id };
      },
      async create() { return { value: quoteCase, replayed: replay }; },
      async bindDeal() { return { value: { ...quoteCase, dealId: "deal-1",
        revision: 2 }, replayed: replay }; },
      async close() { return { value: { ...quoteCase, status: "closed",
        revision: 2 }, replayed: replay }; },
      async cancel() { return { value: { ...quoteCase, status: "cancelled",
        revision: 2 }, replayed: replay }; }
    },
    versions: {
      async preview() {
        return { value: { amountState: "actionable", currency: "CNY",
          listAmountMinor: 30_000, netProductAmountMinor: 29_800,
          quotedAmountMinor: 29_800, requiredSurchargeMinor: 0,
          estimatedFulfillmentCostMinor: 11_000, estimatedSalesCostMinor: 500,
          estimatedServiceCostMinor: 400, estimatedGrossProfitMinor: 18_800,
          estimatedContributionMinor: 17_900, discountBps: 67,
          grossMarginBps: 6_309, minimumAllowedQuotedAmountMinor: 20_000,
          recommendedOpeningQuotedAmountMinor: 30_000,
          gate: { status: "confirmation_required", reasons: [],
            requiredCapabilities: ["quote.confirm"] },
          previewIdentity: quoteVersion.previewIdentity,
          commercialAmountHash: HASH }, replayed: replay };
      },
      async listVersions() { return [quoteVersion]; },
      async createVersion() { return { value: quoteVersion, replayed: replay }; },
      async getVersion(_context: unknown, id: string) {
        return { ...quoteVersion, id };
      },
      async submit() { return { value: { sourceDraftVersion: quoteVersion,
        submittedVersion: { ...quoteVersion, id: "formal-2", version: 2,
          versionKind: "formal", sourceDraftVersionId: "draft-1",
          status: "submitted" }, approval }, replayed: replay }; }
    },
    approvals: {
      async listForVersion() { return [approval]; },
      async approve() { return { value: { quoteVersion: { ...quoteVersion,
        id: "formal-2", status: "approved", lifecycleRevision: 2 }, approval,
        authority: {}, authorityEvent: {}, lifecycleEvents: [],
        publicationOperation: publication }, replayed: replay }; },
      async reject() { return { value: { quoteVersion, approval: {
        ...approval, status: "rejected", reason: "declined",
        decidedBy: "manager-1", decidedAt: NOW }, authority: {},
        authorityEvent: {}, lifecycleEvents: [], publicationOperation: publication },
        replayed: replay }; },
      async expire() { return { value: { quoteVersion: { ...quoteVersion,
        id: "formal-2", status: "expired", lifecycleRevision: 2 }, approval,
        authority: {}, authorityEvent: {}, lifecycleEvents: [],
        publicationOperation: publication }, replayed: replay }; }
    },
    publications: {
      async get(_context: ActiveWorkspaceContext, id: string) {
        if (id === "cross" || id === "missing") {
          throw Object.assign(new Error("missing"),
            { code: "publication_not_found" });
        }
        return { ...publication, id };
      },
      async retry(_command: unknown, id: string) {
        calls.retryRevision = id;
        return { value: { ...publication, id, status: "queued",
          lastErrorCode: null }, replayed: replay };
      }
    },
    decisions: {
      async decide() {
        return { value: { deal: { id: "deal-1", customerId: "customer-1",
          stage: "丢单", amountType: "estimate", ownerId: "sales-1",
          teamId: "team-a" }, event: { id: "event-1", dealId: "deal-1",
          type: "lost", commercialAuthority: "pre_quote_disqualified",
          quoteCaseIdSnapshot: null, quoteVersionIdSnapshot: null,
          commercialAmountHash: null, amountMinorSnapshot: null,
          currencySnapshot: null, reasonCode: "budget", reasonText: null,
          occurredAt: NOW, recordedAt: NOW, authorityRevision: 1 },
          quoteCase: null, authorityRevision: 1,
          cancelledPublicationOperationIds: [] }, replayed: replay };
      }
    },
    workspaceContext(req) {
      adapterCalls.push({ kind: "workspace", path: req.path });
      return req.activeWorkspace!;
    },
    commandContextFactory(req, input) {
      adapterCalls.push({ kind: "command", ...input });
      return commandContextFromRequest(req, input);
    },
    temporalBarrier: { sealReadCutoff() { throw new Error("unexpected seal"); } }
  } as never));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    adapterCalls, calls, setReplay(value: boolean) { replay = value; },
    async request(method: string, path: string, options: { body?: unknown;
      headers?: Record<string, string>; workspaceId?: string | null } = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.workspaceId === null ? {} : {
            "X-Workspace-Id": options.workspaceId ?? "team-a"
          }),
          ...options.headers
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
      return { response, body: await response.json() };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()))
  };
}

test("Quote writes require idempotency and exact ID-scoped revisions", async () => {
  const api = await quoteRouterFixture();
  try {
    const noKey = await api.request("POST", "/api/v1/quotes/cases", {
      body: { candidateId: "candidate-1", assignedTo: "sales-1" }
    });
    assert.equal(noKey.response.status, 400);
    assert.equal(noKey.body.code, "idempotency_key_required");

    const previewNoRevision = await api.request(
      "POST", "/api/v1/quotes/cases/case-1/preview", {
        body: quoteInput,
        headers: { "Idempotency-Key": "preview-no-revision" }
      }
    );
    assert.equal(previewNoRevision.response.status, 400);
    assert.equal(previewNoRevision.body.code, "revision_required");

    const wrongScope = await api.request(
      "POST", "/api/v1/quotes/versions/draft-1/submit", {
        body: {}, headers: { "Idempotency-Key": "submit-1",
          "If-Match": '"quote-version:another-draft:1"' }
      }
    );
    assert.equal(wrongScope.response.status, 409);
    assert.equal(wrongScope.body.code, "invalid_if_match");
  } finally { await api.close(); }
});

test("Quote bodies and queries are closed and workspace authority is header-only", async () => {
  const api = await quoteRouterFixture();
  try {
    const injected = await api.request("POST", "/api/v1/quotes/cases", {
      body: { candidateId: "candidate-1", assignedTo: "sales-1",
        workspaceId: "team-b" },
      headers: { "Idempotency-Key": "case-injection" }
    });
    assert.equal(injected.response.status, 400);
    assert.equal(injected.body.code, "invalid_request");

    const badQuery = await api.request("GET", "/api/v1/quotes/cases?status=open");
    assert.equal(badQuery.response.status, 403);
    assert.equal(badQuery.body.code, "invalid_request");

    const noWorkspace = await api.request("GET", "/api/v1/quotes/cases", {
      workspaceId: null
    });
    assert.equal(noWorkspace.response.status, 403);
    assert.equal(noWorkspace.body.code, "workspace_required");

    const listed = await api.request(
      "GET", "/api/v1/quotes/cases?cursor=next-1&limit=25&sort=updatedAt"
    );
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.body, { items: [quoteCase], nextAfter: null,
      hasMore: false });
    assert.deepEqual(api.calls.caseListQuery, { cursor: "next-1", limit: 25 });
  } finally { await api.close(); }
});

test("sales QuoteVersion projection omits policy-sensitive values without changing authority", () => {
  const body = projectQuoteVersion(quoteVersion as never,
    capabilitiesForHumanRole("sales"));
  assert.equal(body.amountVisibility, "redacted");
  assert.equal("estimatedFulfillmentCostMinor" in body, false);
  assert.equal("estimatedGrossProfitMinor" in body, false);
  assert.equal("pricingPolicySnapshot" in body, false);
  assert.equal("standardCostMinor" in body.lineItems[0]!, false);
  assert.equal(body.quotedAmountMinor, 29_800);
  assert.equal(body.commercialAmountHash, HASH);
  assert.deepEqual(Object.keys(body).sort(), [
    "amountVisibility", "approvalReasons", "commercialAmountHash", "createdAt",
    "createdBy", "currency", "customerTargetPriceMinor", "discountBps",
    "discountMinor", "giftItems", "id", "lifecycleRevision", "lineItems",
    "listAmountMinor", "netProductAmountMinor", "paymentTerms",
    "previewIdentity", "probabilityAssessmentSnapshot", "quoteCaseId",
    "quotedAmountMinor", "requiredSurchargeMinor", "status", "surchargeMinor",
    "version", "workspaceId"
  ].sort());
});

test("all frozen Quote operation success variants use exact status, body and headers", async () => {
  const api = await quoteRouterFixture();
  try {
    const call = (method: string, path: string, body?: unknown,
      headers: Record<string, string> = {}) => api.request(method, path,
      { body, headers });
    const reads = [
      await call("GET", "/api/v1/quotes/cases"),
      await call("GET", "/api/v1/quotes/cases/case-1"),
      await call("GET", "/api/v1/quotes/cases/case-1/versions"),
      await call("GET", "/api/v1/quotes/versions/draft-1"),
      await call("GET", "/api/v1/quotes/versions/formal-2/approvals"),
      await call("GET", "/api/v1/quotes/publication-operations/publication-1")
    ];
    assert.deepEqual(reads.map((item) => item.response.status),
      [200, 200, 200, 200, 200, 200]);
    assert.equal(reads[1]!.response.headers.get("etag"),
      '"quote-case:case-1:1"');
    assert.equal(reads[3]!.response.headers.get("etag"),
      '"quote-version:draft-1:1"');
    assert.equal("fencingToken" in reads[5]!.body, false);

    const created = await call("POST", "/api/v1/quotes/cases",
      { candidateId: "candidate-1", assignedTo: "sales-1" },
      { "Idempotency-Key": "case-create" });
    const bound = await call("POST", "/api/v1/quotes/cases/case-1/bind-deal",
      { dealId: "deal-1" }, { "Idempotency-Key": "case-bind",
        "If-Match": '"quote-case:case-1:1"' });
    const closed = await call("POST", "/api/v1/quotes/cases/case-1/close", {},
      { "Idempotency-Key": "case-close",
        "If-Match": '"quote-case:case-1:1"' });
    const cancelled = await call("POST", "/api/v1/quotes/cases/case-1/cancel", {},
      { "Idempotency-Key": "case-cancel",
        "If-Match": '"quote-case:case-1:1"' });
    assert.deepEqual([created, bound, closed, cancelled].map((item) =>
      item.response.status), [201, 200, 200, 200]);
    assert.equal(bound.response.headers.get("etag"), '"quote-case:case-1:2"');

    const previewed = await call("POST",
      "/api/v1/quotes/cases/case-1/preview", quoteInput,
      { "Idempotency-Key": "preview",
        "If-Match": '"quote-case:case-1:1"' });
    assert.equal(previewed.response.status, 200);
    assert.equal("commercialAmountHash" in previewed.body, false);
    assert.deepEqual(previewed.body.gate.reasons, []);
    const versionCreated = await call("POST",
      "/api/v1/quotes/cases/case-1/versions",
      { previewIdentity: quoteVersion.previewIdentity, quoteInput },
      { "Idempotency-Key": "version-create",
        "If-Match": '"quote-case:case-1:1"' });
    assert.equal(versionCreated.response.status, 201);
    assert.equal(versionCreated.response.headers.get("etag"),
      '"quote-version:draft-1:1"');

    const submit = await call("POST", "/api/v1/quotes/versions/draft-1/submit", {},
      { "Idempotency-Key": "submit", "If-Match":
        '"quote-version:draft-1:1"' });
    assert.equal(submit.response.status, 200);
    assert.deepEqual(submit.body, approval);
    assert.equal(submit.response.headers.get("etag"), null);

    const approved = await call("POST", "/api/v1/quotes/versions/formal-2/approve",
      { reason: "approved" }, { "Idempotency-Key": "approve",
        "If-Match": '"quote-version:formal-2:1"' });
    const rejected = await call("POST", "/api/v1/quotes/versions/formal-2/reject",
      { reason: "declined" }, { "Idempotency-Key": "reject",
        "If-Match": '"quote-version:formal-2:1"' });
    const expired = await call("POST", "/api/v1/quotes/versions/formal-2/expire",
      { reason: "expired" }, { "Idempotency-Key": "expire",
        "If-Match": '"quote-version:formal-2:1"' });
    assert.deepEqual([approved.response.status, rejected.response.status,
      expired.response.status], [200, 200, 200]);
    assert.equal(approved.response.headers.get("etag"),
      '"quote-version:formal-2:2"');
    assert.equal(rejected.response.headers.get("etag"), null);

    const retried = await call("POST",
      "/api/v1/quotes/publication-operations/publication-1/retry", {},
      { "Idempotency-Key": "publication-retry",
        "If-Match": '"quote-publication-operation:publication-1:1"' });
    assert.equal(retried.response.status, 202);
    assert.equal(retried.body.status, "queued");
    assert.equal(retried.response.headers.get("etag"), null);

    const decided = await call("POST", "/api/v1/quotes/deals/deal-1/decision",
      { type: "pre_quote_disqualified", reasonCode: "budget", reasonText: null,
        occurredAt: NOW }, { "Idempotency-Key": "deal-decision",
        "If-Match": '"deal-authority:deal-1:1"' });
    assert.equal(decided.response.status, 200);
    assert.equal(decided.response.headers.get("etag"), null);
  } finally { await api.close(); }
});

test("write replays expose only Idempotency-Replayed and still use current adapters", async () => {
  const api = await quoteRouterFixture();
  try {
    api.setReplay(true);
    const result = await api.request("POST",
      "/api/v1/quotes/versions/formal-2/approve", {
        body: { reason: "approved" }, headers: {
          "Idempotency-Key": "approve-replay",
          "If-Match": '"quote-version:formal-2:1"'
        }
      });
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get("idempotency-replayed"), "true");
    assert.equal(result.body.amountVisibility, "full");
    assert.deepEqual(api.adapterCalls, [{ kind: "command",
      canonicalPath: "/api/v1/quotes/versions/:id/approve",
      pathParams: { id: "formal-2" }, payload: { reason: "approved" },
      expectedRevision: 1 }]);
  } finally { await api.close(); }
});

test("Quote errors stay inside each frozen operation response matrix", async () => {
  const api = await quoteRouterFixture();
  try {
    const missing = await api.request("GET", "/api/v1/quotes/cases/missing");
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.code, "quote_case_not_found");

    const crossWorkspace = await api.request(
      "GET", "/api/v1/quotes/publication-operations/cross",
      { headers: { "X-Test-Workspace": "team-b" } }
    );
    assert.equal(crossWorkspace.response.status, 404);
    assert.equal(crossWorkspace.body.code, "publication_not_found");

    const badDecision = await api.request(
      "POST", "/api/v1/quotes/deals/deal-1/decision", {
        body: { type: "won", occurredAt: NOW }, headers: {
          "Idempotency-Key": "bad-decision",
          "If-Match": '"deal-authority:deal-1:1"'
        }
      }
    );
    assert.equal(badDecision.response.status, 400);
    assert.equal(badDecision.body.code, "invalid_request");
  } finally { await api.close(); }
});

test("Quote module mounts one router with the exact Foundation adapters", async () => {
  const privateServices = createGrowthPrivateServiceRegistry();
  const transactions = new InMemoryGrowthTemporalTransactionRunner(NOW);
  const temporalBarrier = new DefaultGrowthTemporalBarrier(transactions);
  let workspaceCalls = 0;
  const commandCalls: unknown[] = [];
  const foundation = Object.freeze({
    httpIdempotency: {}, workspaceSettings: {},
    workspaceContext(req: express.Request) {
      workspaceCalls += 1;
      return req.activeWorkspace!;
    },
    acquisitionWorkspace: { resolve: async () => null },
    commandContextFactory(req: express.Request, input: Parameters<
      typeof commandContextFromRequest
    >[1]) {
      commandCalls.push(input);
      return commandContextFromRequest(req, input);
    },
    temporalTransactions: transactions, temporalBarrier
  }) as never;
  privateServices.provide(GROWTH_FOUNDATION_SERVICES, foundation);
  privateServices.provide(GROWTH_CATALOG_SERVICES, Object.freeze({
    catalogItems: {}, pricingPolicies: {}, packageVersions: {},
    quoteCatalog: {}, commissionCatalogProjection: {}
  }) as never);
  const moduleOptions = {
    mode: "memory" as const,
    resourceFactory(input: any) {
      assert.equal(input.foundation, foundation);
      assert.equal(input.temporalBarrier, temporalBarrier);
      return {
        probabilityAssessments: {},
        quote: {
          repository: {},
          quoteCases: {},
          quoteVersions: {
            async getVersion() { return quoteVersion; },
            async submit() { return { value: { sourceDraftVersion: quoteVersion,
              submittedVersion: quoteVersion, approval }, replayed: false }; }
          },
          quoteApprovals: {},
          dealDecisions: {},
          authorityReaders: {}
        },
        async close() {}
      } as never;
    }
  };
  assert.equal("workspaceContext" in moduleOptions, false);
  assert.equal("commandContextFactory" in moduleOptions, false);
  assert.equal("temporalBarrier" in moduleOptions, false);
  const router = express.Router();
  router.use(express.json());
  router.use((req, _res, next) => {
    req.activeWorkspace = context("manager");
    next();
  });
  const handle = await createGrowthQuoteModule(moduleOptions).install({
    router, toolPorts: createGrowthCommercialToolPorts(), privateServices
  });
  const app = express();
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const read = await fetch(
      `http://127.0.0.1:${port}/api/v1/quotes/versions/draft-1`, {
        headers: { "X-Workspace-Id": "team-a" }
      });
    assert.equal(read.status, 200);
    const write = await fetch(
      `http://127.0.0.1:${port}/api/v1/quotes/versions/draft-1/submit`, {
        method: "POST", headers: { "Content-Type": "application/json",
          "X-Workspace-Id": "team-a", "Idempotency-Key": "module-submit",
          "If-Match": '"quote-version:draft-1:1"' }, body: "{}"
      });
    assert.equal(write.status, 200);
    assert.equal(workspaceCalls, 1);
    assert.deepEqual(commandCalls, [{
      canonicalPath: "/api/v1/quotes/versions/:id/submit",
      pathParams: { id: "draft-1" }, payload: {}, expectedRevision: 1
    }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
    await handle.close();
  }
});
