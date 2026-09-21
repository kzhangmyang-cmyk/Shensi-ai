import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { loadGrowthContractRelease } from "./growth-openapi.js";
import {
  mountGrowthFinanceRouters
} from "./growth-finance-router-test-support.js";

export async function assertFinanceRuntimeResponsesConform(): Promise<void> {
  const release = loadGrowthContractRelease();
  const document = release.document as Record<string, any>;
  const components = structuredClone(document.components);
  for (const schema of Object.values(components.schemas)) {
    if (schema && typeof schema === "object") delete (schema as any).$id;
  }
  const permitBindingRefs = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) permitBindingRefs(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string"
      && record.$ref.startsWith(
        "#/components/schemas/CommercialBindingSnapshot/properties/"
      )) {
      record.$ref = "permissive";
      delete record.$ref;
      record.type = "object";
      return;
    }
    for (const child of Object.values(record)) permitBindingRefs(child);
  };
  permitBindingRefs(components);
  const root = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    components
  };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validatorFor = (
    operationId: string,
    path: string,
    method: "get" | "post",
    status: number
  ) => {
    const operation = document.paths[path][method];
    assert.equal(operation.operationId, operationId);
    const unresolved = operation.responses[String(status)];
    assert.ok(unresolved, `${operationId} status ${status}`);
    const releasedResponse = unresolved.$ref
      ? document.components.responses[unresolved.$ref.split("/").at(-1)]
      : unresolved;
    const content = releasedResponse.content?.["application/json"];
    assert.ok(content, `${operationId} json content`);
    const schema = content.schema;
    return ajv.compile({
      ...root,
      ...(schema.$ref ? { $ref: schema.$ref } : schema)
    });
  };

  const app = await mountGrowthFinanceRouters({
    role: "admin",
    capabilities: ["ledger.pending.create", "ledger.verify"]
  });
  try {
    const costValidate = validatorFor(
      "createAcquisitionCostEntry",
      "/api/v1/acquisition/cost-entries",
      "post",
      201
    );
    const createdCost = await app.request("/api/v1/acquisition/cost-entries", {
      method: "POST",
      headers: { "Idempotency-Key": "conformance-cost" },
      body: {
        platform: "douyin",
        planId: null,
        runId: null,
        providerId: null,
        category: "media",
        amountMinor: 10_000,
        currency: "CNY",
        businessOccurredAt: "2026-08-09T00:00:00.000Z",
        provenance: "portal_export",
        sourceRef: null,
        evidenceHash: `sha256:${"a".repeat(64)}`,
        externalId: null,
        sourceIdentityRoot: "external:portal:conformance-cost",
        estimateReconciliationId: null
      }
    });
    assert.equal(createdCost.response.status, 201);
    assert.equal(costValidate(createdCost.body), true,
      JSON.stringify(costValidate.errors));

    const verifyValidate = validatorFor(
      "verifyAcquisitionCostEntry",
      "/api/v1/acquisition/cost-entries/{id}/verify",
      "post",
      200
    );
    const verified = await app.verifyCost(
      createdCost.body.id,
      `"cost-entry:${createdCost.body.id}:${createdCost.body.revision}"`
    );
    assert.equal(verifyValidate(verified.body), true,
      JSON.stringify(verifyValidate.errors));

    const factValidate = validatorFor(
      "createFinancialFact",
      "/api/v1/finance/facts",
      "post",
      201
    );
    const fact = await app.request("/api/v1/finance/facts", {
      method: "POST",
      headers: { "Idempotency-Key": "conformance-fact" },
      body: {
        candidateId: null,
        customerId: null,
        dealId: null,
        factType: "revenue_recognized",
        amountMinor: 100000,
        currency: "CNY",
        businessOccurredAt: "2026-08-09T00:00:00.000Z",
        provenance: "invoice_confirmed",
        sourceRef: null,
        evidenceHash: `sha256:${"a".repeat(64)}`,
        externalId: null,
        sourceIdentityRoot: "external:invoice:conformance-fact"
      }
    });
    assert.equal(fact.response.status, 201);
    assert.equal(factValidate(fact.body), true,
      JSON.stringify(factValidate.errors));

    const previewValidate = validatorFor(
      "previewFinanceImport",
      "/api/v1/finance/imports/preview",
      "post",
      200
    );
    const preview = await app.previewContractWon("conformance-preview");
    assert.equal(previewValidate(preview.body), true,
      JSON.stringify(previewValidate.errors));

    const commitValidate = validatorFor(
      "commitFinanceImport",
      "/api/v1/finance/imports/{previewId}/commit",
      "post",
      202
    );
    const committed = await app.commitPreview(
      preview.body.previewId, "conformance-commit"
    );
    assert.equal(committed.response.status, 202);
    assert.equal(commitValidate(committed.body), true,
      JSON.stringify(commitValidate.errors));

    const getValidate = validatorFor(
      "getFinanceImportOperation",
      "/api/v1/finance/imports/{id}",
      "get",
      200
    );
    const fetched = await app.request(
      `/api/v1/finance/imports/${committed.body.id}`
    );
    assert.equal(getValidate(fetched.body), true,
      JSON.stringify(getValidate.errors));
  } finally {
    await app.close();
  }
}

test(
  "central Growth response suite validates released Finance operations",
  assertFinanceRuntimeResponsesConform
);
