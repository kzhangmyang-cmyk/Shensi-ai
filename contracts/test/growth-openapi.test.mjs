import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  loadNamedJsonSchema,
  loadNamedOpenApiSource,
  loadSchemaRegistry
} from "./helpers.mjs";

const operations = {
  "/api/v1/growth/bootstrap": ["get"],
  "/api/v1/catalog/items": ["get", "post"],
  "/api/v1/catalog/items/{id}": ["get", "patch"],
  "/api/v1/catalog/items/{id}/retire": ["post"],
  "/api/v1/catalog/pricing-policies": ["get", "post"],
  "/api/v1/catalog/pricing-policies/{id}": ["get"],
  "/api/v1/catalog/pricing-policies/{id}/activate": ["post"],
  "/api/v1/catalog/pricing-policies/{id}/retire": ["post"],
  "/api/v1/catalog/packages/{itemId}/versions": ["get", "post"],
  "/api/v1/catalog/package-versions/{id}": ["get", "patch"],
  "/api/v1/catalog/package-versions/{id}/activate": ["post"],
  "/api/v1/catalog/package-versions/{id}/retire": ["post"],
  "/api/v1/quotes/cases": ["get", "post"],
  "/api/v1/quotes/cases/{id}": ["get"],
  "/api/v1/quotes/cases/{id}/bind-deal": ["post"],
  "/api/v1/quotes/cases/{id}/close": ["post"],
  "/api/v1/quotes/cases/{id}/cancel": ["post"],
  "/api/v1/quotes/cases/{id}/preview": ["post"],
  "/api/v1/quotes/cases/{id}/versions": ["get", "post"],
  "/api/v1/quotes/versions/{id}": ["get"],
  "/api/v1/quotes/versions/{id}/submit": ["post"],
  "/api/v1/quotes/versions/{id}/approve": ["post"],
  "/api/v1/quotes/versions/{id}/reject": ["post"],
  "/api/v1/quotes/versions/{id}/expire": ["post"],
  "/api/v1/quotes/versions/{id}/approvals": ["get"],
  "/api/v1/quotes/publication-operations/{id}": ["get"],
  "/api/v1/quotes/publication-operations/{id}/retry": ["post"],
  "/api/v1/quotes/deals/{dealId}/decision": ["post"],
  "/api/v1/acquisition/cost-entries": ["get", "post"],
  "/api/v1/acquisition/cost-estimates": ["get", "post"],
  "/api/v1/acquisition/cost-estimates/{id}/activate": ["post"],
  "/api/v1/acquisition/cost-estimates/{id}/supersede": ["post"],
  "/api/v1/acquisition/cost-entries/{id}/verify": ["post"],
  "/api/v1/acquisition/cost-entries/{id}/reject": ["post"],
  "/api/v1/acquisition/cost-entries/{id}/reverse": ["post"],
  "/api/v1/acquisition/cost-entries/{id}/correct": ["post"],
  "/api/v1/acquisition/attribution-allocation-sets": ["get", "post"],
  "/api/v1/acquisition/attribution-allocation-sets/{id}": ["get"],
  "/api/v1/acquisition/attribution-allocation-sets/{id}/activate": ["post"],
  "/api/v1/finance/facts": ["get", "post"],
  "/api/v1/finance/facts/{id}/verify": ["post"],
  "/api/v1/finance/facts/{id}/reject": ["post"],
  "/api/v1/finance/facts/{id}/reverse": ["post"],
  "/api/v1/finance/facts/{id}/correct": ["post"],
  "/api/v1/finance/source-reports": ["get", "post"],
  "/api/v1/finance/source-reports/{id}": ["get"],
  "/api/v1/finance/settlement-allocation-sets": ["get", "post"],
  "/api/v1/finance/settlement-allocation-sets/{id}": ["get"],
  "/api/v1/finance/settlement-allocation-sets/{id}/activate": ["post"],
  "/api/v1/finance/import-templates/{kind}": ["get"],
  "/api/v1/finance/imports/preview": ["post"],
  "/api/v1/finance/imports/{previewId}/commit": ["post"],
  "/api/v1/finance/imports/{id}": ["get"],
  "/api/v1/finance/imports/{id}/errors": ["get"],
  "/api/v1/acquisition/cohorts": ["get", "post"],
  "/api/v1/acquisition/cohorts/{id}": ["get"],
  "/api/v1/acquisition/cohorts/{id}/attestations": ["get", "post"],
  "/api/v1/acquisition/cohorts/{id}/close": ["post"],
  "/api/v1/acquisition/cohorts/{id}/closures": ["get"],
  "/api/v1/acquisition/roi-closures/{closureVersionId}/reopen": ["post"],
  "/api/v1/acquisition/growth-performance": ["get"],
  "/api/v1/acquisition/advisor/today": ["get"],
  "/api/v1/acquisition/advisor/recommendations/{id}/accept": ["post"],
  "/api/v1/acquisition/advisor/recommendations/{id}/ignore": ["post"],
  "/api/v1/acquisition/advisor/recommendations/{id}/complete": ["post"],
  "/api/v1/finance/council-runs": ["post"],
  "/api/v1/finance/council-runs/{runId}": ["get"],
  "/api/v1/finance/council-runs/{runId}/events": ["get"],
  "/api/v1/finance/council-policy": ["get", "put"],
  "/api/v1/finance/council-runs/{runId}/portfolio-revisions": ["post"],
  "/api/v1/finance/council-runs/{runId}/portfolio-revisions/{revision}/approve": ["post"],
  "/api/v1/finance/council-runs/{runId}/reject": ["post"],
  "/api/v1/finance/council-runs/{runId}/dispatches": ["get"]
};

const standardHttpMethods = new Set([
  "get", "put", "post", "delete", "options", "head", "patch", "trace"
]);

const advisorQuoteRiskContractFixture = () => ({
  id: "recommendation-1",
  workspaceId: "workspace-1",
  revision: 1,
  audienceRole: "manager",
  type: "quote_risk",
  summary: "Prioritize the submitted quote that is about to expire",
  rationale: "Quote version quote-v3 expires in 12 hours",
  metricRefs: [{
    kind: "quote_preview",
    quoteCaseId: "quote-case-3",
    previewIdentity: {
      inputSnapshotHash: `sha256:${"a".repeat(64)}`,
      calculationHash: `sha256:${"b".repeat(64)}`,
      pricingPolicyVersionId: "pricing-policy-v7",
      pricingPolicyRevision: 7,
      packageVersionId: "package-v3",
      formulaVersion: "quote-calculation.v1"
    },
    inputSnapshotHash: `sha256:${"a".repeat(64)}`,
    calculationHash: `sha256:${"b".repeat(64)}`
  }],
  evidenceRefs: [{
    kind: "quote_version",
    quoteVersionId: "quote-v3",
    lifecycleRevision: 3,
    commercialAmountHash: `sha256:${"c".repeat(64)}`
  }],
  entityRefs: [{
    kind: "quote_version",
    id: "quote-v3",
    lifecycleRevision: 3,
    commercialAmountHash: `sha256:${"c".repeat(64)}`
  }],
  confidenceBps: 8700,
  riskLevel: "high",
  recommendedAction: {
    kind: "create_quote_approval_task",
    quoteVersionId: "quote-v3",
    quoteVersionRevision: 3
  },
  status: "proposed",
  assignedTo: null,
  acceptedBy: null,
  acceptedAt: null,
  outcomeRefs: [],
  dataAsOf: "2026-08-09T08:00:00.000Z",
  inputSnapshotHash: `sha256:${"d".repeat(64)}`,
  modelSnapshotRef: "model-snapshot-1",
  promptVersion: "growth-advisor.v1",
  schemaVersion: "advisor-recommendation.v1",
  generationIdempotencyKey: "advisor-generation:workspace-1:2026-08-09",
  expiresAt: "2026-08-10T08:00:00.000Z",
  createdAt: "2026-08-09T08:00:00.000Z",
  updatedAt: "2026-08-09T08:00:00.000Z"
});

function findClosedPropertyEnum(schema, definitionName, propertyName) {
  const definitions = schema.$defs ?? schema.definitions ?? {};
  const start = definitions[definitionName] ?? schema;
  const matches = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    const property = value.properties?.[propertyName];
    if (Array.isArray(property?.enum) && property.enum.every((item) => typeof item === "string")) {
      matches.push(property.enum);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(start);
  assert.equal(matches.length, 1, `${definitionName}.${propertyName}`);
  return matches[0];
}

async function loadDefinitionValidator(filename, definitionName) {
  const registry = await loadSchemaRegistry();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const schema of registry.schemaDocuments.values()) ajv.addSchema(schema);
  const schema = await loadNamedJsonSchema(filename);
  return ajv.compile({ $ref: `${schema.$id}#/$defs/${definitionName}` });
}

function effectiveParameters(document, pathItem, operation) {
  const parameters = new Map();
  for (const unresolved of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const prefix = "#/components/parameters/";
    const parameter = unresolved.$ref?.startsWith(prefix)
      ? document.components.parameters[unresolved.$ref.slice(prefix.length)]
      : unresolved;
    parameters.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  return [...parameters.values()];
}

function resolveInternalResponse(document, response) {
  if (!response?.$ref) return response;
  const prefix = "#/components/responses/";
  assert.ok(response.$ref.startsWith(prefix), response.$ref);
  return document.components.responses[response.$ref.slice(prefix.length)];
}

async function resolvePublishedSchema(document, unresolved) {
  let schema = unresolved;
  while (schema?.$ref) {
    if (schema.$ref.startsWith("#/components/schemas/")) {
      schema = document.components.schemas[schema.$ref.slice("#/components/schemas/".length)];
      continue;
    }
    const match = schema.$ref.match(/^\.\.\/json-schema\/([^#]+)(?:#\/(.*))?$/);
    assert.ok(match, schema.$ref);
    schema = await loadNamedJsonSchema(match[1]);
    for (const segment of match[2]?.split("/") ?? []) {
      schema = schema[decodeURIComponent(segment.replaceAll("~1", "/").replaceAll("~0", "~"))];
    }
  }
  return schema;
}

function allPublishedOperations(document) {
  const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
  return Object.entries(document.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => methods.has(method))
      .map(([method, operation]) => ({ path, method, pathItem, operation }))
  );
}

const pricingPolicyFullFixture = () => ({
  amountVisibility: "full",
  id: "policy-1",
  workspaceId: "workspace-1",
  catalogItemId: "item-1",
  version: 1,
  revision: 1,
  packageVersionId: null,
  currency: "CNY",
  listUnitPriceMinor: 20000,
  unitStandardCostMinor: 8000,
  defaultOrderDeliveryCostMinor: 1000,
  defaultOrderSalesCostMinor: 500,
  defaultOrderServiceCostMinor: 300,
  absoluteFloorUnitPriceMinor: 12000,
  standardDiscountLimitBps: 1000,
  absoluteDiscountLimitBps: 3000,
  targetGrossMarginBps: 5000,
  absoluteMinimumGrossMarginBps: 2000,
  standardPaymentTermDays: 30,
  absolutePaymentTermDays: 90,
  approvalThresholds: {
    discountCapability: "quote.exception.discount.approve",
    marginCapability: "quote.exception.margin.approve",
    paymentTermsCapability: "quote.exception.payment_terms.approve",
    giftCapability: "quote.exception.gift.approve",
    creditCapability: "quote.exception.credit.approve",
    manualCapability: "quote.exception.manual.approve",
    creditRiskThresholdBps: 7000,
    manualEscalationEnabled: false
  },
  surchargePolicies: [],
  giftPolicies: [{
    catalogItemId: "gift-1",
    unitStandardCostMinor: 100,
    standardQuantityMicros: 1000000,
    absoluteQuantityMicros: 2000000,
    standardCostLimitMinor: 100,
    absoluteCostLimitMinor: 200
  }],
  validFrom: "2026-08-09T00:00:00.000Z",
  validTo: null,
  status: "active",
  source: "native",
  createdBy: "user-1",
  createdAt: "2026-08-09T00:00:00.000Z"
});

const pricingPolicyRedactedFixture = () => ({
  amountVisibility: "redacted",
  id: "policy-1",
  workspaceId: "workspace-1",
  catalogItemId: "item-1",
  version: 1,
  revision: 1,
  packageVersionId: null,
  currency: "CNY",
  listUnitPriceMinor: 20000,
  standardDiscountLimitBps: 1000,
  absoluteDiscountLimitBps: 3000,
  standardPaymentTermDays: 30,
  absolutePaymentTermDays: 90,
  surchargePolicies: [],
  validFrom: "2026-08-09T00:00:00.000Z",
  validTo: null,
  status: "active",
  source: "native",
  createdBy: "user-1",
  createdAt: "2026-08-09T00:00:00.000Z"
});

const quotePreviewIdentityFixture = () => ({
  inputSnapshotHash: `sha256:${"1".repeat(64)}`,
  calculationHash: `sha256:${"2".repeat(64)}`,
  pricingPolicyVersionId: "policy-1",
  pricingPolicyRevision: 1,
  packageVersionId: null,
  formulaVersion: "quote-calculation.v1"
});

const probabilityAssessmentFixture = () => ({
  id: "probability-1",
  candidateId: "candidate-1",
  dealId: "deal-1",
  closeProbabilityBps: 6500,
  qualificationDecisionId: "qualification-1",
  qualificationDecisionVersion: "v2",
  evidenceRefs: ["evidence-1"],
  ruleVersion: "qualification.v2",
  modelSnapshotRef: null,
  inputSnapshotHash: `sha256:${"3".repeat(64)}`,
  assessedAt: "2026-08-09T00:00:00.000Z"
});

const quoteVersionFullFixture = () => ({
  amountVisibility: "full",
  id: "quote-version-1",
  workspaceId: "workspace-1",
  quoteCaseId: "quote-case-1",
  version: 1,
  lifecycleRevision: 1,
  currency: "CNY",
  lineItems: [{
    catalogItemId: "item-1",
    pricingPolicyVersionId: "policy-1",
    packageVersionId: null,
    quantityMicros: 1000000,
    offeredUnitPriceMinor: 18000,
    lineAmountMinor: 18000,
    standardCostMinor: 8000
  }],
  customerTargetPriceMinor: null,
  discountMinor: 0,
  surchargeMinor: 0,
  requiredSurchargeMinor: 0,
  paymentTerms: { days: 30 },
  giftItems: [],
  listAmountMinor: 20000,
  netProductAmountMinor: 18000,
  quotedAmountMinor: 18000,
  estimatedFulfillmentCostMinor: 8000,
  estimatedSalesCostMinor: 500,
  estimatedServiceCostMinor: 300,
  estimatedGrossProfitMinor: 10000,
  estimatedContributionMinor: 9200,
  discountBps: 1000,
  grossMarginBps: 5556,
  approvalReasons: [],
  pricingPolicySnapshot: pricingPolicyFullFixture(),
  probabilityAssessmentSnapshot: probabilityAssessmentFixture(),
  previewIdentity: quotePreviewIdentityFixture(),
  commercialAmountHash: `sha256:${"4".repeat(64)}`,
  status: "approved",
  createdBy: "user-1",
  createdAt: "2026-08-09T00:00:00.000Z"
});

const quoteVersionRedactedFixture = () => ({
  amountVisibility: "redacted",
  id: "quote-version-1",
  workspaceId: "workspace-1",
  quoteCaseId: "quote-case-1",
  version: 1,
  lifecycleRevision: 1,
  currency: "CNY",
  lineItems: [{
    catalogItemId: "item-1",
    pricingPolicyVersionId: "policy-1",
    packageVersionId: null,
    quantityMicros: 1000000,
    offeredUnitPriceMinor: 18000,
    lineAmountMinor: 18000
  }],
  customerTargetPriceMinor: null,
  discountMinor: 0,
  surchargeMinor: 0,
  requiredSurchargeMinor: 0,
  paymentTerms: { days: 30 },
  giftItems: [],
  listAmountMinor: 20000,
  netProductAmountMinor: 18000,
  quotedAmountMinor: 18000,
  discountBps: 1000,
  approvalReasons: [],
  probabilityAssessmentSnapshot: probabilityAssessmentFixture(),
  previewIdentity: quotePreviewIdentityFixture(),
  commercialAmountHash: `sha256:${"4".repeat(64)}`,
  status: "approved",
  createdBy: "user-1",
  createdAt: "2026-08-09T00:00:00.000Z"
});

function growthPerformanceFixture(expectedRoiByCurrency = [], cashByCurrency = []) {
  return {
    query: {
      cohortId: "cohort-1",
      currency: "CNY",
      asOf: "2026-08-09T08:00:00.000Z",
      planId: null,
      closureVersionId: null,
      sliceKey: "all"
    },
    expectedRoiByCurrency,
    actualRoiByCurrency: [],
    cashByCurrency,
    coverage: {
      costCoverageBps: 10000,
      marginCoverageBps: 10000,
      cashCoverageBps: 10000,
      attributionCoverageBps: 10000
    },
    dataGaps: [],
    dataAsOf: "2026-08-09T08:00:00.000Z"
  };
}

function quoteDiagnosticFixture(reason, diagnosticNetProductAmountMinor, diagnosticQuotedAmountMinor) {
  return {
    amountState: "non_positive_diagnostic",
    currency: "CNY",
    listAmountMinor: 10000,
    diagnosticNetProductAmountMinor,
    diagnosticQuotedAmountMinor,
    requiredSurchargeMinor: 0,
    estimatedFulfillmentCostMinor: 1000,
    estimatedSalesCostMinor: 0,
    estimatedServiceCostMinor: 0,
    estimatedGrossProfitMinor: -1000,
    estimatedContributionMinor: -1000,
    discountBps: 10000,
    grossMarginBps: null,
    minimumAllowedQuotedAmountMinor: 1000,
    recommendedOpeningQuotedAmountMinor: 10000,
    gate: {
      status: "hard_blocked",
      reasons: [reason],
      requiredCapabilities: []
    },
    previewIdentity: quotePreviewIdentityFixture()
  };
}

// Production break caught: deleting or changing a published Growth route/method, or leaking the internal reconciler capability.
test("growth contract publishes the exact route surface", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  assert.deepEqual(Object.keys(document.paths).sort(), Object.keys(operations).sort());
  for (const [path, methods] of Object.entries(operations)) {
    assert.deepEqual(
      Object.keys(document.paths[path])
        .map((key) => key.toLowerCase())
        .filter((key) => standardHttpMethods.has(key))
        .sort(),
      [...methods].sort(),
      path
    );
  }
  const bootstrap = await loadNamedJsonSchema("growth-bootstrap.v1.schema.json");
  assert.equal(JSON.stringify(bootstrap).includes("acquisition.outcome.reconcile.internal"), false);
});

// Production break caught: requiring a revision precondition for creation even though no catalog item revision exists yet.
test("catalog item creation requires workspace and idempotency without If-Match", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  assert.deepEqual(document.paths["/api/v1/catalog/items"].post.parameters, [
    { $ref: "#/components/parameters/workspaceHeader" },
    { $ref: "#/components/parameters/idempotencyKey" }
  ]);
});

test("financial council commands use the shared Growth precondition protocol", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  const create = document.paths["/api/v1/finance/council-runs"].post;
  assert.equal(create.responses["202"].$ref, "#/components/responses/FinancialCouncilRun");
  assert.deepEqual(create.parameters, [
    { $ref: "#/components/parameters/idempotencyKey" }
  ]);
  for (const [path, method] of [
    ["/api/v1/finance/council-policy", "put"],
    ["/api/v1/finance/council-runs/{runId}/portfolio-revisions", "post"],
    ["/api/v1/finance/council-runs/{runId}/portfolio-revisions/{revision}/approve", "post"],
    ["/api/v1/finance/council-runs/{runId}/reject", "post"]
  ]) {
    const operation = document.paths[path][method];
    const parameters = effectiveParameters(document, document.paths[path], operation);
    assert.equal(parameters.some((parameter) => parameter.name === "Idempotency-Key" && parameter.required), true, `${method} ${path}`);
    assert.equal(parameters.some((parameter) => parameter.name === "If-Match" && parameter.required), true, `${method} ${path}`);
  }
});

test("financial council policy updates accept configuration but no server-owned version fields", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  const update = document.paths["/api/v1/finance/council-policy"].put;
  const input = await resolvePublishedSchema(
    document,
    update.requestBody.content["application/json"].schema
  );
  assert.deepEqual(Object.keys(input.properties).sort(), [
    "actionCoefficientVersion", "balancedWeightsBps", "budgetLimitMinor",
    "capacityLimitUnits", "currency", "dueDebtMinor", "durationLimitDays",
    "minimumActionConfidenceBps", "minimumCashReserveMinor",
    "necessaryOutflowMinor"
  ]);
  for (const serverOwned of [
    "workspaceId", "policyVersionId", "version", "revision", "policyHash", "createdAt"
  ]) assert.equal(serverOwned in input.properties, false, serverOwned);
});

test("financial council stream reads use closed pagination envelopes", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  for (const path of [
    "/api/v1/finance/council-runs/{runId}/events",
    "/api/v1/finance/council-runs/{runId}/dispatches"
  ]) {
    const response = resolveInternalResponse(document, document.paths[path].get.responses["200"]);
    const schema = await resolvePublishedSchema(document, response.content["application/json"].schema);
    assert.equal(schema.type, "object", path);
    assert.equal(schema.additionalProperties, false, path);
    assert.deepEqual(schema.required, ["items", "nextAfter", "hasMore"], path);
  }
});

// Production break caught: returning the logical contract filename or a path-like value instead of the immutable release's strict SemVer identity.
test("bootstrap responses require the release manifest's strict SemVer contract version", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("growth-bootstrap");
  assert.ok(validate);

  const ready = {
    status: "ready",
    workspaceId: "workspace-1",
    capabilityRegistryVersion: "growth-capabilities.v1",
    capabilities: ["catalog.read"],
    contractVersion: "1.0.0",
    contractHash: `sha256:${"a".repeat(64)}`,
    features: ["catalog"]
  };
  const selectionRequired = {
    status: "workspace_selection_required",
    workspaceId: null,
    capabilityRegistryVersion: "growth-capabilities.v1",
    capabilities: [],
    contractVersion: "1.0.0",
    contractHash: `sha256:${"a".repeat(64)}`,
    features: []
  };
  assert.equal(validate({
    ...ready,
    capabilities: ["catalog.read", "finance.council.run"]
  }), true, JSON.stringify(validate.errors));

  for (const contractVersion of ["1.0.0", "2.7.0-beta.1+build.42"]) {
    assert.equal(validate({ ...ready, contractVersion }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...selectionRequired, contractVersion }), true, JSON.stringify(validate.errors));
  }
  for (const contractVersion of ["growth-advisor-quote-roi.v1", "../1.0.0", "1.0", "1.0.0/release"]) {
    assert.equal(validate({ ...ready, contractVersion }), false, contractVersion);
    assert.equal(validate({ ...selectionRequired, contractVersion }), false, contractVersion);
  }
});

// Production break caught: accepting a future cutoff, using a per-layer clock, or writing during a rejected closure command.
test("every asOf boundary rejects future cutoff from one server-owned request clock", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  for (const [path, method] of [
    ["/api/v1/acquisition/growth-performance", "get"],
    ["/api/v1/acquisition/advisor/today", "get"],
    ["/api/v1/acquisition/cohorts/{id}/close", "post"]
  ]) {
    const operation = document.paths[path][method];
    assert.deepEqual(operation["x-goodjob-as-of-upper-bound"], {
      clock: method === "get" ? "readStartedAt" : "commandStartedAt",
      maxFutureSkewSeconds: 1,
      effectiveCutoff: "min(requestedAsOf,startedAt)",
      errorStatus: 422,
      errorCode: "invalid_as_of",
      zeroWritesOnReject: true
    });
    assert.ok(operation.responses["422"], `${method.toUpperCase()} ${path}`);
  }
});

// Production break caught: widening Advisor refs to generic identities or allowing approval actions without a frozen quote revision.
test("advisor recommendation keeps kind-specific refs and quote action revision", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("advisor-recommendation");
  assert.ok(validate);

  const fixture = advisorQuoteRiskContractFixture();
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));

  const missingQuoteRevision = structuredClone(fixture);
  delete missingQuoteRevision.recommendedAction.quoteVersionRevision;
  assert.equal(validate(missingQuoteRevision), false);

  const legacyGenericRefs = structuredClone(fixture);
  legacyGenericRefs.metricRefs = [{
    kind: "quote_preview",
    id: "preview-v3",
    revision: 3,
    calculationHash: `sha256:${"b".repeat(64)}`
  }];
  assert.equal(validate(legacyGenericRefs), false);
});

// Production break caught: accepting incomplete gap/ledger evidence, empty plan slices, mutable ownership heads, or unsupported entity kinds.
test("advisor refs freeze gap sources, non-empty ROI slices and real customer/deal authorities", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("advisor-recommendation");
  assert.ok(validate);

  const gap = advisorQuoteRiskContractFixture();
  gap.metricRefs = [{
    kind: "financial_data_gap",
    gapCode: "missing_commercial_binding",
    sourceType: "commercial_binding",
    sourceId: "deal-7",
    sourceSnapshotHash: `sha256:${"e".repeat(64)}`,
    cohortId: null,
    currency: "CNY",
    asOf: "2026-08-09T08:00:00.000Z"
  }];
  assert.equal(validate(gap), true, JSON.stringify(validate.errors));
  const unknownGapCode = structuredClone(gap);
  unknownGapCode.metricRefs[0].gapCode = "missing_verified_cost";
  assert.equal(validate(unknownGapCode), false);
  const unknownGapSource = structuredClone(gap);
  unknownGapSource.metricRefs[0].sourceType = "inferred_by_model";
  assert.equal(validate(unknownGapSource), false);
  const missingGapSource = structuredClone(gap);
  delete missingGapSource.metricRefs[0].sourceId;
  assert.equal(validate(missingGapSource), false);
  const missingGapSourceSnapshot = structuredClone(gap);
  delete missingGapSourceSnapshot.metricRefs[0].sourceSnapshotHash;
  assert.equal(validate(missingGapSourceSnapshot), false);
  const missingGapCohortRepresentation = structuredClone(gap);
  delete missingGapCohortRepresentation.metricRefs[0].cohortId;
  assert.equal(validate(missingGapCohortRepresentation), false);

  const sliced = advisorQuoteRiskContractFixture();
  sliced.metricRefs = [{
    kind: "growth_performance",
    cohortId: "cohort-1",
    currency: "CNY",
    asOf: "2026-08-09T08:00:00.000Z",
    planId: "plan-1",
    closureVersionId: "closure-1",
    sliceKey: "plan:plan-1",
    calculationHash: `sha256:${"f".repeat(64)}`
  }];
  sliced.evidenceRefs = [{
    kind: "roi_snapshot",
    closureVersionId: "closure-1",
    version: 1,
    sliceKey: "plan:plan-1",
    calculationHash: `sha256:${"f".repeat(64)}`
  }];
  sliced.entityRefs = [{
    kind: "closure_version",
    id: "closure-1",
    version: 1,
    sliceKey: "plan:plan-1",
    calculationHash: `sha256:${"f".repeat(64)}`
  }];
  assert.equal(validate(sliced), true, JSON.stringify(validate.errors));
  for (const branch of ["metricRefs", "evidenceRefs", "entityRefs"]) {
    const emptyPlanSlice = structuredClone(sliced);
    emptyPlanSlice[branch][0].sliceKey = "plan:";
    assert.equal(validate(emptyPlanSlice), false, branch);
  }

  const ledgerBound = advisorQuoteRiskContractFixture();
  ledgerBound.evidenceRefs = [{
    kind: "ledger_entry",
    ledgerType: "financial",
    ledgerEntryId: "financial-fact-1",
    currency: "CNY",
    verificationEventId: "verification-1",
    verificationRevision: 2,
    evidenceHash: `sha256:${"8".repeat(64)}`
  }];
  assert.equal(validate(ledgerBound), true, JSON.stringify(validate.errors));
  const missingLedgerType = structuredClone(ledgerBound);
  delete missingLedgerType.evidenceRefs[0].ledgerType;
  assert.equal(validate(missingLedgerType), false);
  const unknownLedgerType = structuredClone(ledgerBound);
  unknownLedgerType.evidenceRefs[0].ledgerType = "combined";
  assert.equal(validate(unknownLedgerType), false);
  const missingLedgerCurrency = structuredClone(ledgerBound);
  delete missingLedgerCurrency.evidenceRefs[0].currency;
  assert.equal(validate(missingLedgerCurrency), false);

  const authority = advisorQuoteRiskContractFixture();
  authority.entityRefs = [
    {
      kind: "customer",
      id: "customer-1",
      quoteVersionId: "quote-version-1",
      handoffContentHash: `sha256:${"0".repeat(64)}`,
      bindingHashSchemaVersion: "commercial-binding.v1"
    },
    {
      kind: "deal",
      id: "deal-1",
      quoteVersionId: "quote-version-1",
      dealContentHash: `sha256:${"1".repeat(64)}`,
      bindingHashSchemaVersion: "deal-binding.v1",
      dealAuthorityRevision: null
    }
  ];
  assert.equal(validate(authority), true, JSON.stringify(validate.errors));
  const genericCustomer = structuredClone(authority);
  genericCustomer.entityRefs[0] = { kind: "customer", id: "customer-1", revision: 4 };
  assert.equal(validate(genericCustomer), false);
  const missingCustomerHash = structuredClone(authority);
  delete missingCustomerHash.entityRefs[0].handoffContentHash;
  assert.equal(validate(missingCustomerHash), false);
  const missingCustomerQuoteVersion = structuredClone(authority);
  delete missingCustomerQuoteVersion.entityRefs[0].quoteVersionId;
  assert.equal(validate(missingCustomerQuoteVersion), false);
  const genericDeal = structuredClone(authority);
  genericDeal.entityRefs[1] = { kind: "deal", id: "deal-1", revision: 7 };
  assert.equal(validate(genericDeal), false);
  const missingDealAuthority = structuredClone(authority);
  delete missingDealAuthority.entityRefs[1].dealAuthorityRevision;
  assert.equal(validate(missingDealAuthority), false);
  const missingDealQuoteVersion = structuredClone(authority);
  delete missingDealQuoteVersion.entityRefs[1].quoteVersionId;
  assert.equal(validate(missingDealQuoteVersion), false);

  const removedCandidate = structuredClone(authority);
  removedCandidate.entityRefs = [{ kind: "candidate", id: "candidate-1", revision: 1 }];
  assert.equal(validate(removedCandidate), false);
  const removedQuoteCase = structuredClone(authority);
  removedQuoteCase.entityRefs = [{ kind: "quote_case", id: "quote-case-1", revision: 1 }];
  assert.equal(validate(removedQuoteCase), false);
  const removedCohort = structuredClone(authority);
  removedCohort.entityRefs = [{ kind: "cohort", id: "cohort-1", revision: 1 }];
  assert.equal(validate(removedCohort), false);
});

// Production break caught: widening or renaming the shared financial-data-gap code set.
test("financial data gap codes are one exact closed enum", async () => {
  const schema = await loadNamedJsonSchema("advisor-today.v1.schema.json");
  assert.deepEqual(findClosedPropertyEnum(schema, "FinancialDataGapView", "code"), [
    "unverified_cost",
    "unverified_financial_fact",
    "missing_cogs",
    "unmatched_payment",
    "missing_commercial_binding",
    "import_requires_review"
  ]);
  assert.equal(JSON.stringify(schema).includes("missing_verified_cost"), false);
});

test("advisor today query is closed to currency and asOf with a server-derived view", async () => {
  const schema = await loadNamedJsonSchema("advisor-today.v1.schema.json");
  const query = schema.$defs.AdvisorTodayQuery;
  assert.deepEqual(query.required, ["currency", "asOf"]);
  assert.deepEqual(schema.$defs.currency, {
    type: "string", pattern: "^[A-Z]{3}$"
  });
  assert.deepEqual(query.properties.currency, { $ref: "#/$defs/currency" });
  assert.equal(query.additionalProperties, false);
  assert.deepEqual(
    schema.required,
    ["workspaceId", "audienceRole", "dataAsOf", "priorityCustomers",
      "pendingQuoteApprovals", "expectedRoi", "actualRoi",
      "financialDataGaps", "recommendations", "sourceSnapshotHash"]
  );
  assert.equal(schema.properties.audienceRole.enum.includes("sales"), true);
  assert.equal(
    JSON.stringify(schema).includes("assignedTo"),
    false
  );
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  const today = document.paths["/api/v1/acquisition/advisor/today"].get;
  const parameterNames = today.parameters.map((parameter) =>
    typeof parameter === "object" && "name" in parameter
      ? parameter.name
      : null).filter((name) => name !== null);
  assert.deepEqual(parameterNames, ["currency", "asOf"]);
  assert.equal(parameterNames.includes("audienceRole"), false);
  assert.equal(parameterNames.includes("assignedTo"), false);
});

// Production break caught: exposing cost, floor, profit, contribution, margin, or policy snapshots to callers without the sensitive-pricing capability.
test("fix round 1 sensitive resources publish closed full and redacted projections", async () => {
  const registry = await loadSchemaRegistry();
  const validatePolicy = registry.validators.get("pricing-policy-version");
  const validateQuote = registry.validators.get("quote-version");
  assert.ok(validatePolicy);
  assert.ok(validateQuote);

  assert.equal(validatePolicy(pricingPolicyFullFixture()), true, JSON.stringify(validatePolicy.errors));
  assert.equal(validatePolicy(pricingPolicyRedactedFixture()), true, JSON.stringify(validatePolicy.errors));
  assert.equal(validateQuote(quoteVersionFullFixture()), true, JSON.stringify(validateQuote.errors));
  assert.equal(validateQuote(quoteVersionRedactedFixture()), true, JSON.stringify(validateQuote.errors));

  const leakedPolicy = { ...pricingPolicyRedactedFixture(), unitStandardCostMinor: 8000 };
  assert.equal(validatePolicy(leakedPolicy), false);
  const leakedQuote = { ...quoteVersionRedactedFixture(), estimatedGrossProfitMinor: 10000 };
  assert.equal(validateQuote(leakedQuote), false);
  const leakedLineCost = structuredClone(quoteVersionRedactedFixture());
  leakedLineCost.lineItems[0].standardCostMinor = 8000;
  assert.equal(validateQuote(leakedLineCost), false);
});

// Production break caught: forcing a submit-time probability authority onto a
// draft, or allowing a formal lifecycle state without its frozen assessment.
test("QuoteVersion probability authority follows the lifecycle state", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("quote-version");
  assert.ok(validate);

  for (const fixture of [quoteVersionFullFixture, quoteVersionRedactedFixture]) {
    const draft = { ...fixture(), status: "draft",
      probabilityAssessmentSnapshot: null };
    assert.equal(validate(draft), true, JSON.stringify(validate.errors));

    const draftWithAuthority = { ...draft,
      probabilityAssessmentSnapshot: probabilityAssessmentFixture() };
    assert.equal(validate(draftWithAuthority), false);

    const submitted = { ...fixture(), status: "submitted" };
    assert.equal(validate(submitted), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...submitted,
      probabilityAssessmentSnapshot: null }), false);
  }
});

// Production break caught: returning an untyped empty object from any successful Growth operation.
test("fix round 1 every operation has a concrete closed success response", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  const genericOperations = [];
  for (const { path, method, operation } of allPublishedOperations(document)) {
    const successes = Object.entries(operation.responses).filter(([status]) => /^2\d\d$/.test(status));
    assert.ok(successes.length > 0, `${method.toUpperCase()} ${path}`);
    for (const [status, unresolved] of successes) {
      const response = resolveInternalResponse(document, unresolved);
      const media = response.content ?? {};
      assert.ok(Object.keys(media).length > 0, `${method.toUpperCase()} ${path} ${status}`);
      for (const content of Object.values(media)) {
        const schema = content.schema;
        const isConcreteRef = typeof schema?.$ref === "string";
        const isConcreteInline = schema?.type === "string"
          || schema?.type === "array"
          || (schema?.type === "object"
            && schema.additionalProperties === false
            && Array.isArray(schema.required)
            && schema.required.length > 0)
          || (Array.isArray(schema?.oneOf)
            && schema.oneOf.length > 0
            && schema.oneOf.every((branch) => branch.type === "object"
              && branch.additionalProperties === false
              && Array.isArray(branch.required)
              && branch.required.length > 0));
        if (!isConcreteRef && !isConcreteInline) {
          genericOperations.push(`${method.toUpperCase()} ${path} ${status}`);
        }
      }
    }
  }
  assert.deepEqual(genericOperations, []);
});

// Production break caught: accepting a mutation without an explicit closed command body or accepting Finance imports through JSON/multipart parsing.
test("fix round 1 every mutation has a strict body and Finance preview accepts only raw CSV or XLSX", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  for (const { path, method, operation } of allPublishedOperations(document)) {
    if (!["post", "put", "patch", "delete"].includes(method)) continue;
    assert.equal(operation.requestBody?.required, true, `${method.toUpperCase()} ${path}`);
    const contents = operation.requestBody.content;
    assert.ok(contents && Object.keys(contents).length > 0, `${method.toUpperCase()} ${path}`);
    for (const [mediaType, content] of Object.entries(contents)) {
      const schema = content.schema;
      if (mediaType === "application/json") {
        assert.ok(
          typeof schema?.$ref === "string"
            || (schema?.type === "object" && schema.additionalProperties === false),
          `${method.toUpperCase()} ${path}`
        );
      }
    }
  }

  const preview = document.paths["/api/v1/finance/imports/preview"].post;
  assert.deepEqual(Object.keys(preview.requestBody.content).sort(), [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv"
  ]);
  for (const body of Object.values(preview.requestBody.content)) {
    assert.deepEqual(body.schema, { type: "string", format: "binary" });
  }
  assert.ok(preview.responses["415"]);
});

// Production break caught: resolving a non-bootstrap operation from a query selector, omitting the Foundation header, or accepting the pseudo-workspace all.
test("fix round 1 non-council operations use the canonical concrete workspace header", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  for (const { path, method, pathItem, operation } of allPublishedOperations(document)) {
    const parameters = effectiveParameters(document, pathItem, operation);
    const workspaceHeaders = parameters.filter((parameter) =>
      parameter.name?.toLowerCase() === "x-workspace-id" && parameter.in === "header"
    );
    if (path.startsWith("/api/v1/finance/council")) {
      assert.equal(workspaceHeaders.length, 0, `${method.toUpperCase()} ${path}`);
      continue;
    }
    assert.equal(workspaceHeaders.length, 1, `${method.toUpperCase()} ${path}`);
    assert.equal(
      workspaceHeaders[0].required,
      path === "/api/v1/growth/bootstrap" ? false : true,
      `${method.toUpperCase()} ${path}`
    );
    assert.deepEqual(workspaceHeaders[0].schema.not, { const: "all" });
    assert.equal(
      parameters.some((parameter) => parameter.name === "workspaceId" && parameter.in === "query"),
      false,
      `${method.toUpperCase()} ${path}`
    );
  }
});

test("financial council public operations derive workspace from authenticated context", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  for (const { path, method, pathItem, operation } of allPublishedOperations(document)) {
    if (!path.startsWith("/api/v1/finance/council")) continue;
    const parameters = effectiveParameters(document, pathItem, operation);
    assert.equal(parameters.some((parameter) =>
      parameter.name?.toLowerCase() === "x-workspace-id" && parameter.in === "header"
    ), false, `${method.toUpperCase()} ${path}`);
  }
});

// Production break caught: publishing a command without cookie CSRF/idempotency, requiring a nonexistent create revision, or omitting mutation concurrency and the next ETag.
test("fix round 1 mutations require auth guards and versioned responses publish ETags", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  for (const { path, method, pathItem, operation } of allPublishedOperations(document)) {
    if (!["post", "put", "patch", "delete"].includes(method)) continue;
    assert.deepEqual(operation.security, [{ bearerAuth: [] }, { cookieAuth: [], csrfToken: [] }], `${method.toUpperCase()} ${path}`);
    const parameters = effectiveParameters(document, pathItem, operation);
    for (const name of ["Idempotency-Key"]) {
      const header = parameters.find((parameter) => parameter.in === "header" && parameter.name === name);
      assert.equal(header?.required, true, `${method.toUpperCase()} ${path} ${name}`);
    }
    const ifMatch = parameters.find((parameter) =>
      parameter.in === "header" && parameter.name === "If-Match"
    );
    if (["createCatalogItem", "createFinancialCouncilRun"].includes(operation.operationId)) {
      assert.equal(ifMatch, undefined, `${method.toUpperCase()} ${path} If-Match`);
    } else {
      assert.equal(ifMatch?.required, true, `${method.toUpperCase()} ${path} If-Match`);
    }
  }

  for (const [path, method] of [
    ["/api/v1/catalog/items", "post"],
    ["/api/v1/catalog/items/{id}", "get"],
    ["/api/v1/catalog/items/{id}", "patch"],
    ["/api/v1/catalog/pricing-policies/{id}/activate", "post"],
    ["/api/v1/catalog/package-versions/{id}", "get"],
    ["/api/v1/quotes/cases/{id}", "get"],
    ["/api/v1/quotes/versions/{id}", "get"],
    ["/api/v1/quotes/versions/{id}/approve", "post"],
    ["/api/v1/acquisition/attribution-allocation-sets/{id}/activate", "post"],
    ["/api/v1/finance/settlement-allocation-sets/{id}/activate", "post"],
    ["/api/v1/acquisition/roi-closures/{closureVersionId}/reopen", "post"],
    ["/api/v1/finance/council-runs", "post"],
    ["/api/v1/finance/council-runs/{runId}", "get"],
    ["/api/v1/finance/council-policy", "get"],
    ["/api/v1/finance/council-policy", "put"],
    ["/api/v1/finance/council-runs/{runId}/portfolio-revisions", "post"],
    ["/api/v1/finance/council-runs/{runId}/portfolio-revisions/{revision}/approve", "post"],
    ["/api/v1/finance/council-runs/{runId}/reject", "post"]
  ]) {
    const operation = document.paths[path][method];
    const success = Object.entries(operation.responses).find(([status]) => /^2\d\d$/.test(status));
    const response = resolveInternalResponse(document, success?.[1]);
    assert.deepEqual(response.headers?.ETag, { $ref: "#/components/headers/ETag" }, `${method.toUpperCase()} ${path}`);
  }
});

// Production break caught: returning a fabricated zero/null ROI for an incomplete expected-ROI input.
test("fix round 1 expected ROI separates computed and not-computable redacted branches", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("growth-performance");
  assert.ok(validate);

  const computed = growthPerformanceFixture([{
    currency: "CNY",
    status: "computed",
    basis: "probability_weighted_gross_profit",
    amountVisibility: "redacted",
    roiBps: -2500,
    costCoverageBps: 10000,
    formulaVersion: "expected-roi.v1"
  }]);
  assert.equal(validate(computed), true, JSON.stringify(validate.errors));

  const notComputable = growthPerformanceFixture([{
    currency: "CNY",
    status: "not_computable",
    basis: "probability_weighted_gross_profit",
    amountVisibility: "redacted",
    reason: "missing_estimated_cost",
    costCoverageBps: 0,
    formulaVersion: "expected-roi.v1"
  }]);
  assert.equal(validate(notComputable), true, JSON.stringify(validate.errors));

  const fabricatedZero = structuredClone(notComputable);
  fabricatedZero.expectedRoiByCurrency[0].roiBps = 0;
  assert.equal(validate(fabricatedZero), false);
});

// Production break caught: labeling a positive diagnostic amount as non-positive, or attaching a reason to the wrong non-positive boundary.
test("fix round 1 quote diagnostics enforce reason-aligned non-positive amounts", async () => {
  const validate = await loadDefinitionValidator("quote-case.v1.schema.json", "QuotePreviewResult");

  const netBlocked = quoteDiagnosticFixture("net_product_amount_not_positive", 0, 500);
  assert.equal(validate(netBlocked), true, JSON.stringify(validate.errors));
  const quoteBlocked = quoteDiagnosticFixture("quoted_amount_not_positive", 500, 0);
  assert.equal(validate(quoteBlocked), true, JSON.stringify(validate.errors));
  assert.equal(validate(quoteDiagnosticFixture("net_product_amount_not_positive", 1, 1)), false);
  assert.equal(validate(quoteDiagnosticFixture("quoted_amount_not_positive", 1, 1)), false);
  assert.equal(validate(quoteDiagnosticFixture("net_product_amount_not_positive", 1, 0)), false);
  assert.equal(validate(quoteDiagnosticFixture("quoted_amount_not_positive", 0, 1)), false);
});

// Production break caught: interchanging contract ROAS, cash multiple, and collection-rate formulas or denominator failure reasons.
test("fix round 1 cash ratio identities are not interchangeable", async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get("growth-performance");
  assert.ok(validate);
  const cash = {
    currency: "CNY",
    amountVisibility: "redacted",
    contractRoas: { status: "computed", valueBps: 35000, formulaVersion: "contract-roas.v1" },
    cashMultiple: { status: "not_available", reason: "zero_acquisition_cost", formulaVersion: "cash-multiple.v1" },
    collectionRate: { status: "not_available", reason: "zero_verified_contract", formulaVersion: "collection-rate.v1" },
    coverage: {
      costCoverageBps: 10000,
      marginCoverageBps: 10000,
      cashCoverageBps: 10000,
      attributionCoverageBps: 10000
    }
  };
  assert.equal(validate(growthPerformanceFixture([], [cash])), true, JSON.stringify(validate.errors));

  const swappedFormula = structuredClone(cash);
  swappedFormula.contractRoas.formulaVersion = "collection-rate.v1";
  assert.equal(validate(growthPerformanceFixture([], [swappedFormula])), false);
  const wrongDenominator = structuredClone(cash);
  wrongDenominator.collectionRate.reason = "zero_acquisition_cost";
  assert.equal(validate(growthPerformanceFixture([], [wrongDenominator])), false);
});

// Production break caught: widening direct Finance conflict/amount failures to arbitrary API error codes.
test("fix round 1 direct Finance commands expose only the three stable error codes", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  for (const [path, method] of [
    ["/api/v1/finance/facts", "post"],
    ["/api/v1/finance/facts/{id}/verify", "post"],
    ["/api/v1/finance/facts/{id}/reject", "post"],
    ["/api/v1/finance/facts/{id}/reverse", "post"],
    ["/api/v1/finance/facts/{id}/correct", "post"]
  ]) {
    const operation = document.paths[path][method];
    for (const status of ["409", "422"]) {
      const response = resolveInternalResponse(document, operation.responses[status]);
      assert.ok(response?.headers?.["X-Error-Code"], `${method.toUpperCase()} ${path} ${status}`);
      assert.deepEqual(response.headers["X-Error-Code"].schema.enum, [
        "financial_fact_conflict",
        "financial_fact_amount_invalid",
        "amount_out_of_range"
      ], `${method.toUpperCase()} ${path} ${status}`);
      const errorSchema = response.content["application/json"].schema;
      assert.equal(errorSchema.$ref, undefined, `${method.toUpperCase()} ${path} ${status}`);
      const validateError = new Ajv2020({ strict: true }).compile(errorSchema);
      for (const code of [
        "financial_fact_conflict",
        "financial_fact_amount_invalid",
        "amount_out_of_range"
      ]) {
        assert.equal(validateError({
          code,
          message: "Finance command rejected",
          details: null,
          requestId: "request-1",
          retryable: false
        }), true, `${method.toUpperCase()} ${path} ${status} ${code}`);
      }
      assert.equal(validateError({
        code: "arbitrary_finance_error",
        message: "Finance command rejected",
        details: null,
        requestId: "request-1",
        retryable: false
      }), false, `${method.toUpperCase()} ${path} ${status}`);
    }
  }
});

// Production break caught: replacing a domain command DTO with the generic empty body, omitting one of its downstream-required fields, or accepting caller-owned workspace/actor authority.
test("fix round 2 data-bearing commands publish their exact closed inputs", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  const expected = {
    createCatalogItem: ["type", "code", "name", "description", "unit"],
    updateCatalogItem: [],
    createPricingPolicyVersion: ["catalogItemId", "packageVersionId", "currency", "listUnitPriceMinor", "unitStandardCostMinor", "defaultOrderDeliveryCostMinor", "defaultOrderSalesCostMinor", "defaultOrderServiceCostMinor", "absoluteFloorUnitPriceMinor", "standardDiscountLimitBps", "absoluteDiscountLimitBps", "targetGrossMarginBps", "absoluteMinimumGrossMarginBps", "standardPaymentTermDays", "absolutePaymentTermDays", "approvalThresholds", "surchargePolicies", "giftPolicies", "validFrom", "validTo"],
    createPackageVersion: ["currency", "validFrom", "validTo", "components"],
    updatePackageVersion: ["currency", "validFrom", "validTo", "components"],
    createQuoteCase: ["assignedTo"],
    bindQuoteCaseDeal: ["dealId"],
    previewQuote: ["catalogItemId", "pricingPolicyVersionId", "quantityMicros", "offeredUnitPriceMinor", "orderDiscountMinor", "paymentTermDays", "giftItems", "surchargeContext", "customerTargetPriceMinor", "creditRiskBps", "manualEscalation"],
    createQuoteVersion: ["previewIdentity", "quoteInput"],
    approveQuoteVersion: ["reason"],
    rejectQuoteVersion: ["reason"],
    expireQuoteVersion: ["reason"],
    createAcquisitionCostEntry: ["platform", "planId", "runId", "providerId", "category", "amountMinor", "currency", "businessOccurredAt", "provenance", "sourceRef", "evidenceHash", "externalId", "sourceIdentityRoot", "estimateReconciliationId"],
    createAcquisitionCostEstimate: ["cohortId", "planId", "runId", "amountMinor", "currency", "source", "sourceStableKey", "sourceVersion", "inputSnapshotHash", "validFrom", "validTo"],
    verifyAcquisitionCostEntry: ["reason"],
    rejectAcquisitionCostEntry: ["reason"],
    reverseAcquisitionCostEntry: ["reason"],
    correctAcquisitionCostEntry: ["amountMinor", "businessOccurredAt", "evidenceHash", "sourceRef", "reason"],
    createAttributionAllocationSet: ["sourceType", "sourceId", "items"],
    createFinancialFact: ["candidateId", "customerId", "dealId", "factType", "amountMinor", "currency", "businessOccurredAt", "provenance", "sourceRef", "evidenceHash", "externalId", "sourceIdentityRoot"],
    verifyFinancialFact: ["reason"],
    rejectFinancialFact: ["reason"],
    reverseFinancialFact: ["reason"],
    correctFinancialFact: ["reason", "replacement"],
    createFinancialSourceReport: ["currency", "sourceSystem", "sourceCursor", "reportHash", "declaredTotalMinor", "periodFrom", "periodTo"],
    createCashSettlementAllocationSet: ["sourceFactId", "items"],
    createAcquisitionCohort: ["platform", "cohortFrom", "cohortTo", "definitionVersion", "firstTouchRuleVersion"],
    createClosureAttestation: ["currency", "aspect", "periodFrom", "periodTo", "asOf", "declaredTotalMinor", "sourceSystem", "sourceCursor", "sourceReportId", "reportAllocationSetId", "reportHash", "evidenceRefs"],
    closeAcquisitionCohortRoi: ["currency", "asOf", "attestationIds"],
    acceptAdvisorRecommendation: ["reason"],
    ignoreAdvisorRecommendation: ["reason"],
    completeAdvisorRecommendation: ["reason"]
  };
  const operationsById = new Map(allPublishedOperations(document).map(({ operation }) => [operation.operationId, operation]));
  for (const [operationId, required] of Object.entries(expected)) {
    const operation = operationsById.get(operationId);
    assert.ok(operation, operationId);
    const schema = await resolvePublishedSchema(document, operation.requestBody.content["application/json"].schema);
    assert.equal(schema.type, "object", operationId);
    assert.equal(schema.additionalProperties, false, operationId);
    assert.deepEqual([...(schema.required ?? [])].sort(), [...required].sort(), operationId);
    for (const forbidden of ["workspaceId", "teamId", "ownerId", "actorId", "expectedRevision"]) {
      assert.equal(forbidden in (schema.properties ?? {}), false, `${operationId}.${forbidden}`);
    }
  }
  const update = await resolvePublishedSchema(document, operationsById.get("updateCatalogItem").requestBody.content["application/json"].schema);
  assert.equal(update.minProperties, 1);
  assert.deepEqual(Object.keys(update.properties).sort(), ["description", "name", "unit"]);
});

// Production break caught: returning an immutable ledger event or closed ROI version while publishing an ETag for a different mutable resource revision.
test("fix round 2 transition ETags describe the returned next-If-Match resource", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  const revisionedResponses = {
    createCatalogItem: "#/components/responses/CatalogItem", getCatalogItem: "#/components/responses/CatalogItem", updateCatalogItem: "#/components/responses/CatalogItem", retireCatalogItem: "#/components/responses/CatalogItem",
    createPricingPolicyVersion: "#/components/responses/PricingPolicyVersion", getPricingPolicyVersion: "#/components/responses/PricingPolicyVersion", activatePricingPolicyVersion: "#/components/responses/PricingPolicyVersion", retirePricingPolicyVersion: "#/components/responses/PricingPolicyVersion",
    createPackageVersion: "#/components/responses/PackageVersion", getPackageVersion: "#/components/responses/PackageVersion", updatePackageVersion: "#/components/responses/PackageVersion", activatePackageVersion: "#/components/responses/PackageVersion", retirePackageVersion: "#/components/responses/PackageVersion",
    createQuoteCase: "#/components/responses/QuoteCase", getQuoteCase: "#/components/responses/QuoteCase", bindQuoteCaseDeal: "#/components/responses/QuoteCase", closeQuoteCase: "#/components/responses/QuoteCase", cancelQuoteCase: "#/components/responses/QuoteCase",
    createQuoteVersion: "#/components/responses/QuoteVersion", getQuoteVersion: "#/components/responses/QuoteVersion", approveQuoteVersion: "#/components/responses/QuoteVersion", expireQuoteVersion: "#/components/responses/QuoteVersion",
    createAcquisitionCostEntry: "#/components/responses/AcquisitionCostEntry", verifyAcquisitionCostEntry: "#/components/responses/AcquisitionCostEntry", rejectAcquisitionCostEntry: "#/components/responses/AcquisitionCostEntry", reverseAcquisitionCostEntry: "#/components/responses/AcquisitionCostEntry", correctAcquisitionCostEntry: "#/components/responses/AcquisitionCostEntry",
    createAcquisitionCostEstimate: "#/components/responses/AcquisitionCostEstimate", activateAcquisitionCostEstimate: "#/components/responses/AcquisitionCostEstimate", supersedeAcquisitionCostEstimate: "#/components/responses/AcquisitionCostEstimate",
    createAttributionAllocationSet: "#/components/responses/AttributionAllocationSet", getAttributionAllocationSet: "#/components/responses/AttributionAllocationSet", activateAttributionAllocationSet: "#/components/responses/AttributionAllocationSet",
    createFinancialFact: "#/components/responses/FinancialFact", verifyFinancialFact: "#/components/responses/FinancialFact", rejectFinancialFact: "#/components/responses/FinancialFact", reverseFinancialFact: "#/components/responses/FinancialFact", correctFinancialFact: "#/components/responses/FinancialFactCorrectionResult",
    createCashSettlementAllocationSet: "#/components/responses/CashSettlementAllocationSet", getCashSettlementAllocationSet: "#/components/responses/CashSettlementAllocationSet", activateCashSettlementAllocationSet: "#/components/responses/CashSettlementAllocationSet",
    reopenRoiClosureVersion: "#/components/responses/RoiClosureSeries",
    acceptAdvisorRecommendation: "#/components/responses/AdvisorRecommendation", ignoreAdvisorRecommendation: "#/components/responses/AdvisorRecommendation", completeAdvisorRecommendation: "#/components/responses/AdvisorRecommendation",
    createFinancialCouncilRun: "#/components/responses/FinancialCouncilRun", getFinancialCouncilRun: "#/components/responses/FinancialCouncilRun", rejectFinancialCouncilRun: "#/components/responses/FinancialCouncilApproval",
    getFinancialCouncilPolicy: "#/components/responses/FinancialCouncilPolicyVersion", updateFinancialCouncilPolicy: "#/components/responses/FinancialCouncilPolicyVersion",
    createFinancialCouncilPortfolioRevision: "#/components/responses/FinancialCouncilPortfolioRevision", approveFinancialCouncilPortfolioRevision: "#/components/responses/FinancialCouncilApproval"
  };
  const actualRevisionedResponses = {};
  for (const { operation } of allPublishedOperations(document)) {
    for (const [status, unresolved] of Object.entries(operation.responses)) {
      if (!/^2\d\d$/.test(status)) continue;
      const response = resolveInternalResponse(document, unresolved);
      if (response.headers?.ETag) actualRevisionedResponses[operation.operationId] = unresolved.$ref ?? "inline";
    }
  }
  assert.deepEqual(actualRevisionedResponses, revisionedResponses);
  for (const [path, responseRef, schemaRef] of [
    ["/api/v1/acquisition/cost-entries/{id}/verify", "#/components/responses/AcquisitionCostEntry", "#/components/schemas/AcquisitionCostEntry"],
    ["/api/v1/acquisition/cost-entries/{id}/reject", "#/components/responses/AcquisitionCostEntry", "#/components/schemas/AcquisitionCostEntry"],
    ["/api/v1/acquisition/cost-entries/{id}/reverse", "#/components/responses/AcquisitionCostEntry", "#/components/schemas/AcquisitionCostEntry"],
    ["/api/v1/finance/facts/{id}/verify", "#/components/responses/FinancialFact", "#/components/schemas/FinancialFact"],
    ["/api/v1/finance/facts/{id}/reject", "#/components/responses/FinancialFact", "#/components/schemas/FinancialFact"],
    ["/api/v1/finance/facts/{id}/reverse", "#/components/responses/FinancialFact", "#/components/schemas/FinancialFact"]
  ]) {
    const operation = document.paths[path].post;
    assert.equal(operation.responses["200"].$ref, responseRef, path);
    const response = resolveInternalResponse(document, operation.responses["200"]);
    assert.deepEqual(response.headers.ETag, { $ref: "#/components/headers/ETag" }, path);
    assert.equal(response.content["application/json"].schema.$ref, schemaRef, path);
    const resource = await resolvePublishedSchema(document, response.content["application/json"].schema);
    assert.ok(resource.required.includes("revision"), path);
  }
  const reopen = document.paths["/api/v1/acquisition/roi-closures/{closureVersionId}/reopen"].post;
  assert.equal(reopen.responses["200"].$ref, "#/components/responses/RoiClosureSeries");
  const reopenResponse = resolveInternalResponse(document, reopen.responses["200"]);
  const series = await resolvePublishedSchema(document, reopenResponse.content["application/json"].schema);
  assert.deepEqual(series.required, ["id", "workspaceId", "cohortId", "currency", "status", "currentClosureVersionId", "revision", "updatedAt"]);
  assert.deepEqual(series.properties.status, { const: "open" });
});

// Production break caught: widening Deal decisions to the old kind/reason body or fabricating formal quote authority for a pre-quote disqualification.
test("fix round 2 Deal decision request and response keep amountless and formal authority branches distinct", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  const operation = document.paths["/api/v1/quotes/deals/{dealId}/decision"].post;
  const input = await resolvePublishedSchema(document, operation.requestBody.content["application/json"].schema);
  assert.deepEqual(input.oneOf.map((branch) => branch.required), [
    ["type", "quoteVersionId", "commercialAmountHash", "reasonCode", "reasonText", "occurredAt"],
    ["type", "reasonCode", "reasonText", "occurredAt"]
  ]);
  const response = resolveInternalResponse(document, operation.responses["200"]);
  const result = response.content["application/json"].schema;
  assert.equal(result.oneOf.length, 3);
  for (const branch of result.oneOf) {
    assert.deepEqual(branch.required, ["deal", "event", "quoteCase", "authorityRevision", "cancelledPublicationOperationIds"]);
    assert.equal(branch.additionalProperties, false);
  }
  const events = result.oneOf.map((branch) => branch.properties.event);
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validateWon = ajv.compile(events[0]);
  const validateLost = ajv.compile(events[1]);
  const validatePreQuote = ajv.compile(events[2]);
  const validatePreQuoteDeal = ajv.compile(result.oneOf[2].properties.deal);
  const common = {
    id: "deal-event-1", dealId: "deal-1", quoteCaseIdSnapshot: "case-1",
    reasonCode: null, reasonText: null, occurredAt: "2026-08-09T00:00:00.000Z",
    recordedAt: "2026-08-09T00:00:01.000Z", authorityRevision: 3
  };
  assert.equal(validateWon({ ...common, type: "won", commercialAuthority: "quote_projection", quoteVersionIdSnapshot: "quote-1", commercialAmountHash: `sha256:${"a".repeat(64)}`, amountMinorSnapshot: 50000, currencySnapshot: "CNY" }), true, JSON.stringify(validateWon.errors));
  assert.equal(validateLost({ ...common, type: "lost", commercialAuthority: "quote_projection", quoteVersionIdSnapshot: "quote-1", commercialAmountHash: `sha256:${"a".repeat(64)}`, amountMinorSnapshot: 50000, currencySnapshot: "CNY" }), true, JSON.stringify(validateLost.errors));
  assert.equal(validatePreQuote({ ...common, type: "lost", commercialAuthority: "pre_quote_disqualified", quoteVersionIdSnapshot: null, commercialAmountHash: null, amountMinorSnapshot: null, currencySnapshot: null, reasonCode: "no_budget" }), true, JSON.stringify(validatePreQuote.errors));
  assert.equal(validatePreQuoteDeal({ id: "deal-1", customerId: "customer-1", stage: "丢单", amountType: "estimate", ownerId: "sales-1", teamId: "team-1" }), true, JSON.stringify(validatePreQuoteDeal.errors));
  assert.equal(validatePreQuote({ ...common, type: "lost", commercialAuthority: "pre_quote_disqualified", quoteVersionIdSnapshot: "fabricated", commercialAmountHash: `sha256:${"a".repeat(64)}`, amountMinorSnapshot: 0, currencySnapshot: "CNY", reasonCode: "no_budget" }), false);
});

// Production break caught: allowing a settlement-allocation caller to forge the commercial authority snapshot that the server must derive from verified records.
test("fix round 3 settlement allocation input rejects caller authority while output retains the frozen binding", async () => {
  const validateInput = await loadDefinitionValidator("allocation-set.v1.schema.json", "CashSettlementAllocationSetCreateInput");
  const validateOutput = await loadDefinitionValidator("allocation-set.v1.schema.json", "CashSettlementAllocationItem");
  const commercialBindingSnapshot = {
    candidateId: "candidate-1",
    handoffId: "handoff-1",
    leadId: "lead-1",
    customerId: "customer-1",
    dealId: "deal-1",
    candidateVersion: 2,
    handoffContentHash: `sha256:${"a".repeat(64)}`,
    dealContentHash: `sha256:${"b".repeat(64)}`,
    bindingHashSchemaVersion: "commercial-binding.v1",
    attributionSnapshot: {
      attributionVersion: "acquisition-run.v1",
      runId: "run-1",
      planId: "plan-1",
      planVersionId: "plan-version-1",
      planVersion: 3,
      planSnapshotHash: `sha256:${"c".repeat(64)}`,
      discoveredEventId: "event-1",
      discoveredAt: "2026-08-09T00:00:00.000Z",
      shardId: "shard-1",
      operationId: "operation-1",
      connectionId: "connection-1",
      providerId: "provider-1",
      evidenceIds: ["evidence-1"],
      providerIds: ["provider-1"],
      queryIds: ["query-1"],
      strategyVersion: "strategy.v1",
      qualificationDecisionId: "decision-1",
      decisionVersion: "decision.v1",
      decisionSnapshotHash: `sha256:${"d".repeat(64)}`,
      decisionEngine: "rules",
      ruleVersion: "rules.v1",
      modelProvider: null,
      model: null,
      promptVersion: null
    },
    bindingHash: `sha256:${"e".repeat(64)}`,
    verifiedAt: "2026-08-09T00:01:00.000Z"
  };
  const itemInput = {
    targetRevenueFactId: "revenue-fact-1",
    dealId: "deal-1",
    quoteVersionId: "quote-version-1",
    amountMinor: 50000,
    currency: "CNY",
    originalPaymentFactId: null,
    originalPaymentAllocationSetId: null,
    originalPaymentAllocationItemId: null
  };
  assert.equal(validateInput({ sourceFactId: "payment-fact-1", items: [itemInput] }), true, JSON.stringify(validateInput.errors));
  assert.equal(validateInput({ sourceFactId: "payment-fact-1", items: [{ ...itemInput, commercialBindingSnapshot }] }), false);
  assert.equal(validateOutput({ allocationSetId: "allocation-set-1", ...itemInput, commercialBindingSnapshot }), true, JSON.stringify(validateOutput.errors));
});

// Production break caught: independently-valid Deal and event fragments combining into contradictory won, lost, or pre-quote decision outcomes.
test("fix round 3 Deal decision validates each outcome as one internally consistent result", async () => {
  const document = await loadNamedOpenApiSource("growth-advisor-quote-roi.v1.yaml");
  const operation = document.paths["/api/v1/quotes/deals/{dealId}/decision"].post;
  const response = resolveInternalResponse(document, operation.responses["200"]);
  const resultSchema = structuredClone(response.content["application/json"].schema);
  const replaceComponentRefs = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.$ref === "#/components/schemas/QuoteCase") {
      value.$ref = "https://goodjob.example/contracts/json-schema/quote-case.v1.schema.json";
    }
    for (const child of Object.values(value)) replaceComponentRefs(child);
  };
  replaceComponentRefs(resultSchema);
  const registry = await loadSchemaRegistry();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const schema of registry.schemaDocuments.values()) ajv.addSchema(schema);
  const validate = ajv.compile(resultSchema);
  const quoteCase = {
    id: "case-1", workspaceId: "workspace-1", candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-1",
    assignedTo: "sales-1", status: "closed", currentDraftVersionId: null, revision: 4, commercialBindingSnapshot: null,
    createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:01.000Z"
  };
  const deal = { id: "deal-1", customerId: "customer-1", ownerId: "sales-1", teamId: "team-1" };
  const commonEvent = {
    id: "deal-event-1", dealId: "deal-1", quoteCaseIdSnapshot: "case-1", reasonCode: null, reasonText: null,
    occurredAt: "2026-08-09T00:00:00.000Z", recordedAt: "2026-08-09T00:00:01.000Z", authorityRevision: 3
  };
  const formalAuthority = {
    commercialAuthority: "quote_projection", quoteVersionIdSnapshot: "quote-1", commercialAmountHash: `sha256:${"a".repeat(64)}`,
    amountMinorSnapshot: 50000, currencySnapshot: "CNY"
  };
  const result = (dealValue, eventValue, caseValue = quoteCase) => ({
    deal: dealValue, event: eventValue, quoteCase: caseValue, authorityRevision: 3, cancelledPublicationOperationIds: []
  });
  const won = result({ ...deal, stage: "成交", amountType: "won" }, { ...commonEvent, ...formalAuthority, type: "won" });
  const lost = result({ ...deal, stage: "丢单", amountType: "quoted" }, { ...commonEvent, ...formalAuthority, type: "lost", reasonCode: "competitor" });
  const preQuote = result(
    { ...deal, stage: "丢单", amountType: "estimate" },
    { ...commonEvent, type: "lost", commercialAuthority: "pre_quote_disqualified", quoteVersionIdSnapshot: null, commercialAmountHash: null, amountMinorSnapshot: null, currencySnapshot: null, reasonCode: "no_budget" },
    null
  );
  assert.equal(validate(won), true, JSON.stringify(validate.errors));
  assert.equal(validate(lost), true, JSON.stringify(validate.errors));
  assert.equal(validate(preQuote), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...won, deal: { ...won.deal, stage: "丢单" } }), false, "won + 丢单");
  assert.equal(validate({ ...lost, deal: { ...lost.deal, stage: "成交" } }), false, "lost + 成交");
  assert.equal(validate({ ...preQuote, deal: { ...preQuote.deal, stage: "成交" } }), false, "pre-quote + 成交");
  assert.equal(validate({ ...preQuote, deal: { ...preQuote.deal, amountType: "won" } }), false, "pre-quote + won amount type");
  assert.equal(validate({ ...preQuote, event: { ...preQuote.event, ...formalAuthority } }), false, "pre-quote + formal quote authority fields");
});
