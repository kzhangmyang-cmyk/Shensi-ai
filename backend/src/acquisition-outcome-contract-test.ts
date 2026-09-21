import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { default as Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { AcquisitionCandidateRunAttributionResolver } from "./acquisition-crm-outcome-reconciliation.js";
import { createDouyinAttributionTestFixture } from "./acquisition-douyin-attribution-test-fixture.js";
import { MysqlAcquisitionCohortRepository } from "./acquisition-cohort-mysql-repository.js";
import { DefaultGrowthTemporalBarrier, InMemoryGrowthTemporalTransactionRunner } from "./growth-temporal-barrier.js";

async function crawlerAttribution() {
  const fixture = await createDouyinAttributionTestFixture();
  const resolver = new AcquisitionCandidateRunAttributionResolver({
    planRuns: fixture.planRuns, crawler: fixture.crawler
  });
  const attribution = await resolver.resolve(fixture.scope, fixture.first.input);
  assert.ok(attribution);
  assert.equal(attribution.attributionVersion, "douyin-crawler.v1");
  assert.equal("decisionEngine" in attribution, false);
  return attribution;
}

async function schemaRegistry() {
  const directory = new URL("../../contracts/json-schema/", import.meta.url);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const filename of await readdir(directory)) {
    if (filename.endsWith(".v1.schema.json")) {
      ajv.addSchema(JSON.parse(await readFile(new URL(filename, directory), "utf8")));
    }
  }
  return ajv;
}

test("real crawler attribution fits commercial snapshots without fabricated decision metadata", async () => {
  const attribution = await crawlerAttribution();
  const ajv = await schemaRegistry();
  const root = "https://goodjob.example/contracts/json-schema/";
  const binding = {
    candidateId: "candidate-1", handoffId: "handoff-1", leadId: "lead-1",
    customerId: "customer-1", dealId: "deal-1", candidateVersion: 1,
    handoffContentHash: `sha256:${"a".repeat(64)}`, dealContentHash: `sha256:${"b".repeat(64)}`,
    bindingHashSchemaVersion: "commercial-binding.v1", attributionSnapshot: attribution,
    bindingHash: `sha256:${"c".repeat(64)}`, verifiedAt: "2026-08-25T02:00:00.000Z"
  };
  const validate = ajv.compile({ $ref: `${root}quote-case.v1.schema.json#/$defs/CommercialBindingSnapshot` });
  assert.equal(validate(binding), true, JSON.stringify(validate.errors));
  const validateFinancialAttribution = ajv.compile({
    $ref: `${root}financial-ledger.v1.schema.json#/properties/attributionSnapshot`
  });
  assert.equal(validateFinancialAttribution(attribution), true, JSON.stringify(validateFinancialAttribution.errors));
  const validateMember = ajv.compile({ $ref: `${root}acquisition-cohort.v1.schema.json#/$defs/AcquisitionCohortMember` });
  const member = {
    id: "member-1", cohortId: "cohort-1", workspaceId: "workspace-1", platform: "douyin",
    canonicalSubjectId: "subject-1", subjectStableKey: "subject-key-1",
    primaryCandidateId: "candidate-1", firstDiscoveredAt: attribution.discoveredAt,
    firstPlanId: attribution.planId, firstRunId: attribution.runId, firstShardId: null,
    attributionSnapshot: attribution, createdAt: "2026-08-25T02:00:00.000Z"
  };
  assert.equal(validateMember(member), true, JSON.stringify(validateMember.errors));
  assert.equal(validateMember({ ...member, firstShardId: "invented-shard" }), false);
  const legacy = { ...attribution, attributionVersion: "acquisition-run.v1",
    shardId: "shard-1", operationId: "operation-1", connectionId: "connection-1",
    providerId: "provider-1", providerIds: ["provider-1"], queryIds: ["query-1"] };
  Reflect.deleteProperty(legacy, "jobId");
  for (const snapshot of [legacy, { ...legacy, decisionEngine: "rules", ruleVersion: "rules-v1",
    modelProvider: null, model: null, promptVersion: null }]) {
    assert.equal(validate({ ...binding, attributionSnapshot: snapshot }), true, JSON.stringify(validate.errors));
    assert.equal(validateFinancialAttribution(snapshot), true, JSON.stringify(validateFinancialAttribution.errors));
    assert.equal(validateMember({ ...member, firstShardId: "shard-1", attributionSnapshot: snapshot }), true);
    assert.equal(validateMember({ ...member, attributionSnapshot: snapshot }), false);
  }
  for (const change of [{ jobId: "" }, { shardId: "shard-1" }, { providerIds: ["provider-1"] }]) {
    assert.equal(validate({ ...binding, attributionSnapshot: { ...attribution, ...change } }), false);
  }
});

test("cohort MySQL snapshot decoding returns the source shard and retains crawler null", async () => {
  const crawler = await crawlerAttribution();
  const { jobId: _jobId, ...common } = crawler.attributionVersion === "douyin-crawler.v1"
    ? crawler : assert.fail("crawler attribution expected");
  const generic = { ...common, attributionVersion: "acquisition-run.v1" as const,
    shardId: "shard-1", operationId: "operation-1", connectionId: "connection-1",
    providerId: "provider-1", providerIds: ["provider-1"], queryIds: ["query-1"] };
  for (const attribution of [crawler, generic]) {
    let queryCount = 0;
    const pool = {
      async query() {
        queryCount += 1;
        return queryCount === 1 ? [[{
          id: "version-1", cohort_member_id: "member-1", cohort_id: "cohort-1",
          workspace_id: "workspace-1", platform: "douyin", subject_stable_key: "subject-key-1",
          candidate_id: "candidate-1", event_id: attribution.discoveredEventId,
          discovered_at: attribution.discoveredAt, source_recorded_at: attribution.discoveredAt,
          source_temporal_sequence: 1, plan_id: attribution.planId, run_id: attribution.runId,
          attribution_snapshot: JSON.stringify(attribution), append_revision: 1,
          projection_recorded_at: attribution.discoveredAt, projection_temporal_sequence: 2
        }], []] : [[], []];
      }
    };
    const repository = new MysqlAcquisitionCohortRepository(pool as never,
      new DefaultGrowthTemporalBarrier(new InMemoryGrowthTemporalTransactionRunner()));
    const restored = await repository.listMembersAt("workspace-1", "cohort-1", {
      effectiveAsOf: "2026-08-25T03:00:00.000Z"
    });
    assert.equal(queryCount, 2);
    assert.equal(restored[0]?.firstShardId, attribution.shardId);
    assert.deepEqual(restored[0]?.attributionSnapshot, attribution);
  }
});
