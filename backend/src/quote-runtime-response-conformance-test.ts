import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import express from "express";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import { commandContextFromRequest } from "./growth-http-preconditions.js";
import { loadGrowthContractRelease } from "./growth-openapi.js";
import { createQuoteRouter } from "./quote-router.js";
import { QuoteCalculationService } from "./quote-calculation-service.js";
import {
  approvalFixture,
  quoteInputFixture,
  quotePolicyFixture
} from "./growth-quote-test-fixtures.js";

const NOW = "2026-08-09T08:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}` as const;

const operations = Object.freeze({
  listQuoteCases: ["/api/v1/quotes/cases", "get"],
  createQuoteCase: ["/api/v1/quotes/cases", "post"],
  getQuoteCase: ["/api/v1/quotes/cases/{id}", "get"],
  bindQuoteCaseDeal: ["/api/v1/quotes/cases/{id}/bind-deal", "post"],
  closeQuoteCase: ["/api/v1/quotes/cases/{id}/close", "post"],
  cancelQuoteCase: ["/api/v1/quotes/cases/{id}/cancel", "post"],
  previewQuote: ["/api/v1/quotes/cases/{id}/preview", "post"],
  listQuoteVersions: ["/api/v1/quotes/cases/{id}/versions", "get"],
  createQuoteVersion: ["/api/v1/quotes/cases/{id}/versions", "post"],
  getQuoteVersion: ["/api/v1/quotes/versions/{id}", "get"],
  submitQuoteVersion: ["/api/v1/quotes/versions/{id}/submit", "post"],
  approveQuoteVersion: ["/api/v1/quotes/versions/{id}/approve", "post"],
  rejectQuoteVersion: ["/api/v1/quotes/versions/{id}/reject", "post"],
  expireQuoteVersion: ["/api/v1/quotes/versions/{id}/expire", "post"],
  listQuoteApprovals: ["/api/v1/quotes/versions/{id}/approvals", "get"],
  getQuotePublicationOperation:
    ["/api/v1/quotes/publication-operations/{id}", "get"],
  retryQuotePublicationOperation:
    ["/api/v1/quotes/publication-operations/{id}/retry", "post"],
  decideQuoteDeal: ["/api/v1/quotes/deals/{dealId}/decision", "post"]
} as const);

type OperationId = keyof typeof operations;

export async function assertQuoteRuntimeResponsesConform(): Promise<void> {
  const release = loadGrowthContractRelease();
  assert.equal(release.manifest.contractVersion, "1.0.10");
  const document = release.document as Record<string, any>;
  const components = structuredClone(document.components);
  for (const schema of Object.values(components.schemas)) {
    if (schema && typeof schema === "object") delete (schema as any).$id;
  }
  const root = {
    $schema: "https://json-schema.org/draft/2020-12/schema", components
  };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const assertResponse = (operationId: OperationId, status: number,
    body: unknown, response: Response) => {
    const [path, method] = operations[operationId];
    const operation = document.paths[path][method];
    assert.equal(operation.operationId, operationId);
    const unresolved = operation.responses[String(status)];
    assert.ok(unresolved, `${operationId} status ${status}`);
    const releasedResponse = unresolved.$ref
      ? document.components.responses[unresolved.$ref.split("/").at(-1)]
      : unresolved;
    const schema = releasedResponse.content["application/json"].schema;
    const validate = ajv.compile({ ...root, ...(schema.$ref
      ? { $ref: schema.$ref } : schema) });
    assert.equal(validate(body), true,
      `${operationId}: ${JSON.stringify(validate.errors)}`);
    const declaresEtag = releasedResponse.headers?.ETag !== undefined;
    assert.equal(response.headers.has("etag"), declaresEtag,
      `${operationId} ETag declaration`);
  };

  const fixture = approvalFixture();
  const storedCase = await fixture.repository.findCase("team-a", "case-1");
  assert.ok(storedCase);
  const quoteCase = Object.freeze({
    ...storedCase,
    commercialBindingSnapshot: storedCase.commercialBindingSnapshot
      ? Object.freeze({
          ...storedCase.commercialBindingSnapshot,
          attributionSnapshot: Object.freeze({
            ...storedCase.commercialBindingSnapshot.attributionSnapshot,
            decisionEngine: "rules" as const,
            ruleVersion: "qualification-rules.v2",
            modelProvider: null,
            model: null,
            promptVersion: null
          })
        })
      : null
  });
  const formal = fixture.formalVersion;
  const draft = fixture.draftVersion;
  const approval = await fixture.repository.findApprovalByQuoteVersion(
    "team-a", formal.id
  );
  assert.ok(approval);
  const inputWithWorkspace = quoteInputFixture();
  const { workspaceId: _workspace, ...quoteInput } = inputWithWorkspace;
  const preview = new QuoteCalculationService().preview(
    inputWithWorkspace, quotePolicyFixture(), {
      giftPolicies: [], packageSnapshot: null
    }
  );
  const publication = Object.freeze({
    id: "publication-1", workspaceId: "team-a", quoteCaseId: quoteCase.id,
    quoteVersionId: formal.id, dealId: "deal-1", dealAuthorityRevision: 2,
    commercialAmountHash: formal.commercialAmountHash as typeof HASH,
    status: "failed" as const, piDocumentId: null, dealEventId: null,
    attempts: 1, lastErrorCode: "crm_failed",
    idempotencyKey: "publication-stable-1", leaseOwner: null,
    fencingToken: 1, leaseExpiresAt: null, createdAt: NOW, updatedAt: NOW
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.activeWorkspace = Object.freeze({ workspaceId: "team-a", kind: "team",
      actorId: "manager-1", role: "manager", teamId: "team-a",
      capabilities: capabilitiesForHumanRole("manager"),
      capabilityRegistryVersion: "growth-capabilities.v1" });
    next();
  });
  app.use(createQuoteRouter({
    cases: {
      async list() { return { items: [quoteCase], nextCursor: null }; },
      async get() { return quoteCase; },
      async create() { return { value: quoteCase, replayed: false }; },
      async bindDeal() { return { value: { ...quoteCase, revision: 2 },
        replayed: false }; },
      async close() { return { value: { ...quoteCase, status: "closed",
        revision: 2 }, replayed: false }; },
      async cancel() { return { value: { ...quoteCase, status: "cancelled",
        revision: 2 }, replayed: false }; }
    },
    versions: {
      async preview() { return { value: preview, replayed: false }; },
      async listVersions() { return [formal]; },
      async createVersion() { return { value: draft, replayed: false }; },
      async getVersion() { return formal; },
      async submit() { return { value: { sourceDraftVersion: draft,
        submittedVersion: formal, approval }, replayed: false }; }
    },
    approvals: {
      async listForVersion() { return [approval]; },
      async approve() { return { value: { quoteVersion: { ...formal,
        status: "approved", lifecycleRevision: 2 }, approval,
        authority: {}, authorityEvent: {}, lifecycleEvents: [],
        publicationOperation: publication }, replayed: false }; },
      async reject() { return { value: { quoteVersion: formal,
        approval: { ...approval, status: "rejected", reason: "declined",
          decidedBy: "manager-1", decidedAt: NOW }, authority: {},
        authorityEvent: {}, lifecycleEvents: [], publicationOperation: publication },
        replayed: false }; },
      async expire() { return { value: { quoteVersion: { ...formal,
        status: "expired", lifecycleRevision: 2 }, approval,
        authority: {}, authorityEvent: {}, lifecycleEvents: [],
        publicationOperation: publication }, replayed: false }; }
    },
    publications: {
      async get() { return publication; },
      async retry() { return { value: { ...publication, status: "queued",
        lastErrorCode: null }, replayed: false }; }
    },
    decisions: {
      async decide() { return { value: {
        deal: { id: "deal-1", customerId: "customer-1", stage: "丢单",
          amountType: "estimate", ownerId: "sales-a", teamId: "team-a" },
        event: { id: "event-1", dealId: "deal-1", type: "lost",
          commercialAuthority: "pre_quote_disqualified",
          quoteCaseIdSnapshot: quoteCase.id, quoteVersionIdSnapshot: null,
          commercialAmountHash: null, amountMinorSnapshot: null,
          currencySnapshot: null, reasonCode: "budget", reasonText: null,
          occurredAt: NOW, recordedAt: NOW, authorityRevision: 1 },
        quoteCase, authorityRevision: 1,
        cancelledPublicationOperationIds: [] }, replayed: false }; }
    },
    workspaceContext: (req: express.Request) => req.activeWorkspace!,
    commandContextFactory: commandContextFromRequest,
    temporalBarrier: { sealReadCutoff() { throw new Error("unexpected"); } }
  } as never));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const call = async (operationId: OperationId, method: string, path: string,
      body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: { "X-Workspace-Id": "team-a",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers }, body: body === undefined ? undefined : JSON.stringify(body)
      });
      const result = await response.json();
      assertResponse(operationId, response.status, result, response);
      return { response, body: result };
    };
    const idem = (key: string, scope?: string) => ({
      "Idempotency-Key": key, ...(scope ? { "If-Match": scope } : {})
    });
    await call("listQuoteCases", "GET", "/api/v1/quotes/cases");
    await call("createQuoteCase", "POST", "/api/v1/quotes/cases",
      { candidateId: "candidate-1", assignedTo: "sales-a" }, idem("case"));
    await call("getQuoteCase", "GET", "/api/v1/quotes/cases/case-1");
    await call("bindQuoteCaseDeal", "POST",
      "/api/v1/quotes/cases/case-1/bind-deal", { dealId: "deal-1" },
      idem("bind", '"quote-case:case-1:2"'));
    await call("closeQuoteCase", "POST", "/api/v1/quotes/cases/case-1/close",
      {}, idem("close", '"quote-case:case-1:2"'));
    await call("cancelQuoteCase", "POST", "/api/v1/quotes/cases/case-1/cancel",
      {}, idem("cancel", '"quote-case:case-1:2"'));
    await call("previewQuote", "POST", "/api/v1/quotes/cases/case-1/preview",
      quoteInput, idem("preview", '"quote-case:case-1:2"'));
    await call("listQuoteVersions", "GET",
      "/api/v1/quotes/cases/case-1/versions");
    await call("createQuoteVersion", "POST",
      "/api/v1/quotes/cases/case-1/versions",
      { previewIdentity: preview.previewIdentity, quoteInput },
      idem("version", '"quote-case:case-1:2"'));
    await call("getQuoteVersion", "GET",
      `/api/v1/quotes/versions/${formal.id}`);
    await call("submitQuoteVersion", "POST",
      `/api/v1/quotes/versions/${draft.id}/submit`, {},
      idem("submit", `"quote-version:${draft.id}:1"`));
    await call("approveQuoteVersion", "POST",
      `/api/v1/quotes/versions/${formal.id}/approve`, { reason: "approved" },
      idem("approve", `"quote-version:${formal.id}:1"`));
    await call("rejectQuoteVersion", "POST",
      `/api/v1/quotes/versions/${formal.id}/reject`, { reason: "declined" },
      idem("reject", `"quote-version:${formal.id}:1"`));
    await call("expireQuoteVersion", "POST",
      `/api/v1/quotes/versions/${formal.id}/expire`, { reason: "expired" },
      idem("expire", `"quote-version:${formal.id}:1"`));
    await call("listQuoteApprovals", "GET",
      `/api/v1/quotes/versions/${formal.id}/approvals`);
    await call("getQuotePublicationOperation", "GET",
      "/api/v1/quotes/publication-operations/publication-1");
    await call("retryQuotePublicationOperation", "POST",
      "/api/v1/quotes/publication-operations/publication-1/retry", {},
      idem("retry", '"quote-publication-operation:publication-1:1"'));
    await call("decideQuoteDeal", "POST",
      "/api/v1/quotes/deals/deal-1/decision",
      { type: "pre_quote_disqualified", reasonCode: "budget",
        reasonText: null, occurredAt: NOW },
      idem("decision", '"deal-authority:deal-1:1"'));

    const malformed = await call("createQuoteCase", "POST",
      "/api/v1/quotes/cases", { candidateId: "candidate-1",
        assignedTo: "sales-a", workspaceId: "team-b" }, idem("malformed"));
    assert.equal(malformed.response.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
}

test("real Quote router responses conform to every frozen Growth 1.0.3 operation",
  assertQuoteRuntimeResponsesConform);
