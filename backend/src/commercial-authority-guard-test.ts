import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "node:test";
import {
  app,
  installLegacyCommercialAuthorityProjection
} from "./server.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { getStore, type CrmStore } from "./store.js";
import type { TradeDocument } from "./types.js";
import {
  assertLegacyCommercialWriteAllowed,
  CommercialAuthorityError,
  type QuoteProjectedDocumentAuthorityValidator
} from "./commercial-authority-guard.js";

function managerWorkspace(): ActiveWorkspaceContext {
  return {
    workspaceId: "team-1",
    kind: "team",
    actorId: "owner-1",
    role: "manager",
    teamId: "team-1",
    capabilities: [],
    capabilityRegistryVersion: "growth-capabilities.v1"
  };
}

function storeFixture() {
  const attribution = {
    attributionVersion: "acquisition-run.v1" as const,
    runId: "run-1", planId: "plan-1", planVersionId: "pv-1",
    planVersion: 1, planSnapshotHash: `sha256:${"1".repeat(64)}`,
    discoveredEventId: "discovered-1",
    discoveredAt: "2026-08-01T00:00:00.000Z", shardId: "shard-1",
    operationId: "operation-1", connectionId: "connection-1",
    providerId: "provider-1", evidenceIds: ["evidence-1"],
    providerIds: ["provider-1"], queryIds: ["query-1"],
    strategyVersion: "strategy-1", qualificationDecisionId: "qd-1",
    decisionVersion: "decision-v1",
    decisionSnapshotHash: `sha256:${"2".repeat(64)}`
  };
  return {
    acquisitionCustomerHandoffs: [{
      id: "handoff-1", ownerId: "owner-1", teamId: "team-1",
      candidateId: "candidate-1", leadId: "lead-1",
      customerId: "customer-1", todoId: "todo-1", dealId: "deal-1",
      decisionVersion: "decision-v1", mode: "create_new",
      processingKeyHash: "", acceptedProcessingKeyHashes: [], requestHash: "",
      intelligence: {
        qualificationGrade: "A", qualificationScore: 90,
        financialGrade: "A", currency: "USD", expectedRevenueMinor: 1,
        expectedGrossProfitMinor: 1, expectedContributionMinor: 1
      }, qualificationSnapshotHash: "", financialSnapshotHash: "",
      acquisitionAttribution: attribution,
      createdAt: "2026-08-01T00:00:00.000Z"
    }],
    leads: [{
      id: "lead-1", ownerId: "owner-1", teamId: "team-1",
      convertedCustomerId: "customer-1", convertedDealId: "deal-1",
      externalId: "candidate-1"
    }]
  } as unknown as Pick<CrmStore, "acquisitionCustomerHandoffs" | "leads">;
}

function tradeDocumentFixture(
  overrides: Partial<TradeDocument> = {}
): TradeDocument {
  return {
    id: "document-1", customerId: "customer-1", dealId: "deal-1",
    revision: 2, type: "PI", title: "PI", number: "PI-1",
    issueDate: "2026-08-01", buyer: "Buyer", buyerAddress: "",
    buyerContact: "", seller: "Seller", sellerAddress: "", currency: "USD",
    incoterm: "FOB", paymentTerm: "T/T", shippingMethod: "Sea",
    portLoading: "", portDischarge: "", validityDate: "", bankInfo: "",
    notes: "", templateStyle: "executive", status: "draft",
    commercialAuthority: "quote_projection", quoteCaseId: "quote-case-1",
    quoteVersionId: "quote-v1",
    commercialAmountHash: `sha256:${"a".repeat(64)}`,
    dealAuthorityRevision: 3, audits: [], sendRecords: [], ownerId: "owner-1",
    teamId: "team-1", updatedAt: "2026-08-01T00:00:00.000Z", items: [],
    ...overrides
  };
}

function hasCode(error: unknown) {
  return error instanceof CommercialAuthorityError
    && error.code === "authoritative_quote_required"
    && error.status === 409;
}

test("legacy commercial writes are blocked only for trusted acquisition deals", async () => {
  const store = storeFixture();
  await assert.rejects(assertLegacyCommercialWriteAllowed(
    store, managerWorkspace(), "deal-1", "deal_commercial_patch"
  ), hasCode);
  await assert.doesNotReject(assertLegacyCommercialWriteAllowed(
    store, managerWorkspace(), "legacy-deal", "deal_commercial_patch"
  ));
});

test("only an exact quote projection can use the existing human PI lifecycle", async () => {
  const store = storeFixture();
  const projected = tradeDocumentFixture();
  const validator: QuoteProjectedDocumentAuthorityValidator = {
    async assertAuthorized(_context, input) {
      assert.deepEqual(input, {
        documentId: "document-1",
        action: "submit_approval",
        expectedDocumentRevision: 2
      });
      return {
        documentId: "document-1", documentRevision: 2, dealId: "deal-1",
        quoteCaseId: "quote-case-1", quoteVersionId: "quote-v1",
        commercialAmountHash: `sha256:${"a".repeat(64)}`,
        dealAuthorityRevision: 3
      };
    }
  };
  await assert.doesNotReject(assertLegacyCommercialWriteAllowed(
    store, managerWorkspace(), "deal-1", "pi_submit_approval", {
      document: projected,
      projectedDocumentAuthority: validator
    }
  ));
  await assert.rejects(assertLegacyCommercialWriteAllowed(
    store, managerWorkspace(), "deal-1", "pi_send", {
      document: { ...projected, commercialAuthority: "legacy_unverified" },
      projectedDocumentAuthority: validator
    }
  ), hasCode);
});

test("a mismatched frozen quote authority fails closed", async () => {
  const store = storeFixture();
  const document = tradeDocumentFixture();
  const validator: QuoteProjectedDocumentAuthorityValidator = {
    async assertAuthorized() {
      return {
        documentId: document.id, documentRevision: document.revision,
        dealId: document.dealId, quoteCaseId: document.quoteCaseId!,
        quoteVersionId: document.quoteVersionId!,
        commercialAmountHash: `sha256:${"b".repeat(64)}`,
        dealAuthorityRevision: document.dealAuthorityRevision!
      };
    }
  };
  await assert.rejects(assertLegacyCommercialWriteAllowed(
    store, managerWorkspace(), "deal-1", "pi_export", {
      document, projectedDocumentAuthority: validator
    }
  ), hasCode);
});

test("malformed or cross-deal projection snapshots fail closed", async () => {
  const store = storeFixture();
  for (const document of [
    tradeDocumentFixture({ dealId: "other-deal" }),
    tradeDocumentFixture({ commercialAmountHash: "sha256:bad" as never }),
    tradeDocumentFixture({ dealAuthorityRevision: 0 })
  ]) {
    await assert.rejects(assertLegacyCommercialWriteAllowed(
      store, managerWorkspace(), "deal-1", "pi_export", {
        document,
        projectedDocumentAuthority: {
          async assertAuthorized() {
            return {
              documentId: document.id,
              documentRevision: document.revision,
              dealId: "deal-1",
              quoteCaseId: document.quoteCaseId!,
              quoteVersionId: document.quoteVersionId!,
              commercialAmountHash: document.commercialAmountHash!,
              dealAuthorityRevision: document.dealAuthorityRevision!
            };
          }
        }
      }
    ), hasCode);
  }
});

async function listen() {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    server,
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (init.body) headers.set("content-type", "application/json");
      const response = await fetch(
        `http://127.0.0.1:${address.port}${path}`,
        { ...init, headers }
      );
      return { response, json: await response.json().catch(() => null) };
    }
  };
}

test("mounted legacy routes block acquisition commercial writes and preserve legacy deals", async () => {
  const store = getStore();
  const suffix = `authority-${Date.now()}`;
  const owner = store.users.find((item) => item.role === "manager");
  assert.ok(owner);
  const customerId = `customer-${suffix}`;
  const dealId = `deal-${suffix}`;
  const legacyDealId = `legacy-deal-${suffix}`;
  const leadId = `lead-${suffix}`;
  const handoffId = `handoff-${suffix}`;
  const candidateId = `candidate-${suffix}`;
  store.customers.push({
    id: customerId, company: "Authority Test", country: "US", contact: "Buyer",
    ownerId: owner.id, teamId: owner.teamId, stage: "询盘", amount: 100,
    health: 80, grade: "B", nextReminder: "", wecomBound: false,
    billingName: "Authority Test", billingAddress: "", documentContact: "Buyer",
    defaultPortDischarge: "", defaultIncoterm: "FOB", defaultPaymentTerm: "T/T"
  });
  const baseDeal = {
    customerId, title: "Authority Deal", stage: "已联系" as const,
    product: "Widget", quantity: 1, unitPrice: 100, amount: 100,
    currency: "USD", amountType: "estimate" as const, ownerId: owner.id,
    teamId: owner.teamId, nextAction: "Follow", nextActionAt: "2026-08-11",
    expectedCloseAt: "2026-09-01", stageChangedAt: "2026-08-10T00:00:00.000Z"
  };
  store.deals.push({ id: dealId, ...baseDeal }, {
    id: legacyDealId, ...baseDeal, title: "Legacy Deal"
  });
  const attribution = storeFixture().acquisitionCustomerHandoffs[0]!
    .acquisitionAttribution;
  store.leads.push({
    id: leadId, company: "Authority Test", contact: "Buyer", country: "US",
    email: "buyer@authority.test", phone: "", wechat: "", source: "acquisition",
    intent: "high", stage: "converted", status: "converted", ownerId: owner.id,
    teamId: owner.teamId, estimatedAmount: 100, nextFollowAt: "",
    lastActivityAt: "", remark: "", convertedCustomerId: customerId,
    convertedDealId: dealId, sourceType: "outbound", sourceChannel: "acquisition",
    sourceCampaign: "", externalId: candidateId, sourceUrl: "", createdAt: "2026-08-10T00:00:00.000Z"
  });
  store.acquisitionCustomerHandoffs.push({
    id: handoffId, ownerId: owner.id, teamId: owner.teamId, candidateId,
    leadId, customerId, todoId: `todo-${suffix}`, dealId,
    decisionVersion: "decision-v1", mode: "create_new", processingKeyHash: "",
    acceptedProcessingKeyHashes: [], requestHash: "",
    intelligence: {
      qualificationGrade: "A", qualificationScore: 90, financialGrade: "A",
      currency: "USD", expectedRevenueMinor: 10000,
      expectedGrossProfitMinor: 3000, expectedContributionMinor: 2000
    }, qualificationSnapshotHash: "", financialSnapshotHash: "",
    acquisitionAttribution: attribution ? {
      ...structuredClone(attribution), decisionVersion: "decision-v1"
    } : null,
    createdAt: "2026-08-10T00:00:00.000Z"
  });
  const historicalEventId = `event-${suffix}`;
  store.dealEvents.push({
    id: historicalEventId, dealId, type: "quote", content: "historical quote",
    operatorId: owner.id, ownerIdSnapshot: owner.id,
    teamIdSnapshot: owner.teamId, customerIdSnapshot: customerId,
    leadIdSnapshot: leadId, handoffIdSnapshot: handoffId,
    candidateIdSnapshot: candidateId, amountMinorSnapshot: 10_000,
    currencySnapshot: "USD", createdAt: "2026-08-10T00:00:00.000Z"
  });
  const historical = tradeDocumentFixture({
    id: `document-${suffix}`, customerId, dealId, ownerId: owner.id,
    teamId: owner.teamId, commercialAuthority: "legacy_unverified",
    status: "ready", items: [{
      id: `item-${suffix}`, product: "Widget", model: "W1", hsCode: "",
      quantity: 1, unit: "PCS", unitPrice: 100, originCountry: "CN",
      weightKg: 1, packageCount: 1
    }]
  });
  delete historical.commercialAuthority;
  const pending = { ...structuredClone(historical), id: `pending-${suffix}`, status: "pending_approval" as const };
  const approved = { ...structuredClone(historical), id: `approved-${suffix}`, status: "approved" as const };
  const projected = tradeDocumentFixture({
    id: `projected-${suffix}`, customerId, dealId, ownerId: owner.id,
    teamId: owner.teamId, status: "ready", items: structuredClone(historical.items)
  });
  const wrongWorkspaceProjected = {
    ...structuredClone(projected), id: `wrong-workspace-${suffix}`
  };
  store.tradeDocuments.push(
    historical, pending, approved, projected, wrongWorkspaceProjected
  );
  const runtime = await listen();
  try {
    const login = await runtime.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: owner.email, password: owner.password })
    });
    assert.equal(login.response.status, 200);
    const headers = { authorization: `Bearer ${login.json.token}` };
    const historicalRead = await runtime.request("/api/trade-documents", {
      headers
    });
    assert.equal(historicalRead.response.status, 200);
    assert.equal(historicalRead.json.documents.find(
      (item: { id: string }) => item.id === historical.id
    )?.commercialAuthority, "legacy_unverified");
    assert.equal(historical.commercialAuthority, undefined);
    const dealsRead = await runtime.request("/api/deals", { headers });
    assert.equal(dealsRead.response.status, 200);
    const normalizedEvent = dealsRead.json.events.find(
      (item: { id: string }) => item.id === historicalEventId
    );
    assert.equal(normalizedEvent.commercialAuthority, "legacy_unverified");
    assert.equal(normalizedEvent.quoteCaseIdSnapshot, null);
    assert.equal(store.dealEvents.find((item) =>
      item.id === historicalEventId)?.commercialAuthority, undefined);
    const dealBody = {
      customerId, title: baseDeal.title, product: baseDeal.product,
      quantity: 1, unitPrice: 101, currency: "USD", nextAction: "Follow",
      nextActionAt: "2026-08-11", expectedCloseAt: "2026-09-01"
    };
    const writes: Array<[string, RequestInit]> = [
      [`/api/deals/${dealId}`, { method: "PATCH", headers, body: JSON.stringify(dealBody) }],
      [`/api/deals/${dealId}/stage`, { method: "PATCH", headers, body: JSON.stringify({ stage: "已报价", result: "quoted", nextAction: "follow", nextActionAt: "2026-08-12", expectedCloseAt: "2026-09-01" }) }],
      [`/api/deals/${dealId}/stage`, { method: "PATCH", headers, body: JSON.stringify({ stage: "样品", result: "sample", nextAction: "follow", nextActionAt: "2026-08-12", expectedCloseAt: "2026-09-01", transitionReason: "skip quote" }) }],
      [`/api/deals/${dealId}/events`, { method: "POST", headers, body: JSON.stringify({ type: "quote", content: "quoted", nextAction: "follow", nextActionAt: "2026-08-12" }) }],
      [`/api/deals/${dealId}/lost`, { method: "POST", headers, body: JSON.stringify({ category: "price", reason: "lost" }) }],
      ["/api/trade-documents", { method: "POST", headers, body: JSON.stringify(historical) }],
      [`/api/trade-documents/${historical.id}`, { method: "PATCH", headers, body: JSON.stringify({ ...historical, title: "changed" }) }],
      [`/api/trade-documents/${historical.id}/revision`, { method: "POST", headers, body: "{}" }],
      [`/api/trade-documents/${historical.id}/submit-approval`, { method: "POST", headers, body: "{}" }],
      [`/api/trade-documents/${pending.id}/approve`, { method: "POST", headers, body: "{}" }],
      [`/api/trade-documents/${approved.id}/send`, { method: "POST", headers, body: JSON.stringify({ recipient: "buyer@example.test" }) }],
      [`/api/trade-documents/${approved.id}/export`, { method: "POST", headers, body: "{}" }]
    ];
    for (const [path, init] of writes) {
      const result = await runtime.request(path, init);
      assert.equal(result.response.status, 409, path);
      assert.equal(result.json.code, "authoritative_quote_required", path);
    }
    const allowed = await runtime.request(`/api/deals/${legacyDealId}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ ...dealBody, unitPrice: 102 })
    });
    assert.equal(allowed.response.status, 200);
    const actions: string[] = [];
    const uninstallProjection = installLegacyCommercialAuthorityProjection({
      async assertAuthorized(context, input) {
        if (context.workspaceId !== owner.teamId
          || !context.capabilities.includes("quote.confirm")) {
          throw new Error("capability_forbidden");
        }
        actions.push(input.action);
        const source = store.tradeDocuments.find((item) =>
          item.id === input.documentId);
        assert.ok(source);
        return {
          documentId: source.id,
          documentRevision: source.revision,
          dealId: source.dealId,
          quoteCaseId: source.quoteCaseId!,
          quoteVersionId: source.quoteVersionId!,
          commercialAmountHash: source.commercialAmountHash!,
          dealAuthorityRevision: source.dealAuthorityRevision!
        };
      }
    });
    try {
      for (const [path, init] of [
        [`/api/trade-documents/${projected.id}/submit-approval`, { method: "POST", headers, body: "{}" }],
        [`/api/trade-documents/${projected.id}/approve`, { method: "POST", headers, body: "{}" }],
        [`/api/trade-documents/${projected.id}/send`, { method: "POST", headers, body: JSON.stringify({ recipient: "buyer@example.test" }) }],
        [`/api/trade-documents/${projected.id}/export`, { method: "POST", headers, body: "{}" }]
      ] as Array<[string, RequestInit]>) {
        const result = await runtime.request(path, init);
        assert.equal(result.response.status, 200, path);
      }
      assert.deepEqual(actions, ["submit_approval", "approve", "send", "export"]);
      const wrongWorkspace = await runtime.request(
        `/api/trade-documents/${wrongWorkspaceProjected.id}/submit-approval`,
        {
          method: "POST",
          headers: { ...headers, "X-Workspace-Id": "wrong-team" },
          body: "{}"
        }
      );
      assert.equal(wrongWorkspace.response.status, 409);
      assert.equal(wrongWorkspace.json.code, "authoritative_quote_required");
    } finally {
      uninstallProjection();
    }
  } finally {
    await new Promise<void>((resolve, reject) => runtime.server.close((error) => error ? reject(error) : resolve()));
    store.customers = store.customers.filter((item) => item.id !== customerId);
    store.deals = store.deals.filter((item) => ![dealId, legacyDealId].includes(item.id));
    store.leads = store.leads.filter((item) => item.id !== leadId);
    store.dealEvents = store.dealEvents.filter((item) =>
      item.id !== historicalEventId);
    store.acquisitionCustomerHandoffs = store.acquisitionCustomerHandoffs.filter((item) => item.id !== handoffId);
    const documentIds = new Set([
      historical.id, pending.id, approved.id, projected.id,
      wrongWorkspaceProjected.id
    ]);
    store.tradeDocuments = store.tradeDocuments.filter((item) =>
      !documentIds.has(item.id));
  }
});
