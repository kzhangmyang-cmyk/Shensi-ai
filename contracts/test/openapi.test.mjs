import test from "node:test";
import assert from "node:assert/strict";
import { loadOpenApi, loadOpenApiSource, loadSchemaRegistry } from "./helpers.mjs";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { loadContractHarness } from "./helpers.mjs";

const section16 = {
  "/api/v1/ai/providers": ["get"],
  "/api/v1/ai/connections": ["get", "post"],
  "/api/v1/ai/connections/{id}": ["get", "patch", "delete"],
  "/api/v1/ai/connections/{id}/models": ["get"],
  "/api/v1/ai/connections/{id}/test": ["post"],
  "/api/v1/ai/connections/{id}/activate": ["post"],
  "/api/v1/ai/calls": ["get"],
  "/api/v1/ai/calls/{id}": ["get"],
  "/api/v1/acquisition/providers": ["get"],
  "/api/v1/acquisition/provider-connections": ["get", "post"],
  "/api/v1/acquisition/provider-connections/{id}": ["get", "patch", "delete"],
  "/api/v1/acquisition/provider-connections/{id}/test": ["post"],
  "/api/v1/acquisition/content-fetch-operations": ["get", "post"],
  "/api/v1/acquisition/content-fetch-operations/{id}": ["get"],
  "/api/v1/acquisition/import-operations": ["get", "post"],
  "/api/v1/acquisition/import-operations/{id}": ["get"],
  "/api/v1/acquisition/evidence/{id}": ["get"],
  "/api/v1/acquisition/plans": ["post"],
  "/api/v1/acquisition/plans/{id}": ["get", "patch"],
  "/api/v1/acquisition/plans/{id}/revisions": ["post"],
  "/api/v1/acquisition/plans/{id}/approval": ["post"],
  "/api/v1/acquisition/plans/{id}/runs": ["post"],
  "/api/v1/acquisition/runs/{id}": ["get"],
  "/api/v1/acquisition/runs/{id}/shards": ["get"],
  "/api/v1/acquisition/runs/{id}/presentation": ["get"],
  "/api/v1/acquisition/runs/{id}/pause": ["post"],
  "/api/v1/acquisition/runs/{id}/resume": ["post"],
  "/api/v1/acquisition/runs/{id}/cancel": ["post"],
  "/api/v1/acquisition/visual-reader-sessions": ["post"],
  "/api/v1/acquisition/visual-reader-sessions/{sessionId}": ["get"],
  "/api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch": ["post"],
  "/api/v1/acquisition/visual-reader-sessions/{sessionId}:complete": ["post"],
  "/api/v1/acquisition/visual-reader-sessions/{sessionId}:abort": ["post"],
  "/api/v1/acquisition/visual-reader-artifacts/{artifactId}": ["get"],
  "/api/v1/acquisition/candidates": ["get"],
  "/api/v1/acquisition/candidates/{id}": ["get"],
  "/api/v1/acquisition/candidates/{id}/evidence": ["get"],
  "/api/v1/acquisition/candidates/{id}/identity-confirmation": ["post"],
  "/api/v1/acquisition/candidates/{candidateId}/intelligence-operations": ["post"],
  "/api/v1/acquisition/candidate-intelligence-operations/{operationId}": ["get"],
  "/api/v1/acquisition/candidates/{candidateId}/intelligence-operation": ["get"],
  "/api/v1/acquisition/candidate-intelligence-operations/{operationId}/retry": ["post"],
  "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operation": ["get"],
  "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operations": ["post"],
  "/api/v1/acquisition/candidates/{id}/qualification": ["get"],
  "/api/v1/acquisition/candidates/{id}/financial-value": ["get"],
  "/api/v1/acquisition/candidates/{id}/battle-card": ["get"],
  "/api/v1/acquisition/candidates/{id}/reviews": ["get"],
  "/api/v1/acquisition/candidates/{id}/review": ["post"],
  "/api/v1/acquisition/candidates/{id}/convert": ["post"],
  "/api/v1/acquisition/outcomes": ["get"],
  "/api/v1/acquisition/performance": ["get"],
  "/api/v1/acquisition/copilot/sessions": ["post"],
  "/api/v1/acquisition/copilot/sessions/{id}": ["get"],
  "/api/v1/acquisition/copilot/sessions/{id}/messages": ["get", "post"],
  "/api/v1/acquisition/copilot/tasks/{id}": ["get"],
  "/api/v1/acquisition/audit-events": ["get"]
};

const listPaths = [
  "/api/v1/ai/providers", "/api/v1/ai/connections", "/api/v1/ai/connections/{id}/models",
  "/api/v1/ai/calls",
  "/api/v1/acquisition/runs/{id}/shards"
];

const typedListReads = {
  "/api/v1/acquisition/candidates/{id}/evidence": "DiscoveryEvidencePagedResult",
  "/api/v1/acquisition/candidates/{id}/reviews": "ReviewEventPagedResult",
  "/api/v1/acquisition/outcomes": "OutcomeFeedbackPagedResult",
  "/api/v1/acquisition/audit-events": "AuditEventPagedResult",
  "/api/v1/acquisition/copilot/sessions/{id}/messages": "CopilotMessagePagedResult"
};

const asyncPosts = [
  "/api/v1/ai/connections/{id}/test",
  "/api/v1/acquisition/copilot/sessions"
];

const reads = {
  "/api/v1/ai/connections/{id}": "ModelConnection",
  "/api/v1/ai/calls/{id}": "ModelCallRecord",
  "/api/v1/acquisition/evidence/{id}": "DiscoveryEvidence",
  "/api/v1/acquisition/plans/{id}": "AcquisitionPlan",
  "/api/v1/acquisition/runs/{id}": "AcquisitionRun",
  "/api/v1/acquisition/runs/{id}/presentation": "AcquisitionRunPresentation",
  "/api/v1/acquisition/visual-reader-sessions/{sessionId}": "VisualReaderSession",
  "/api/v1/acquisition/candidates/{id}": "Candidate",
  "/api/v1/acquisition/candidate-intelligence-operations/{operationId}": "CandidateIntelligenceOperation",
  "/api/v1/acquisition/candidates/{candidateId}/intelligence-operation": "CandidateIntelligenceOperation",
  "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operation": "DouyinIdentityResolutionOperation",
  "/api/v1/acquisition/candidates/{id}/qualification": "QualificationDecision",
  "/api/v1/acquisition/candidates/{id}/financial-value": "FinancialValueDecision",
  "/api/v1/acquisition/candidates/{id}/battle-card": "BattleCard",
  "/api/v1/acquisition/copilot/sessions/{id}": "CopilotSession",
  "/api/v1/acquisition/copilot/tasks/{id}": "CopilotTask",
  "/api/v1/acquisition/performance": "AcquisitionPerformance"
};

test("OpenAPI exactly covers Section 16 with typed, authenticated responses", async () => {
  await loadOpenApi();
  const document = await loadOpenApiSource();
  const registry = await loadSchemaRegistry();
  assert.equal(document.servers[0].url, "/");
  assert.equal(new URL("/api/v1/acquisition/plans/plan-1/runs", `https://contract.test${document.servers[0].url}`).pathname, "/api/v1/acquisition/plans/plan-1/runs");
  assert.deepEqual(Object.keys(document.paths).sort(), Object.keys(section16).sort());
  assert.equal(document.components.schemas.ApiError.oneOf.length, 2);
  assert.equal(document.components.schemas.ApiError.oneOf[0].additionalProperties, false);
  assert.equal(document.components.schemas.ApiError.oneOf[1].additionalProperties, false);
  assert.equal(document.components.schemas.AsyncOperation.$ref, "../json-schema/async-operation.v1.schema.json");
  assert.equal(
    document.components.schemas.CandidateIntelligenceOperation.$ref,
    "../json-schema/candidate-intelligence-operation.v1.schema.json"
  );
  assert.equal(
    document.components.schemas.DouyinIdentityResolutionOperation.$ref,
    "../json-schema/douyin-identity-resolution-operation.v1.schema.json"
  );
  assert.deepEqual(
    document.components.schemas.BattleCard.oneOf.map((branch) => branch.$ref),
    [
      "#/components/schemas/BattleCardV1",
      "#/components/schemas/BattleCardV2"
    ]
  );
  assert.equal(document.components.schemas.PagedResult.additionalProperties, false);
  assert.equal(document.components.parameters.idempotencyKey.schema.minLength, 1);
  assert.equal(document.components.parameters.idempotencyKey.schema.maxLength, 200);
  for (const [path, methods] of Object.entries(section16)) {
    const actualMethods = Object.keys(document.paths[path]).filter((key) => ["get", "post", "patch", "delete"].includes(key)).sort();
    assert.deepEqual(actualMethods, [...methods].sort(), path);
    for (const method of methods) {
      const operation = document.paths[path][method];
      const isPlanRunOperation = path.startsWith("/api/v1/acquisition/plans")
        || path.startsWith("/api/v1/acquisition/runs");
      const isDiscoveryOperation = path.startsWith("/api/v1/acquisition/providers")
        || path.startsWith("/api/v1/acquisition/provider-connections")
        || path.startsWith("/api/v1/acquisition/content-fetch-operations")
        || path.startsWith("/api/v1/acquisition/import-operations");
      const isAcquisitionOperation = path.startsWith(
        "/api/v1/acquisition/"
      );
      assert.deepEqual(
        operation.security,
        isAcquisitionOperation
          ? method === "get"
            ? [{ bearerAuth: [] }, { cookieAuth: [] }]
            : [{ bearerAuth: [] }, { cookieAuth: [], csrfToken: [] }]
          : [{ bearerAuth: [] }],
        `${method.toUpperCase()} ${path}`
      );
      assert.equal(operation.responses["401"].content["application/json"].schema.$ref, "#/components/schemas/ApiError");
      if (["post", "patch", "delete"].includes(method)) {
        const requiresDiscoveryIdempotency = path === "/api/v1/acquisition/provider-connections"
          || path === "/api/v1/acquisition/content-fetch-operations"
          || path === "/api/v1/acquisition/import-operations";
        assert.equal(
          (operation.parameters ?? []).some((parameter) => [
            "#/components/parameters/idempotencyKey",
            "#/components/parameters/planIdempotencyKey"
          ].includes(parameter.$ref) || (parameter.name === "Idempotency-Key" && parameter.in === "header" && parameter.required)),
          isDiscoveryOperation
            ? requiresDiscoveryIdempotency
            : !isPlanRunOperation
              || path === "/api/v1/acquisition/plans"
              || path === "/api/v1/acquisition/plans/{id}/runs"
        );
      }
    }
  }
  for (const path of listPaths) {
    assert.equal(document.paths[path].get.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/PagedResult", path);
  }
  for (const [path, schema] of Object.entries(typedListReads)) {
    assert.equal(document.paths[path].get.responses["200"].content["application/json"].schema.$ref, `#/components/schemas/${schema}`, path);
  }
  assert.equal(document.paths["/api/v1/acquisition/candidates"].get.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/CandidatePagedResult");
  for (const [path, schema] of Object.entries(reads)) {
    assert.equal(document.paths[path].get.responses["200"].content["application/json"].schema.$ref, `#/components/schemas/${schema}`, path);
  }
  for (const path of asyncPosts) {
    assert.equal(document.paths[path].post.responses["202"].content["application/json"].schema.$ref, "#/components/schemas/AsyncOperation", path);
  }
  assert.equal(
    document.paths["/api/v1/acquisition/copilot/sessions/{id}/messages"]
      .post.responses["202"].content["application/json"].schema.$ref,
    "#/components/schemas/CopilotTask"
  );
  assert.equal(
    document.paths["/api/v1/acquisition/outcomes"].get.parameters.some(
      (parameter) =>
        parameter.$ref === "#/components/parameters/candidateId"
    ),
    true
  );
  const connectionWrites = [
    document.paths["/api/v1/ai/connections"].post,
    document.paths["/api/v1/ai/connections/{id}"].patch,
    document.paths["/api/v1/ai/connections/{id}/activate"].post
  ];
  for (const operation of connectionWrites) {
    assert.equal(operation.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/ModelConnection");
  }
  assert.deepEqual(
    document.paths["/api/v1/ai/connections/{id}"].delete.responses["200"].content["application/json"].schema,
    { type: "object", additionalProperties: false }
  );
  const connectionDelete = document.paths["/api/v1/ai/connections/{id}"].delete.responses["409"];
  assert.equal(connectionDelete.content["application/json"].schema.$ref, "#/components/schemas/ApiError");
  assert.deepEqual(connectionDelete.headers["X-Error-Code"].schema.enum, ["connection_in_use"]);
  const resume = document.paths["/api/v1/acquisition/runs/{id}/resume"].post.responses["409"];
  assert.equal(resume.content["application/json"].schema.$ref, "#/components/schemas/ApiError");
  assert.equal(resume.headers, undefined);
  const approval = document.paths["/api/v1/acquisition/plans/{id}/approval"].post;
  assert.deepEqual(approval.requestBody.content["application/json"].schema.required, ["decision", "reason"]);
  assert.ok(approval.responses["200"].headers.ETag);
  const candidateDetail = document.paths["/api/v1/acquisition/candidates/{id}"].get;
  const identityConfirmation = document.paths["/api/v1/acquisition/candidates/{id}/identity-confirmation"].post;
  assert.equal(candidateDetail.responses["200"].headers.ETag.required, true);
  assert.equal(candidateDetail.responses["200"].headers.ETag.schema.pattern, '^"candidate-v[1-9]\\d*"$');
  assert.equal(identityConfirmation.responses["200"].headers.ETag.required, true);
  assert.equal(identityConfirmation.responses["200"].headers.ETag.schema.pattern, '^"candidate-v[1-9]\\d*"$');
  assert.deepEqual(Object.keys(approval.responses).sort(), ["200", "400", "401", "404", "409", "412", "428", "500"]);
  assert.equal(document.paths["/api/v1/acquisition/plans"].post.responses["201"].content["application/json"].schema.$ref, "#/components/schemas/AcquisitionPlan");
  assert.equal(document.paths["/api/v1/acquisition/plans/{id}/revisions"].post.responses["201"].content["application/json"].schema.$ref, "#/components/schemas/AcquisitionPlan");
  assert.equal(document.paths["/api/v1/acquisition/plans/{id}/runs"].post.responses["202"].content["application/json"].schema.$ref, "#/components/schemas/AcquisitionRun");
  const providerCreate = document.paths["/api/v1/acquisition/provider-connections"].post;
  assert.ok(providerCreate.responses["201"]);
  assert.ok(providerCreate.responses["200"].headers["Idempotency-Replayed"]);
  const providerDelete = document.paths["/api/v1/acquisition/provider-connections/{id}"].delete;
  assert.ok(providerDelete.responses["204"]);
  assert.equal(providerDelete.responses["204"].headers, undefined);
  assert.equal((providerDelete.parameters ?? []).some((parameter) => parameter.name === "Idempotency-Key"), false);
  const providerTest = document.paths["/api/v1/acquisition/provider-connections/{id}/test"].post;
  assert.ok(providerTest.responses["200"]);
  assert.equal(providerTest.responses["202"], undefined);
  const importOperation = document.paths["/api/v1/acquisition/import-operations"].post;
  assert.deepEqual(Object.keys(importOperation.requestBody.content).sort(), [
    "application/octet-stream",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv"
  ]);
  assert.equal(importOperation.requestBody.content["application/json"], undefined);
  assert.ok(importOperation.responses["415"]);
  assert.equal(document.components.schemas.AcquisitionRunPresentation.$ref, "../json-schema/acquisition-run-presentation.v1.schema.json");
  assert.equal(document.components.schemas.DouyinVisualCommentObservation.$ref, "../json-schema/douyin-visual-comment-observation.v1.schema.json#/$defs/douyinVisualCommentObservation");
  assert.equal(document.components.schemas.VisualReaderSession.$ref, "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderSession");
  assert.equal(
    document.paths["/api/v1/acquisition/content-fetch-operations"]
      .get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/ContentFetchOperationList"
  );
  assert.equal(
    document.paths["/api/v1/acquisition/content-fetch-operations"]
      .post.responses["202"].content["application/json"].schema.$ref,
    "#/components/schemas/ContentFetchOperation"
  );
  assert.equal(
    document.paths["/api/v1/acquisition/content-fetch-operations/{id}"]
      .get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/ContentFetchOperation"
  );
  assert.equal(
    document.paths["/api/v1/acquisition/import-operations"]
      .get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/ImportOperationList"
  );
  assert.equal(
    document.paths["/api/v1/acquisition/import-operations"]
      .post.responses["202"].content["application/json"].schema.$ref,
    "#/components/schemas/ImportOperation"
  );
  assert.equal(
    document.paths["/api/v1/acquisition/import-operations/{id}"]
      .get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/ImportOperation"
  );
  assert.equal(
    document.components.schemas.ImportOperationList.properties.items.items.$ref,
    "#/components/schemas/ImportOperation"
  );
  const candidateIntelligenceCreates = [
    document.paths["/api/v1/acquisition/candidates/{candidateId}/intelligence-operations"].post,
    document.paths["/api/v1/acquisition/candidate-intelligence-operations/{operationId}/retry"].post
  ];
  for (const operation of candidateIntelligenceCreates) {
    assert.equal(
      operation.responses["202"].content["application/json"].schema.$ref,
      "#/components/schemas/CandidateIntelligenceOperation"
    );
    assert.deepEqual(
      operation.requestBody.content["application/json"].schema,
      { type: "object", additionalProperties: false, maxProperties: 0 }
    );
    assert.equal(
      operation.parameters.some((parameter) =>
        parameter.$ref === "#/components/parameters/idempotencyKey"),
      true
    );
  }
  assert.equal(
    candidateIntelligenceCreates[0].operationId,
    "createAcquisitionCandidateIntelligenceOperation"
  );
  assert.equal(
    candidateIntelligenceCreates[1].operationId,
    "retryAcquisitionCandidateIntelligenceOperation"
  );
  assert.equal(
    document.paths["/api/v1/acquisition/candidate-intelligence-operations/{operationId}"]
      .get.operationId,
    "getAcquisitionCandidateIntelligenceOperation"
  );
  assert.equal(
    document.paths["/api/v1/acquisition/candidates/{candidateId}/intelligence-operation"]
      .get.operationId,
    "getLatestAcquisitionCandidateIntelligenceOperation"
  );
  assert.equal(document.components.schemas.FinancialValueDecision.$ref, "../json-schema/financial-value-decision.v1.schema.json");
  assert.equal(document.components.schemas.CopilotMessage.$ref, "../json-schema/copilot-message.v1.schema.json");
  const presentation = registry.schemaDocuments.get("acquisition-run-presentation");
  assert.deepEqual(presentation.required, [
    "run",
    "providers",
    "summary",
    "automationSteps",
    "commentSignals",
    "candidateEvents",
    "nextAfter",
    "hasMore"
  ]);
  assert.equal(presentation.properties.automationSteps.minItems, 7);
  assert.equal(presentation.properties.automationSteps.maxItems, 7);
  assert.equal(presentation.properties.commentSignals.maxItems, 50);
  assert.equal(
    presentation.properties.commentSignals.items.properties.avatar,
    undefined
  );
  assert.deepEqual(
    presentation.properties.candidateEvents.items.properties.candidate.required,
    [
      "id",
      "subjectKind",
      "displayName",
      "industry",
      "region",
      "domain",
      "status",
      "version",
      "identityResolved",
      "updatedAt"
    ]
  );
  assert.deepEqual(presentation.properties.candidateEvents.items.properties.financialValue.type, ["null", "object"]);
  assert.equal(presentation.properties.summary.properties.expectedRevenueByCurrency.type, "array");
});

test("authorized visual reader routes reuse the acquisition API style and binary artifact boundary", async () => {
  const document = await loadOpenApiSource();
  const componentRefs = {
    DouyinVisualCommentObservation: "../json-schema/douyin-visual-comment-observation.v1.schema.json#/$defs/douyinVisualCommentObservation",
    OpaqueRectRedactionProof: "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderOpaqueRectRedactionProof",
    VisualObservationSubmission: "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderObservationSubmission",
    VisualReaderLimits: "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderLimits",
    VisualReaderUsage: "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderUsage",
    VisualReaderOutcome: "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderOutcome",
    VisualReaderSession: "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderSession",
    VisualReaderCreateRequest: "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderCreateRequest",
    VisualObservationBatchRequest: "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderObservationBatchRequest",
    VisualObservationBatchResponse: "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderObservationBatchResponse",
    VisualReaderCompleteRequest: "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderCompleteRequest",
    VisualReaderAbortRequest: "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderAbortRequest"
  };
  for (const [name, ref] of Object.entries(componentRefs)) {
    assert.equal(document.components.schemas[name]?.$ref, ref, name);
  }

  const create = document.paths[
    "/api/v1/acquisition/visual-reader-sessions"
  ].post;
  const read = document.paths[
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}"
  ].get;
  const batch = document.paths[
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch"
  ].post;
  const complete = document.paths[
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}:complete"
  ].post;
  const abort = document.paths[
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}:abort"
  ].post;

  assert.equal(
    create.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/VisualReaderCreateRequest"
  );
  assert.equal(
    create.responses["201"].content["application/json"].schema.$ref,
    "#/components/schemas/VisualReaderSession"
  );
  assert.equal(
    create.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/VisualReaderSession"
  );
  assert.deepEqual(
    create.responses["200"].headers["Idempotency-Replayed"].schema.enum,
    ["true"]
  );
  assert.equal(
    read.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/VisualReaderSession"
  );
  assert.equal(
    batch.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/VisualObservationBatchRequest"
  );
  assert.equal(
    batch.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/VisualObservationBatchResponse"
  );
  assert.deepEqual(
    batch.responses["200"].headers["Idempotency-Replayed"].schema.enum,
    ["true"]
  );
  assert.equal(
    complete.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/VisualReaderCompleteRequest"
  );
  assert.equal(
    abort.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/VisualReaderAbortRequest"
  );
  for (const operation of [complete, abort]) {
    assert.equal(
      operation.responses["200"].content["application/json"].schema.$ref,
      "#/components/schemas/VisualReaderSession"
    );
    assert.equal(
      operation.responses["200"].headers?.["Idempotency-Replayed"],
      undefined
    );
  }
  for (const operation of [create, batch, complete, abort]) {
    assert.equal(
      operation.parameters.some((parameter) =>
        parameter.$ref === "#/components/parameters/idempotencyKey"),
      true
    );
    assert.deepEqual(operation.security, [
      { bearerAuth: [] },
      { cookieAuth: [], csrfToken: [] }
    ]);
    assert.ok(operation.responses["403"]);
    assert.ok(operation.responses["413"]);
  }
  assert.equal(read.responses["403"], undefined);
  assert.equal(read.responses["413"], undefined);
  assert.match(batch.description, /Task 3 service.*sourceUrl.*videoId/u);
  assert.match(batch.description, /Task 3 service.*sessionId/u);

  const artifact = document.paths[
    "/api/v1/acquisition/visual-reader-artifacts/{artifactId}"
  ].get;
  assert.deepEqual(artifact.security, [
    { bearerAuth: [] },
    { cookieAuth: [] }
  ]);
  assert.equal(artifact.responses["403"], undefined);
  assert.equal(artifact.responses["413"], undefined);
  assert.deepEqual(
    Object.keys(artifact.responses["200"].content),
    ["image/webp"]
  );
  assert.deepEqual(
    artifact.responses["200"].content["image/webp"].schema,
    { type: "string", format: "binary" }
  );
  assert.deepEqual(
    artifact.responses["200"].headers["Cache-Control"].schema.enum,
    ["private, no-store"]
  );
  assert.deepEqual(
    artifact.responses["200"].headers["X-Content-Type-Options"].schema.enum,
    ["nosniff"]
  );
  assert.deepEqual(
    artifact.responses["200"].headers["Content-Security-Policy"].schema.enum,
    ["default-src 'none'; frame-ancestors 'none'; sandbox"]
  );
  assert.equal(
    artifact.responses["200"].content["application/json"],
    undefined
  );
});

test("Douyin identity resolution exposes a closed retry contract", async () => {
  const document = await loadOpenApiSource();
  const latest = document.paths[
    "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operation"
  ].get;
  const retry = document.paths[
    "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operations"
  ].post;
  assert.deepEqual(Object.keys(latest.responses).sort(), ["200", "401", "404"]);
  assert.deepEqual(Object.keys(retry.responses).sort(), [
    "202", "400", "401", "403", "404", "409", "422", "429"
  ]);
  assert.equal(
    retry.requestBody.content["application/json"].schema.maxProperties,
    0
  );
  assert.equal(
    retry.parameters.some((parameter) =>
      parameter.$ref === "#/components/parameters/idempotencyKey"
    ),
    true
  );
  assert.ok(retry.responses["202"].headers["Idempotency-Replayed"]);
});

test("workflow-internal candidate and outcome writes stay outside the release contract", async () => {
  const document = await loadOpenApiSource();
  const blockedDirectWrites = [
    "/api/v1/acquisition/evidence",
    "/api/v1/acquisition/candidates",
    "/api/v1/acquisition/candidates/{id}/evidence",
    "/api/v1/acquisition/candidates/{id}/research",
    "/api/v1/acquisition/candidates/{id}/qualification",
    "/api/v1/acquisition/candidates/{id}/battle-card",
    "/api/v1/acquisition/outcomes"
  ];
  for (const path of blockedDirectWrites) {
    assert.equal(document.paths[path]?.post, undefined, path);
  }
  assert.ok(document.paths["/api/v1/acquisition/evidence/{id}"].get);
  assert.ok(document.paths["/api/v1/acquisition/candidates/{id}/financial-value"].get);
  assert.ok(document.paths["/api/v1/acquisition/copilot/sessions/{id}/messages"].get);
});

test("every named API resource component accepts a canonical valid instance", async () => {
  const document = await loadOpenApi();
  const registry = await loadSchemaRegistry();
  const names = ["ModelProvider", "ModelConnection", "ModelCallRecord", "DiscoveryProvider", "ProviderConnection", "ContentFetchOperation", "ImportOperation", "AcquisitionPlan", "AcquisitionRun", "AcquisitionOperationShard", "AcquisitionRunPresentation", "DiscoveryEvidence", "QualificationDecision", "BattleCard", "ReviewEvent", "OutcomeFeedback", "FinancialValueDecision", "CopilotSession", "CopilotMessage", "CopilotTask"];
  const examples = Object.fromEntries(names.map((name) => [name, buildCanonicalExample(registry.schemaDocuments.get(toKebab(name)))]));
  const {
    oneOf: _contentFetchStates,
    ...contentFetchBase
  } = registry.schemaDocuments.get("content-fetch-operation");
  examples.ContentFetchOperation = {
    ...buildCanonicalExample(contentFetchBase),
    status: "queued",
    evidenceCount: 0,
    evidenceIds: [],
    candidateCount: 0,
    candidateIds: [],
    commentSampleSummary: null
  };
  examples.ImportOperation = {
    ...examples.ImportOperation,
    status: "queued",
    rowCount: 0,
    acceptedRowCount: 0,
    errorRows: [],
    evidenceCount: 0,
    evidenceIds: [],
    candidateCount: 0,
    candidateIds: [],
    errorCode: null,
    startedAt: null,
    completedAt: null
  };
  examples.Candidate = [
    buildCanonicalExample(registry.schemaDocuments.get("organization-candidate")),
    buildCanonicalExample(registry.schemaDocuments.get("individual-demand-signal"))
  ];
  examples.AsyncOperation = { id: "op", kind: "run", status: "running", resourceId: null, error: null, createdAt: "2026-07-23T00:00:00.000Z", completedAt: null };
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  ajv.addSchema(registry.schemaDocuments.get("douyin-visual-comment-observation"));
  ajv.addSchema(registry.schemaDocuments.get("acquisition-visual-reader-session"));
  for (const [name, value] of Object.entries(examples)) {
    if (name === "Candidate") {
      assert.deepEqual(document.components.schemas.Candidate.oneOf.map((branch) => branch.$ref), ["../json-schema/organization-candidate.v1.schema.json", "../json-schema/individual-demand-signal.v1.schema.json"]);
      const validate = ajv.compile({ oneOf: [registry.schemaDocuments.get("organization-candidate"), registry.schemaDocuments.get("individual-demand-signal")] });
      for (const instance of value) assert.equal(validate(instance), true, JSON.stringify(validate.errors));
      const paged = document.components.schemas.CandidatePagedResult;
      assert.deepEqual(paged.properties.items.items.oneOf.map((branch) => branch.$ref), ["../json-schema/organization-candidate.v1.schema.json", "../json-schema/individual-demand-signal.v1.schema.json"]);
      const validatePaged = ajv.compile({ ...paged, properties: { ...paged.properties, items: { type: "array", items: { oneOf: [registry.schemaDocuments.get("organization-candidate"), registry.schemaDocuments.get("individual-demand-signal")] } } } });
      assert.equal(validatePaged({ items: value, nextCursor: null }), true, JSON.stringify(validatePaged.errors));
      continue;
    }
    if (name === "AsyncOperation") {
      assert.equal(document.components.schemas.AsyncOperation.$ref, "../json-schema/async-operation.v1.schema.json");
      const validate = registry.validators.get("async-operation");
      assert.equal(validate(value), true, JSON.stringify(validate.errors));
      continue;
    }
    const schema = document.components.schemas[name];
    if (name === "BattleCard") {
      assert.deepEqual(
        schema.oneOf.map((branch) => branch.$ref),
        [
          "../json-schema/battle-card.v1.schema.json",
          "../json-schema/battle-card.v2.schema.json"
        ]
      );
      continue;
    }
    assert.equal(schema.$ref, `../json-schema/${toKebab(name)}.v1.schema.json`, name);
    const canonical = schema.$ref ? registry.schemaDocuments.get(schema.$ref.split("/").pop().replace(".v1.schema.json", "")) : schema;
    const validate = ajv.compile(canonical);
    for (const instance of [value]) assert.equal(validate(instance), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
});

test("OpenAPI canonical edge cases preserve optional timestamps, nullable cursors, and typed async errors", async () => {
  const document = await loadOpenApiSource();
  const registry = await loadSchemaRegistry();
  const modelConnection = {
    id: "connection_1", ownerId: "owner_1", provider: "openai", model: "gpt-5",
    credentialVersion: 1,
    capabilitySnapshot: { structuredOutput: true, toolCalling: true, parallelToolCalling: true, streaming: true, modelListing: true },
    status: "active", createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T01:00:00.000Z"
  };
  assert.equal(registry.validators.get("model-connection")(modelConnection), true);
  assert.equal(document.components.schemas.ModelConnection.$ref, "../json-schema/model-connection.v1.schema.json");

  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  assert.deepEqual(document.components.schemas.PagedResult.properties.nextCursor.type, ["string", "null"]);
  assert.equal("nullable" in document.components.schemas.PagedResult.properties.nextCursor, false);
  assert.equal(ajv.compile(document.components.schemas.PagedResult)({ items: [], nextCursor: null }), true);

  assert.equal(document.components.schemas.AsyncOperation.$ref, "../json-schema/async-operation.v1.schema.json");
  const validateAsync = registry.validators.get("async-operation");
  const base = { id: "op_1", kind: "run", status: "failed", resourceId: null, createdAt: "2026-07-23T00:00:00.000Z", completedAt: "2026-07-23T00:01:00.000Z" };
  assert.equal(validateAsync({ ...base, error: { code: "provider_failed", message: "Provider failed", details: {}, requestId: "req_1", retryable: true } }), true);
  assert.equal(validateAsync({ ...base, error: { arbitrary: true } }), false);
});

function toKebab(name) { return name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase(); }
function buildCanonicalExample(schema, root = schema) {
  if (schema.$ref) return buildCanonicalExample(root.$defs[schema.$ref.split("/").pop()], root);
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum.find((value) => value !== null);
  if (schema.oneOf) return buildCanonicalExample(schema.oneOf[0], root);
  const type = Array.isArray(schema.type) ? schema.type.find((value) => value !== "null") : schema.type;
  if (type === "string") return schema.format === "date-time"
    ? "2026-07-23T00:00:00.000Z"
    : schema.format === "uri"
      ? "https://example.com"
      : schema.maxLength === 3
        ? "USD"
        : schema.pattern === "^[A-Z][A-Z0-9_]{2,63}$"
          ? "COPILOT_TASK_FAILED"
          : "value";
  if (type === "integer" || type === "number") return Math.max(schema.minimum ?? 0, 1);
  if (type === "boolean") return true;
  if (type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => buildCanonicalExample(schema.items ?? {}, root));
  if (type === "object" || schema.properties) return Object.fromEntries((schema.required ?? []).map((key) => [key, buildCanonicalExample(schema.properties[key], root)]));
  return {};
}
