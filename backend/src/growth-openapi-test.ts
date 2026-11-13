import assert from "node:assert/strict";
import test from "node:test";
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  createGrowthOpenApiComponents,
  createGrowthOpenApiPaths,
  loadGrowthContractRelease,
  selectGrowthContractReleaseVersion
} from "./growth-openapi.js";

test("released Growth OpenAPI loader verifies and exposes the immutable release", () => {
  const release = loadGrowthContractRelease();
  assert.equal(release.manifest.name, "growth-advisor-quote-roi");
  assert.equal(release.manifest.contractVersion, "1.0.41");
  assert.equal(
    selectGrowthContractReleaseVersion([release.manifest.contractVersion]),
    release.manifest.contractVersion
  );
  assert.equal(release.document.info.version, release.manifest.contractVersion);
  assert.equal(release.document.openapi, release.manifest.openapiVersion);
  assert.match(release.manifest.contractHash, /^sha256:[0-9a-f]{64}$/u);
});

test("release selection implements full SemVer prerelease precedence", () => {
  assert.equal(selectGrowthContractReleaseVersion([
    "2.7.0-beta.11+build.1",
    "2.7.0",
    "2.7.0-beta.2+build.42",
    "2.6.99",
    "not-a-release"
  ]), "2.7.0");
  assert.equal(selectGrowthContractReleaseVersion([
    "2.7.0-beta.11+build.1",
    "2.7.0-beta.2+build.42",
    "2.7.0-alpha.99"
  ]), "2.7.0-beta.11+build.1");
  assert.equal(selectGrowthContractReleaseVersion([
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0"
  ]), "1.0.0");
  assert.equal(selectGrowthContractReleaseVersion([
    "9007199254740992.999.999",
    "9007199254740993.0.0"
  ]), "9007199254740993.0.0");
});

test("release selection ignores build metadata for precedence", () => {
  assert.equal(selectGrowthContractReleaseVersion([
    "2.7.0-beta.1+build.42",
    "2.7.0-beta.2+build.1"
  ]), "2.7.0-beta.2+build.1");
  assert.equal(selectGrowthContractReleaseVersion([
    "2.7.0-alpha-y",
    "2.7.0-alpha-z"
  ]), "2.7.0-alpha-z");
});

test("release selection rejects distinct directories at equal precedence", () => {
  assert.throws(() => selectGrowthContractReleaseVersion([
    "2.7.0+build.41",
    "2.7.0+build.42"
  ]), /AMBIGUOUS_GROWTH_CONTRACT_RELEASE/u);
  assert.throws(() => selectGrowthContractReleaseVersion([
    "3.0.0",
    "2.7.0+build.41",
    "2.7.0+build.42"
  ]), /AMBIGUOUS_GROWTH_CONTRACT_RELEASE/u);
});

test("release selection ignores invalid directory names and fails when none remain", () => {
  assert.equal(selectGrowthContractReleaseVersion([
    "01.0.0",
    "1.01.0",
    "1.0.01",
    "1.0.0-01",
    "v1.0.0",
    "1.0.0-0+01"
  ]), "1.0.0-0+01");
  assert.throws(() => selectGrowthContractReleaseVersion([
    "01.0.0",
    "1.0.0-01",
    "v1.0.0"
  ]), /GROWTH_CONTRACT_RELEASE_NOT_FOUND/u);
});

test("Growth production paths retain valid component references for the 3.0 document", () => {
  const paths = createGrowthOpenApiPaths();
  const components = createGrowthOpenApiComponents();
  assert.equal(paths["/api/v1/growth/bootstrap"]?.get?.operationId, "getGrowthBootstrap");
  assert.equal(paths["/api/v1/catalog/items"]?.post?.operationId, "createCatalogItem");
  assert.deepEqual(paths["/api/v1/catalog/items"]?.post?.parameters, [
    { $ref: "#/components/parameters/workspaceHeader" },
    { $ref: "#/components/parameters/idempotencyKey" }
  ]);
  assert.equal(paths["/api/v1/acquisition/advisor/today"]?.get?.operationId, "getAdvisorToday");
  assert.equal(paths["/api/v1/finance/council-runs"]?.post?.operationId, "createFinancialCouncilRun");
  assert.deepEqual(paths["/api/v1/finance/council-runs"]?.post?.parameters, [
    { $ref: "#/components/parameters/idempotencyKey" }
  ]);
  assert.ok(Object.keys(components.schemas).length > 50);
  const statements = components.schemas.FinancialStatementPackagePreviewInput
    .properties.statements;
  assert.equal(statements.items.oneOf.length, 3);
  assert.deepEqual(statements["x-json-schema-prefix-items"].map((item: any) =>
    item.allOf[1].properties.kind.enum[0]), ["balance_sheet",
    "income_statement", "cash_flow_statement"]);
  assert.equal(statements["x-json-schema-items"], false);
  assert.match(JSON.stringify(paths), /#\/components\/schemas\/GrowthBootstrapResponse/u);
  assert.equal(JSON.stringify(components).includes('"const"'), false);
});

test('Growth production history advertises the optional reference reader and explicit upgrade error', () => {
  const get = createGrowthOpenApiPaths()['/api/v1/finance/cfo-sessions/{sessionId}'].get;
  const reader = get.parameters.find((parameter: any) => parameter.name === 'X-Shensi-Reference-Protocol');
  assert.deepEqual(reader, { name: 'X-Shensi-Reference-Protocol', in: 'header', required: false,
    schema: { type: 'string', enum: ['system-v1'] } });
  assert.ok(get.responses['409']); assert.ok(get.responses['422']);
  assert.equal(get.requestBody, undefined);
});

test('Growth 3.0 projection retains the topic-to-protocol dependency without mutating release bytes', () => {
  const release = loadGrowthContractRelease();
  const before = JSON.stringify(release.document);
  const components = createGrowthOpenApiComponents();
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  const validate = ajv.compile({ components, $ref: '#/components/schemas/CfoConversationInput' });
  const legacy = { question: '预算偏差', history: [] };
  assert.equal(validate(legacy), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...legacy, referenceTopicIds: ['budget_variance'] }), false);
  assert.equal(validate({ ...legacy, referenceProtocol: 'system-v1', referenceTopicIds: ['budget_variance'] }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...legacy, referenceProtocol: 'private', referenceTopicIds: ['budget_variance'] }), false);
  assert.equal(validate({ ...legacy, referenceProtocol: 'system-v1', referenceTopicIds: ['budget_variance', 'budget_variance'] }), false);
  assert.equal(JSON.stringify(components).includes('"dependentRequired"'), false);
  assert.equal(JSON.stringify(release.document), before);
});
