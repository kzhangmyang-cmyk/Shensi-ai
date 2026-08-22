import assert from "node:assert/strict";
import test from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv } from "ajv";
import express from "express";
import {
  createAcquisitionOpenApiPaths
} from "./acquisition-openapi.js";
import {
  createOpenApiDocument
} from "./swagger.js";

const unsupportedOpenApi30SchemaKeywords = new Set([
  "$schema",
  "$id",
  "$defs",
  "const",
  "contains",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "dependentRequired",
  "dependentSchemas",
  "prefixItems",
  "minContains",
  "maxContains",
  "propertyNames"
]);

function unsupportedOpenApi30SchemaLocations(
  value: unknown,
  path = "$"
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      unsupportedOpenApi30SchemaLocations(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];

  const locations: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (unsupportedOpenApi30SchemaKeywords.has(key)) {
      locations.push(itemPath);
    }
    if (key === "type" && (
      Array.isArray(item) || item === "null"
    )) {
      locations.push(itemPath);
    }
    if (key === "$ref" && typeof item === "string"
      && item.includes("/$defs/")) {
      locations.push(itemPath);
    }
    locations.push(...unsupportedOpenApi30SchemaLocations(item, itemPath));
  }
  return locations;
}

test("acquisition OpenAPI publishes the complete agent control surface", () => {
  const paths = createAcquisitionOpenApiPaths();
  const required = [
    "/api/v1/acquisition/providers",
    "/api/v1/acquisition/provider-connections",
    "/api/v1/acquisition/provider-connections/{id}",
    "/api/v1/acquisition/provider-connections/{id}/test",
    "/api/v1/acquisition/content-fetch-operations",
    "/api/v1/acquisition/content-fetch-operations/{id}",
    "/api/v1/acquisition/import-operations",
    "/api/v1/acquisition/import-operations/{id}",
    "/api/v1/acquisition/evidence/{id}",
    "/api/v1/acquisition/candidates",
    "/api/v1/acquisition/candidates/{id}",
    "/api/v1/acquisition/candidates/{id}/evidence",
    "/api/v1/acquisition/candidates/{id}/identity-confirmation",
    "/api/v1/acquisition/candidates/{candidateId}/intelligence-operations",
    "/api/v1/acquisition/candidate-intelligence-operations/{operationId}",
    "/api/v1/acquisition/candidates/{candidateId}/intelligence-operation",
    "/api/v1/acquisition/candidate-intelligence-operations/{operationId}/retry",
    "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operation",
    "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operations",
    "/api/v1/acquisition/candidates/{id}/qualification",
    "/api/v1/acquisition/candidates/{id}/battle-card",
    "/api/v1/acquisition/candidates/{id}/reviews",
    "/api/v1/acquisition/candidates/{id}/review",
    "/api/v1/acquisition/candidates/{id}/convert",
    "/api/v1/acquisition/outcomes",
    "/api/v1/acquisition/audit-events",
    "/api/v1/acquisition/copilot/sessions",
    "/api/v1/acquisition/copilot/sessions/{id}",
    "/api/v1/acquisition/copilot/sessions/{id}/messages",
    "/api/v1/acquisition/copilot/tasks/{id}",
    "/api/v1/acquisition/plans",
    "/api/v1/acquisition/plans/{id}",
    "/api/v1/acquisition/plans/{id}/revisions",
    "/api/v1/acquisition/plans/{id}/approval",
    "/api/v1/acquisition/plans/{id}/runs",
    "/api/v1/acquisition/runs/{id}",
    "/api/v1/acquisition/runs/{id}/shards",
    "/api/v1/acquisition/runs/{id}/presentation",
    "/api/v1/acquisition/runs/{id}/pause",
    "/api/v1/acquisition/runs/{id}/resume",
    "/api/v1/acquisition/runs/{id}/cancel",
    "/api/v1/acquisition/visual-reader-sessions",
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}",
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch",
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}:complete",
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}:abort",
    "/api/v1/acquisition/visual-reader-artifacts/{artifactId}"
  ];
  for (const path of required) {
    assert.ok(paths[path], `missing acquisition OpenAPI path: ${path}`);
  }
});

test("acquisition OpenAPI exposes only the safe Douyin identity operation DTO", () => {
  const paths = createAcquisitionOpenApiPaths();
  const latest = paths[
    "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operation"
  ]!.get as Record<string, any>;
  const retry = paths[
    "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operations"
  ]!.post as Record<string, any>;

  assert.deepEqual(Object.keys(latest.responses).sort(), ["200", "401", "404"]);
  assert.deepEqual(Object.keys(retry.responses).sort(), [
    "202", "400", "401", "403", "404", "409", "422", "429"
  ]);
  assert.equal(retry.parameters.some((parameter: Record<string, unknown>) =>
    parameter.in === "header" && parameter.name === "Idempotency-Key"
      && parameter.required === true
  ), true);
  assert.equal(retry.requestBody.content["application/json"].schema.maxProperties, 0);
  const schema = latest.responses["200"].content["application/json"].schema;
  assert.equal(schema.additionalProperties, false);
  for (const privateField of [
    "ownerId", "teamId", "actorId", "searchConnections", "planSessionId",
    "sourceEvidenceFingerprint", "idempotencyKeyHash", "requestHash",
    "leaseOwner", "leaseToken", "leaseExpiresAt"
  ]) assert.equal(schema.properties[privateField], undefined, privateField);
});

test("every published acquisition operation has a unique stable camelCase id", () => {
  const paths = createAcquisitionOpenApiPaths();
  const ids: string[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of ["get", "post", "patch", "delete"] as const) {
      const operation = pathItem[method];
      if (!operation) continue;
      const id = operation.operationId;
      assert.equal(typeof id, "string", `${method.toUpperCase()} ${path}`);
      assert.match(
        id as string,
        /^[a-z][A-Za-z0-9]+$/u,
        `${method.toUpperCase()} ${path}`
      );
      ids.push(id as string);
    }
  }

  assert.equal(ids.length, 58);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    paths["/api/v1/acquisition/plans/{id}/approval"]?.post?.operationId,
    "approveAcquisitionPlan"
  );
});

test("visual reader OpenAPI publishes six secure routes and actual replay semantics", () => {
  const paths = createAcquisitionOpenApiPaths();
  const create = paths[
    "/api/v1/acquisition/visual-reader-sessions"
  ]!.post as Record<string, any>;
  const detail = paths[
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}"
  ]!.get as Record<string, any>;
  const batch = paths[
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch"
  ]!.post as Record<string, any>;
  const complete = paths[
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}:complete"
  ]!.post as Record<string, any>;
  const abort = paths[
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}:abort"
  ]!.post as Record<string, any>;
  const artifact = paths[
    "/api/v1/acquisition/visual-reader-artifacts/{artifactId}"
  ]!.get as Record<string, any>;

  for (const write of [create, batch, complete, abort]) {
    assert.deepEqual(write.security, [
      { bearerAuth: [] },
      { cookieAuth: [], csrfToken: [] }
    ]);
    assert.equal(write.parameters.some((parameter: Record<string, any>) =>
      parameter.name === "Idempotency-Key"
      && parameter.in === "header"
      && parameter.required === true), true);
    assert.ok(write.responses["403"]);
    assert.ok(write.responses["413"]);
  }
  for (const read of [detail, artifact]) {
    assert.deepEqual(read.security, [
      { bearerAuth: [] },
      { cookieAuth: [] }
    ]);
    assert.equal(read.responses["403"], undefined);
    assert.equal(read.responses["413"], undefined);
  }

  assert.ok(create.responses["200"].headers["Idempotency-Replayed"]);
  assert.ok(batch.responses["200"].headers["Idempotency-Replayed"]);
  assert.equal(
    complete.responses["200"].headers?.["Idempotency-Replayed"],
    undefined
  );
  assert.equal(
    abort.responses["200"].headers?.["Idempotency-Replayed"],
    undefined
  );

  const batchSchema = batch.requestBody.content["application/json"].schema;
  assert.equal(batchSchema.additionalProperties, false);
  assert.equal(batchSchema.properties.observations.maxItems, 20);
  assert.equal(batchSchema.properties.observations.contains, undefined);
  const cardBounds = batchSchema.properties.observations.items
    .properties.cardBounds;
  assert.equal(cardBounds.properties.width.minimum, 0);
  assert.equal(cardBounds.properties.width.exclusiveMinimum, true);
  assert.equal(cardBounds.properties.height.minimum, 0);
  assert.equal(cardBounds.properties.height.exclusiveMinimum, true);
  const binary = artifact.responses["200"];
  assert.equal(binary.content["application/json"], undefined);
  assert.deepEqual(
    binary.content["image/webp"].schema,
    { type: "string", format: "binary" }
  );
  assert.equal(
    binary.headers["Cache-Control"].schema.enum[0],
    "private, no-store"
  );
  assert.equal(
    binary.headers["X-Content-Type-Options"].schema.enum[0],
    "nosniff"
  );
  assert.equal(
    binary.headers["Content-Security-Policy"].schema.enum[0],
    "default-src 'none'; frame-ancestors 'none'; sandbox"
  );
});

test("candidate intelligence operations publish strict async control contracts", () => {
  const paths = createAcquisitionOpenApiPaths();
  const create = paths[
    "/api/v1/acquisition/candidates/{candidateId}/intelligence-operations"
  ]!.post as Record<string, any>;
  const retry = paths[
    "/api/v1/acquisition/candidate-intelligence-operations/{operationId}/retry"
  ]!.post as Record<string, any>;
  const detail = paths[
    "/api/v1/acquisition/candidate-intelligence-operations/{operationId}"
  ]!.get as Record<string, any>;
  const latest = paths[
    "/api/v1/acquisition/candidates/{candidateId}/intelligence-operation"
  ]!.get as Record<string, any>;

  assert.equal(
    create.operationId,
    "createAcquisitionCandidateIntelligenceOperation"
  );
  assert.equal(
    detail.operationId,
    "getAcquisitionCandidateIntelligenceOperation"
  );
  assert.equal(
    latest.operationId,
    "getLatestAcquisitionCandidateIntelligenceOperation"
  );
  assert.equal(
    retry.operationId,
    "retryAcquisitionCandidateIntelligenceOperation"
  );
  assert.deepEqual(
    create.parameters.map((parameter: { name: string }) => parameter.name),
    ["candidateId", "Idempotency-Key"]
  );
  assert.deepEqual(
    retry.parameters.map((parameter: { name: string }) => parameter.name),
    ["operationId", "Idempotency-Key"]
  );
  assert.deepEqual(
    detail.parameters.map((parameter: { name: string }) => parameter.name),
    ["operationId"]
  );
  assert.deepEqual(
    latest.parameters.map((parameter: { name: string }) => parameter.name),
    ["candidateId"]
  );
  for (const operation of [create, retry]) {
    assert.deepEqual(
      operation.requestBody.content["application/json"].schema,
      { type: "object", additionalProperties: false, maxProperties: 0 }
    );
    assert.ok(operation.responses["202"]);
    assert.equal(operation.responses["200"], undefined);
  }
  const schema = detail.responses["200"].content["application/json"].schema;
  assert.deepEqual(schema.required, [
    "id",
    "candidateId",
    "status",
    "currentStage",
    "completedStages",
    "skippedStages",
    "research",
    "qualification",
    "battleCardId",
    "failure",
    "createdAt",
    "startedAt",
    "updatedAt",
    "completedAt",
    "failedAt"
  ]);
  assert.equal(schema.additionalProperties, false);
  for (const internalField of [
    "ownerId",
    "teamId",
    "actorId",
    "sessionId",
    "identityFingerprint",
    "idempotencyKeyHash",
    "requestHash",
    "leaseOwner",
    "leaseToken",
    "leaseExpiresAt"
  ]) {
    assert.equal(schema.properties[internalField], undefined, internalField);
  }
});

test("run presentation publishes a strict read-only paginated DTO", () => {
  const paths = createAcquisitionOpenApiPaths();
  const path = paths[
    "/api/v1/acquisition/runs/{id}/presentation"
  ];
  const operation = path?.get as Record<string, any> | undefined;
  assert.ok(operation);
  assert.equal(path?.post, undefined);
  assert.deepEqual(
    operation.parameters.map(
      (parameter: { name: string }) => parameter.name
    ),
    ["id", "after", "limit"]
  );
  assert.equal(operation.parameters[1].schema.maxLength, 8192);
  assert.equal(operation.parameters[2].schema.default, 50);
  assert.equal(operation.parameters[2].schema.maximum, 100);

  const schema =
    operation.responses["200"].content["application/json"].schema;
  assert.deepEqual(schema.required, [
    "run",
    "providers",
    "summary",
    "automationSteps",
    "commentSignals",
    "candidateEvents",
    "nextAfter",
    "hasMore"
  ]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.automationSteps.minItems, 7);
  assert.equal(schema.properties.automationSteps.maxItems, 7);
  assert.deepEqual(schema.properties.automationSteps.items.properties.id.enum, [
    "discover_video_urls",
    "resolve_video_ids",
    "fetch_public_comment_samples",
    "normalize_platform_events",
    "aggregate_actor_signals",
    "qualify_candidates",
    "refresh_run_presentation"
  ]);
  assert.deepEqual(
    schema.properties.automationSteps.items.properties.errorCode.enum,
    [
      null,
      "public_sample_unavailable",
      "access_restricted",
      "rate_limited",
      "video_id_unresolved",
      "source_payload_invalid",
      "no_public_comments",
      "model_output_invalid"
    ]
  );
  assert.equal(schema.properties.commentSignals.maxItems, 50);
  assert.equal(
    schema.properties.commentSignals.items.properties.avatar,
    undefined
  );
  assert.ok(schema.properties.summary.required.includes("discoveredVideos"));
  assert.ok(schema.properties.summary.required.includes("commentsSampled"));
  assert.ok(schema.properties.summary.required.includes("validDemandSignals"));
  assert.ok(schema.properties.summary.required.includes("unresolvedActors"));
  assert.ok(schema.properties.summary.required.includes("highPotentialSignals"));
  assert.deepEqual(
    schema.properties.candidateEvents.items.required,
    [
      "eventId",
      "createdAt",
      "candidateId",
      "candidate",
      "qualification",
      "financialValue",
      "sourcePlatforms",
      "evidenceCount"
    ]
  );
  assert.equal(
    schema.properties.candidateEvents.items.properties.financialValue
      .nullable,
    true,
    "missing financial values must be represented as null"
  );
  assert.equal(
    schema.properties.candidateEvents.items.properties.qualification
      .additionalProperties,
    false
  );
  assert.ok(
    schema.properties.candidateEvents.items.properties.qualification
      .required.includes("hardGateFailures")
  );
  assert.equal(
    schema.properties.candidateEvents.items.properties.financialValue
      .additionalProperties,
    false
  );
  assert.ok(
    schema.properties.candidateEvents.items.properties.financialValue
      .required.includes("qualificationDecisionId")
  );
  assert.equal(
    schema.properties.summary.properties.expectedRevenueByCurrency.type,
    "array",
    "currencies must remain separate rows"
  );
});

test("production OpenAPI does not advertise direct domain writes", () => {
  const paths = createAcquisitionOpenApiPaths();
  const blockedWrites = [
    "/api/v1/acquisition/evidence",
    "/api/v1/acquisition/candidates",
    "/api/v1/acquisition/candidates/{id}/evidence",
    "/api/v1/acquisition/candidates/{id}/research",
    "/api/v1/acquisition/candidates/{id}/qualification",
    "/api/v1/acquisition/candidates/{id}/battle-card",
    "/api/v1/acquisition/outcomes"
  ];

  for (const path of blockedWrites) {
    assert.equal(
      paths[path]?.post,
      undefined,
      `production OpenAPI must not publish blocked POST ${path}`
    );
  }
  assert.ok(paths["/api/v1/acquisition/evidence/{id}"]?.get);
  assert.ok(paths["/api/v1/acquisition/candidates"]?.get);
  assert.ok(
    paths["/api/v1/acquisition/candidates/{id}/qualification"]?.get
  );
  assert.ok(paths["/api/v1/acquisition/outcomes"]?.get);
});

test("every published JSON write body is a closed object contract", () => {
  const paths = createAcquisitionOpenApiPaths();
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of ["post", "patch"] as const) {
      const operation = pathItem[method] as Record<string, any> | undefined;
      const schema = operation?.requestBody?.content?.[
        "application/json"
      ]?.schema as Record<string, any> | undefined;
      if (!schema) continue;

      const variants = schema.oneOf ?? [schema];
      for (const variant of variants) {
        assert.equal(
          variant.type,
          "object",
          `${method.toUpperCase()} ${path} must publish an object body`
        );
        if (variant.maxProperties === 0) {
          assert.equal(
            variant.properties,
            undefined,
            `${method.toUpperCase()} ${path} strict empty body must not invent properties`
          );
        } else {
          assert.ok(
            variant.properties,
            `${method.toUpperCase()} ${path} must declare body properties`
          );
        }
        assert.ok(
          variant.required === undefined
          || (
            Array.isArray(variant.required)
            && variant.required.length > 0
          ),
          `${method.toUpperCase()} ${path} must omit empty required arrays`
        );
        assert.equal(
          variant.additionalProperties,
          false,
          `${method.toUpperCase()} ${path} must reject unknown fields`
        );
      }
    }
  }
});

test("identity confirmation publishes a strict human-review contract", () => {
  const paths = createAcquisitionOpenApiPaths();
  const candidateDetail = paths[
    "/api/v1/acquisition/candidates/{id}"
  ]!.get as Record<string, any>;
  const operation = paths[
    "/api/v1/acquisition/candidates/{id}/identity-confirmation"
  ]!.post as Record<string, any>;
  const parameterNames = operation.parameters.map(
    (parameter: { name: string }) => parameter.name
  );
  assert.deepEqual(
    parameterNames,
    ["id", "Idempotency-Key", "If-Match"]
  );

  const schema = operation.requestBody.content["application/json"].schema;
  assert.equal(schema.oneOf.length, 2);
  assert.ok(schema.discriminator);
  assert.equal(
    JSON.stringify(schema).includes("partyRef"),
    false,
    "clients must not be able to forge a resolved party reference"
  );
  assert.equal(
    JSON.stringify(schema).includes("organizationId"),
    false,
    "clients must not be able to choose the canonical organization id"
  );
  assert.ok(
    schema.oneOf.every(
      (variant: Record<string, any>) =>
        variant.additionalProperties === false
        && variant.required.includes("evidenceIds")
        && variant.required.includes("rationale")
    )
  );
  const organization = schema.oneOf.find(
    (variant: Record<string, any>) =>
      variant.properties.subjectKind.enum[0] === "organization"
  );
  assert.ok(organization.required.includes("domain"));
  assert.ok(organization.required.includes("creditCode"));
  assert.equal(organization.properties.domain.minLength, undefined);
  assert.equal(organization.properties.creditCode.minLength, undefined);
  assert.equal(organization.properties.evidenceIds.uniqueItems, undefined);

  const idempotency = operation.parameters.find(
    (parameter: { name: string }) =>
      parameter.name === "Idempotency-Key"
  );
  assert.equal(idempotency.schema.minLength, 1);
  const ifMatch = operation.parameters.find(
    (parameter: { name: string }) => parameter.name === "If-Match"
  );
  assert.equal(ifMatch.schema.pattern, '^"candidate-v[1-9]\\d*"$');
  assert.equal(
    candidateDetail.responses["200"].headers.ETag.schema.pattern,
    '^"candidate-v[1-9]\\d*"$'
  );
  assert.equal(
    operation.responses["200"].headers.ETag.schema.pattern,
    '^"candidate-v[1-9]\\d*"$'
  );
  assert.ok(operation.responses["428"]);
  assert.equal(operation.responses["412"], undefined);
});

test("plan creation binds a server model snapshot behind an idempotent contract", () => {
  const paths = createAcquisitionOpenApiPaths();
  const create = paths[
    "/api/v1/acquisition/plans"
  ]!.post as Record<string, any>;
  assert.deepEqual(
    create.parameters.map(
      (parameter: { name: string }) => parameter.name
    ),
    ["Idempotency-Key"]
  );
  const schema = create.requestBody.content["application/json"].schema;
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.modelConnectionId);
  assert.deepEqual(schema.properties.targetPlatform.enum, ["douyin", "web"]);
  assert.equal(schema.required.includes("targetPlatform"), false);
  assert.equal(
    "modelSnapshotRef" in schema.properties,
    false,
    "clients must never provide a plan model snapshot"
  );
  assert.equal(
    schema.properties.icp.additionalProperties,
    false
  );
  assert.equal(
    schema.properties.operations.items.additionalProperties,
    false
  );
  assert.equal(create.parameters[0].schema.minLength, 8);
});

test("plan writes publish the bounded Douyin public comment sample policy", () => {
  const paths = createAcquisitionOpenApiPaths();
  const expectedPolicy = {
    type: "object",
    required: [
      "enabled",
      "maxVideosPerRun",
      "maxCommentsPerVideo",
      "maxPagesPerVideo"
    ],
    properties: {
      enabled: { type: "boolean" },
      maxVideosPerRun: { type: "integer", minimum: 1, maximum: 20 },
      maxCommentsPerVideo: { type: "integer", minimum: 1, maximum: 100 },
      maxPagesPerVideo: { type: "integer", minimum: 1, maximum: 5 }
    },
    additionalProperties: false
  };

  for (const [path, method] of [
    ["/api/v1/acquisition/plans", "post"],
    ["/api/v1/acquisition/plans/{id}", "patch"],
    ["/api/v1/acquisition/plans/{id}/revisions", "post"]
  ] as const) {
    const operation = paths[path]![method] as Record<string, any>;
    const schema = operation.requestBody.content["application/json"].schema;
    assert.deepEqual(
      schema.properties.douyinPublicCommentSample,
      expectedPolicy,
      `${method.toUpperCase()} ${path}`
    );
  }

  const createSchema = (paths[
    "/api/v1/acquisition/plans"
  ]!.post as Record<string, any>).requestBody
    .content["application/json"].schema;
  const validateCreate = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: false
  }).compile(createSchema);
  const providerConnection = {
    connectionId: "douyin-comments",
    providerId: "experimental_public_sample",
    kind: "content_fetch",
    status: "active",
    credentialVersion: 1
  };
  const createBody = {
    targetPlatform: "douyin",
    douyinPublicCommentSample: {
      enabled: true,
      maxVideosPerRun: 10,
      maxCommentsPerVideo: 30,
      maxPagesPerVideo: 3
    },
    name: "公开评论获客",
    objective: "发现公开需求信号",
    icp: {
      industries: ["企业服务"],
      regions: ["中国"],
      organizationCriteria: ["公开需求"],
      individualCriteria: ["公开需求"],
      exclusionRules: []
    },
    subjectChannels: { organization: false, individual: true },
    providerConnections: [providerConnection],
    operations: [{
      operationId: "comments",
      subjectChannel: "individual",
      kind: "content_fetch",
      connectionId: "douyin-comments",
      sourceRef: "https://www.douyin.com/video/123",
      allocatedBudget: {
        requests: 1,
        results: 30,
        amountMinor: 0,
        durationSeconds: 60
      }
    }],
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 1,
      maxResults: 30,
      maxAmountMinor: 0,
      maxDurationSeconds: 60
    },
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    }
  };
  assert.equal(validateCreate(createBody), true, JSON.stringify(
    validateCreate.errors
  ));
  for (const invalidProvider of [
    { ...providerConnection, providerId: "another-provider" },
    { ...providerConnection, kind: "search" },
    { ...providerConnection, status: "inactive" }
  ]) {
    assert.equal(validateCreate({
      ...createBody,
      providerConnections: [invalidProvider]
    }), false, JSON.stringify(invalidProvider));
  }
});

test("human review, conversion, and copilot writes mirror runtime schemas", () => {
  const paths = createAcquisitionOpenApiPaths();
  const review = paths[
    "/api/v1/acquisition/candidates/{id}/review"
  ]!.post as Record<string, any>;
  assert.deepEqual(
    review.parameters.map(
      (parameter: { name: string }) => parameter.name
    ),
    ["id", "Idempotency-Key"]
  );
  const reviewSchema =
    review.requestBody.content["application/json"].schema;
  assert.equal(reviewSchema.oneOf.length, 2);
  assert.ok(reviewSchema.oneOf.every(
    (variant: Record<string, any>) =>
      variant.required.join(",")
      === "action,decisionVersion,reason"
  ));
  const optionalReasonReview = reviewSchema.oneOf.find(
    (variant: Record<string, any>) =>
      variant.properties.action.enum.includes("approved")
  );
  assert.equal(
    optionalReasonReview.properties.reason.nullable,
    true
  );
  const requiredReasonReview = reviewSchema.oneOf.find(
    (variant: Record<string, any>) =>
      variant.properties.action.enum.includes("rejected")
  );
  assert.equal(requiredReasonReview.properties.reason.minLength, 1);
  assert.equal(
    requiredReasonReview.properties.reason.nullable,
    undefined
  );
  assert.equal(review.parameters[1].schema.minLength, 1);

  const convert = paths[
    "/api/v1/acquisition/candidates/{id}/convert"
  ]!.post as Record<string, any>;
  assert.deepEqual(
    convert.parameters.map(
      (parameter: { name: string }) => parameter.name
    ),
    ["id", "Idempotency-Key"]
  );
  assert.deepEqual(
    convert.requestBody.content["application/json"].schema.required,
    ["decisionVersion"]
  );

  const handoff = paths[
    "/api/v1/acquisition/candidates/{id}/private-domain-handoffs"
  ]!.post as Record<string, any>;
  assert.equal(
    handoff.responses["200"].headers["Idempotency-Replayed"]
      .schema.enum[0],
    "true"
  );
  const handoffStatus = paths[
    "/api/v1/acquisition/candidates/{id}/private-domain-handoff"
  ]!.get as Record<string, any>;
  const handoffStatusSchema = handoffStatus.responses["200"]
    .content["application/json"].schema;
  assert.equal(handoffStatusSchema.oneOf.length, 2);
  const pendingHandoff = handoffStatusSchema.oneOf.find(
    (variant: Record<string, any>) => variant.properties.inProgress
  );
  assert.deepEqual(
    pendingHandoff.properties.inProgress.properties.request
      .properties.followUp.required,
    ["title", "dueAt", "priority"]
  );
  assert.deepEqual(
    pendingHandoff.properties.inProgress.properties.request.required,
    [
      "operationCode",
      "decisionVersion",
      "mode",
      "existingCustomerId",
      "followUp"
    ]
  );
  const completedHandoff = handoffStatusSchema.oneOf.find(
    (variant: Record<string, any>) => variant.properties.handoff
  );
  assert.deepEqual(
    completedHandoff.properties.recovery.properties.request.required,
    [
      "operationCode",
      "decisionVersion",
      "mode",
      "existingCustomerId",
      "followUp"
    ]
  );
  assert.ok(
    completedHandoff.properties.recovery.properties.request
      .properties.runId
  );
  assert.ok(
    completedHandoff.properties.recovery.properties.request
      .properties.discoveredEventId
  );
  for (const recoveryRequest of [
    pendingHandoff.properties.inProgress.properties.request,
    completedHandoff.properties.recovery.properties.request
  ]) {
    assert.equal(recoveryRequest.oneOf.length, 2);
    assert.equal(
      recoveryRequest.oneOf.some((variant: Record<string, any>) =>
        variant.required?.length === 2
        && variant.required.includes("runId")
        && variant.required.includes("discoveredEventId")
      ),
      true
    );
    assert.equal(
      recoveryRequest.oneOf.some((variant: Record<string, any>) =>
        variant.not?.anyOf?.some(
          (constraint: Record<string, any>) =>
            constraint.required?.includes("runId")
        )
        && variant.not?.anyOf?.some(
          (constraint: Record<string, any>) =>
            constraint.required?.includes("discoveredEventId")
        )
      ),
      true
    );
    assert.equal(recoveryRequest.properties.runId.minLength, 1);
    assert.equal(recoveryRequest.properties.discoveredEventId.minLength, 1);
  }

  const session = paths[
    "/api/v1/acquisition/copilot/sessions"
  ]!.post as Record<string, any>;
  const sessionSchema =
    session.requestBody.content["application/json"].schema;
  assert.equal(sessionSchema.required, undefined);
  assert.deepEqual(Object.keys(sessionSchema.properties), ["connectionId"]);
  assert.equal("modelSnapshot" in sessionSchema.properties, false);
  assert.equal(session.parameters[0].schema.minLength, 1);
  assert.ok(session.responses["202"]);
  assert.equal(session.responses["200"], undefined);

  const message = paths[
    "/api/v1/acquisition/copilot/sessions/{id}/messages"
  ]!.post as Record<string, any>;
  assert.deepEqual(
    message.requestBody.content["application/json"].schema.required,
    ["message"]
  );
  assert.deepEqual(
    message.requestBody.content["application/json"].schema
      .properties.targetPlatform.enum,
    ["douyin", "web"]
  );
  assert.deepEqual(
    message.parameters.map(
      (parameter: { name: string }) => parameter.name
    ),
    ["id", "Idempotency-Key"]
  );
  assert.ok(message.responses["202"]);
  assert.equal(message.responses["200"], undefined);
});

test("plan mutation and run contracts publish exact concurrency inputs", () => {
  const paths = createAcquisitionOpenApiPaths();
  const patch = paths[
    "/api/v1/acquisition/plans/{id}"
  ]!.patch as Record<string, any>;
  assert.deepEqual(
    patch.parameters.map(
      (parameter: { name: string }) => parameter.name
    ),
    ["id", "If-Match"]
  );
  assert.equal(patch.parameters[1].schema.minLength, 1);
  assert.ok(patch.responses["412"]);
  assert.ok(patch.responses["428"]);
  const patchSchema =
    patch.requestBody.content["application/json"].schema;
  assert.equal(patchSchema.minProperties, 1);
  assert.ok(patchSchema.properties.modelSnapshotRef);

  const revision = paths[
    "/api/v1/acquisition/plans/{id}/revisions"
  ]!.post as Record<string, any>;
  assert.deepEqual(
    revision.parameters.map(
      (parameter: { name: string }) => parameter.name
    ),
    ["id", "If-Match"]
  );
  assert.equal(
    revision.requestBody.content["application/json"].schema.minProperties,
    1
  );
  assert.ok(revision.responses["201"]);
  assert.equal(revision.responses["200"], undefined);
  assert.ok(revision.responses["412"]);
  assert.ok(revision.responses["428"]);

  const approval = paths[
    "/api/v1/acquisition/plans/{id}/approval"
  ]!.post as Record<string, any>;
  assert.deepEqual(
    approval.requestBody.content["application/json"].schema.required,
    ["decision", "reason"]
  );
  assert.ok(approval.responses["412"]);
  assert.ok(approval.responses["428"]);

  const run = paths[
    "/api/v1/acquisition/plans/{id}/runs"
  ]!.post as Record<string, any>;
  assert.equal(run.requestBody.required, false);
  assert.equal(
    run.requestBody.content["application/json"].schema.required,
    undefined
  );
  assert.deepEqual(
    run.parameters.map(
      (parameter: { name: string }) => parameter.name
    ),
    ["id", "Idempotency-Key"]
  );
  assert.equal(run.parameters[1].schema.minLength, 8);
  assert.ok(run.responses["202"]);
  assert.equal(run.responses["200"], undefined);

  const create = paths[
    "/api/v1/acquisition/plans"
  ]!.post as Record<string, any>;
  assert.ok(create.responses["201"]);
  assert.equal(create.responses["200"], undefined);

  for (const action of ["pause", "resume", "cancel"]) {
    const control = paths[
      `/api/v1/acquisition/runs/{id}/${action}`
    ]!.post as Record<string, any>;
    assert.deepEqual(
      control.requestBody.content["application/json"].schema.required,
      ["reason"]
    );
    assert.deepEqual(
      control.parameters.map(
        (parameter: { name: string }) => parameter.name
      ),
      ["id", "If-Match"]
    );
    assert.equal(control.parameters[1].schema.minLength, 1);
    assert.ok(control.responses["412"]);
    assert.ok(control.responses["428"]);
  }
});

test("list operations publish the query parameters accepted by runtime", () => {
  const paths = createAcquisitionOpenApiPaths();
  const names = (path: string) => (
    (paths[path]!.get as Record<string, any>).parameters ?? []
  ).map((parameter: { name: string }) => parameter.name).sort();

  assert.deepEqual(
    names("/api/v1/acquisition/candidates"),
    ["cursor", "limit", "status", "subjectKind"]
  );
  assert.deepEqual(
    names("/api/v1/acquisition/candidates/{id}/evidence"),
    ["cursor", "id", "limit"]
  );
  assert.deepEqual(
    names("/api/v1/acquisition/candidates/{id}/reviews"),
    ["cursor", "id", "limit"]
  );
  assert.deepEqual(
    names("/api/v1/acquisition/copilot/sessions/{id}/messages"),
    ["cursor", "id", "limit"]
  );
  assert.deepEqual(
    names("/api/v1/acquisition/outcomes"),
    ["candidateId", "cursor", "limit"]
  );
  assert.deepEqual(
    names("/api/v1/acquisition/audit-events"),
    ["candidateId", "cursor", "limit"]
  );

  const outcomes = paths[
    "/api/v1/acquisition/outcomes"
  ]!.get as Record<string, any>;
  const outcomeCandidate = outcomes.parameters.find(
    (parameter: { name: string }) => parameter.name === "candidateId"
  );
  assert.equal(outcomeCandidate.required, true);
  const audit = paths[
    "/api/v1/acquisition/audit-events"
  ]!.get as Record<string, any>;
  const auditCandidate = audit.parameters.find(
    (parameter: { name: string }) => parameter.name === "candidateId"
  );
  assert.equal(auditCandidate.required, false);
});

test("BYOK credentials are write-only and never appear in response schemas", () => {
  const paths = createAcquisitionOpenApiPaths();
  const create = paths[
    "/api/v1/acquisition/provider-connections"
  ]!.post as Record<string, any>;
  const apiKey = create.requestBody.content["application/json"]
    .schema.properties.apiKey;
  assert.equal(apiKey.writeOnly, true);
  assert.equal(apiKey.type, "string");

  const serializedResponses = JSON.stringify({
    list: (paths[
      "/api/v1/acquisition/provider-connections"
    ]!.get as Record<string, any>).responses,
    patch: paths[
      "/api/v1/acquisition/provider-connections/{id}"
    ]!.patch
      ? (paths[
          "/api/v1/acquisition/provider-connections/{id}"
        ]!.patch as Record<string, any>).responses
      : null,
    test: paths[
      "/api/v1/acquisition/provider-connections/{id}/test"
    ]!.post
      ? (paths[
          "/api/v1/acquisition/provider-connections/{id}/test"
        ]!.post as Record<string, any>).responses
      : null
  });
  assert.doesNotMatch(serializedResponses, /apiKey/u);
  assert.doesNotMatch(serializedResponses, /configurationEncrypted/u);
  assert.doesNotMatch(serializedResponses, /credentialRef/u);
});

test("authorized imports use bounded raw media types rather than base64 JSON", () => {
  const paths = createAcquisitionOpenApiPaths();
  const operation = paths[
    "/api/v1/acquisition/import-operations"
  ]!.post as Record<string, any>;
  assert.deepEqual(
    Object.keys(operation.requestBody.content).sort(),
    [
      "application/octet-stream",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv"
    ]
  );
  assert.equal(
    operation.requestBody.content["text/csv"].schema.format,
    "binary"
  );
  assert.equal(operation.requestBody.required, true);
  assert.ok(
    operation.parameters.some(
      (parameter: { name?: string }) => parameter.name === "mapping"
    )
  );
  assert.equal(
    operation.parameters.some(
      (parameter: { name?: string }) =>
        parameter.name === "columnMapping"
    ),
    false
  );
});

test("provider connection response and deletion contracts match the runtime", () => {
  const paths = createAcquisitionOpenApiPaths();
  const providers = paths[
    "/api/v1/acquisition/providers"
  ]!.get as Record<string, any>;
  const providerItem = providers.responses["200"]
    .content["application/json"].schema.properties.items.items;
  assert.ok(providerItem.properties.officialDocsUrl);
  assert.ok(providerItem.properties.defaultBaseUrl);
  assert.ok(providerItem.properties.requiresKey);
  assert.ok(providerItem.properties.keyHint);

  const created = paths[
    "/api/v1/acquisition/provider-connections"
  ]!.post as Record<string, any>;
  const createSchema = created.responses["201"]
    .content["application/json"].schema;
  assert.ok(createSchema.properties.id);
  assert.equal(createSchema.properties.item, undefined);
  assert.equal(
    created.requestBody.content["application/json"]
      .schema.properties.status.default,
    "active"
  );
  assert.ok(created.responses["200"]);
  assert.equal(
    created.responses["200"].headers[
      "Idempotency-Replayed"
    ].schema.enum[0],
    "true"
  );

  const connectionList = paths[
    "/api/v1/acquisition/provider-connections"
  ]!.get as Record<string, any>;
  const connectionListSchema = connectionList.responses["200"]
    .content["application/json"].schema;
  assert.deepEqual(
    connectionListSchema.required,
    ["items", "nextCursor"]
  );
  assert.equal(
    connectionListSchema.properties.nextCursor.nullable,
    true
  );

  const deleted = paths[
    "/api/v1/acquisition/provider-connections/{id}"
  ]!.delete as Record<string, any>;
  assert.ok(deleted.responses["204"]);
  assert.equal(deleted.responses["200"], undefined);
});

test("provider and discovery inputs mirror runtime validation", () => {
  const paths = createAcquisitionOpenApiPaths();
  const provider = paths[
    "/api/v1/acquisition/provider-connections"
  ]!.post as Record<string, any>;
  assert.equal(provider.parameters[0].schema.minLength, 1);
  const providerSchema =
    provider.requestBody.content["application/json"].schema;
  assert.equal(providerSchema.properties.providerId.maxLength, 64);
  assert.equal(
    providerSchema.properties.providerId.pattern,
    "^[a-z0-9_]+$"
  );
  assert.equal(providerSchema.properties.apiKey.maxLength, 4_000);
  assert.equal(providerSchema.properties.baseUrl.maxLength, 2_000);

  const patch = paths[
    "/api/v1/acquisition/provider-connections/{id}"
  ]!.patch as Record<string, any>;
  const patchSchema =
    patch.requestBody.content["application/json"].schema;
  assert.equal(patchSchema.oneOf.length, 2);
  assert.equal(
    patchSchema.oneOf.some(
      (variant: Record<string, any>) =>
        variant.required.includes("apiKey")
        && "baseUrl" in variant.properties
    ),
    true
  );
  for (const variant of patchSchema.oneOf) {
    if (variant.properties.status) {
      assert.equal(variant.properties.status.default, undefined);
    }
  }
  assert.equal(
    patchSchema.oneOf.some(
      (variant: Record<string, any>) =>
        variant.required.length === 1
        && variant.required[0] === "status"
        && Object.keys(variant.properties).length === 1
    ),
    true
  );

  const fetch = paths[
    "/api/v1/acquisition/content-fetch-operations"
  ]!.post as Record<string, any>;
  assert.equal(fetch.parameters[0].schema.minLength, 1);
  const sourceUrl = fetch.requestBody.content["application/json"]
    .schema.properties.sourceUrl;
  assert.equal(sourceUrl.maxLength, 4_096);
  assert.equal(sourceUrl.format, "uri");
  assert.equal(sourceUrl.pattern, "^[Hh][Tt][Tt][Pp][Ss]://");
  const fetchResponseSchema = fetch.responses["202"]
    .content["application/json"].schema;
  assert.ok(fetchResponseSchema.required.includes("commentSampleSummary"));
  assert.ok(fetchResponseSchema.properties.status.enum.includes(
    "partial_success"
  ));
  assert.equal(
    fetchResponseSchema.properties.commentSampleSummary.oneOf.some(
      (variant: Record<string, any>) => variant.nullable === true
        && variant.enum?.length === 1
        && variant.enum[0] === null
    ),
    true
  );

  const importOperation = paths[
    "/api/v1/acquisition/import-operations"
  ]!.post as Record<string, any>;
  assert.equal(importOperation.parameters[0].schema.minLength, 1);
  for (const path of [
    "/api/v1/acquisition/content-fetch-operations",
    "/api/v1/acquisition/import-operations"
  ]) {
    const list = paths[path]!.get as Record<string, any>;
    assert.deepEqual(
      list.parameters.map(
        (parameter: { name: string }) => parameter.name
      ),
      ["limit"]
    );
  }
  for (const path of [
    "/api/v1/acquisition/content-fetch-operations/{id}",
    "/api/v1/acquisition/import-operations/{id}"
  ]) {
    const detail = paths[path]!.get as Record<string, any>;
    assert.equal(detail.parameters[0].schema.maxLength, 160);
  }
});

test("error responses describe both runtime envelopes used by acquisition routers", () => {
  const paths = createAcquisitionOpenApiPaths();
  const operation = paths[
    "/api/v1/acquisition/provider-connections"
  ]!.post as Record<string, any>;
  const schema = operation.responses["400"]
    .content["application/json"].schema;

  assert.equal(schema.oneOf.length, 2);
  assert.ok(
    schema.oneOf.some((variant: Record<string, any>) =>
      variant.required?.includes("code")
      && variant.required?.includes("retryable")
    )
  );
  assert.ok(
    schema.oneOf.some((variant: Record<string, any>) =>
      variant.required?.includes("error")
    )
  );
});

test("acquisition schemas are converted to valid OpenAPI 3.0 without weakening constraints", () => {
  const paths = createAcquisitionOpenApiPaths();
  assert.deepEqual(
    unsupportedOpenApi30SchemaLocations(paths),
    []
  );

  const evidenceSchema = (paths[
    "/api/v1/acquisition/evidence/{id}"
  ]!.get as Record<string, any>).responses["200"]
    .content["application/json"].schema;
  assert.equal(evidenceSchema.properties.publishedAt.type, "string");
  assert.equal(evidenceSchema.properties.publishedAt.nullable, true);
  assert.deepEqual(
    evidenceSchema.properties.provenance.oneOf[0]
      .properties.kind.enum,
    ["search_result"]
  );

  const planSchema = (paths[
    "/api/v1/acquisition/plans/{id}"
  ]!.get as Record<string, any>).responses["200"]
    .content["application/json"].schema;
  const validatePlanPayload = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: false
  }).compile(planSchema.properties.payload);
  const providerConnection = {
    connectionId: "douyin-public-comments",
    providerId: "experimental_public_sample",
    kind: "content_fetch",
    status: "active",
    credentialVersion: 1
  };
  const enabledPolicy = {
    enabled: true,
    maxVideosPerRun: 10,
    maxCommentsPerVideo: 30,
    maxPagesPerVideo: 3
  };
  const payload = {
    targetPlatform: "douyin",
    douyinPublicCommentSample: enabledPolicy,
    name: "公开评论获客",
    objective: "发现公开需求信号",
    icp: {
      industries: ["企业服务"],
      regions: ["中国"],
      organizationCriteria: ["公开需求"],
      individualCriteria: ["公开需求"],
      exclusionRules: []
    },
    subjectChannels: { organization: false, individual: true },
    providerConnections: [providerConnection],
    operations: [],
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 1,
      maxResults: 30,
      maxAmountMinor: 0,
      maxDurationSeconds: 60
    },
    modelSnapshotRef: {
      jobSnapshotId: "snapshot-openapi",
      connectionId: "model-openapi",
      credentialVersion: 1,
      provider: "openai",
      model: "gpt-5",
      capabilitySnapshotHash: "sha256:capabilities",
      promptVersion: "acquisition.v1",
      schemaVersion: "acquisition-plan.v1",
      promptHash: "sha256:prompt",
      schemaHash: "sha256:schema"
    },
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    }
  };

  assert.equal(validatePlanPayload(payload), true, JSON.stringify(
    validatePlanPayload.errors
  ));
  for (const providerConnections of [
    [],
    [{ ...providerConnection, providerId: "another-provider" }],
    [{ ...providerConnection, kind: "search" }],
    [{ ...providerConnection, status: "inactive" }],
    [
      { ...providerConnection, providerId: "another-provider" },
      { ...providerConnection, kind: "search" }
    ]
  ]) {
    assert.equal(validatePlanPayload({
      ...payload,
      providerConnections
    }), false, JSON.stringify(providerConnections));
  }
  assert.equal(validatePlanPayload({
    ...payload,
    targetPlatform: "web",
    douyinPublicCommentSample: { ...enabledPolicy, enabled: false },
    providerConnections: []
  }), true, JSON.stringify(validatePlanPayload.errors));
  const {
    douyinPublicCommentSample: _omittedPolicy,
    ...legacyPayload
  } = payload;
  assert.equal(validatePlanPayload({
    ...legacyPayload,
    targetPlatform: "web",
    providerConnections: []
  }), true, JSON.stringify(validatePlanPayload.errors));

  const battleCardSchema = (paths[
    "/api/v1/acquisition/candidates/{id}/battle-card"
  ]!.get as Record<string, any>).responses["200"]
    .content["application/json"].schema.oneOf[0];
  assert.deepEqual(
    battleCardSchema.properties.schemaVersion.enum,
    ["battle-card.v1"]
  );
  const sectionSchema = battleCardSchema.properties.sections.items;
  const validateSection = new Ajv({ strict: false }).compile(sectionSchema);
  assert.equal(validateSection({
    label: "公开事实",
    kind: "fact",
    content: "来自公开证据"
  }), true);
  assert.equal(validateSection({
    label: "推断",
    kind: "inference",
    content: "需要证据"
  }), false);
  assert.equal(validateSection({
    label: "推断",
    kind: "inference",
    content: "有证据支持",
    evidenceIds: ["evidence-1"],
    confidence: 0.8
  }), true);
});

test("the complete production document validates in its declared OpenAPI dialect", async () => {
  const document = createOpenApiDocument(express());
  assert.equal(document.openapi, "3.0.3");
  await assert.doesNotReject(() => SwaggerParser.validate(
    structuredClone(document) as never
  ));
});

test("the main Swagger document includes runtime-bridged acquisition routes", () => {
  const document = createOpenApiDocument(express()) as {
    paths: Record<string, Record<string, unknown>>;
    tags: Array<{ name: string }>;
  };
  assert.ok(document.paths["/api/v1/acquisition/providers"]);
  assert.ok(document.paths["/api/v1/acquisition/plans"]);
  assert.ok(
    document.tags.some((tag) => tag.name === "AI 获客智能体")
  );
});

test("the main Swagger document replaces generic acquisition routes", () => {
  const app = express();
  const handler = (_req: unknown, _res: unknown) => undefined;
  app.post("/api/v1/acquisition/evidence", handler);
  app.post("/api/v1/acquisition/candidates", handler);
  app.post(
    "/api/v1/acquisition/candidates/:id/qualification",
    handler
  );
  app.get(
    "/api/v1/acquisition/candidates/:id/qualification",
    handler
  );

  const document = createOpenApiDocument(app) as {
    paths: Record<string, Record<string, unknown>>;
  };
  assert.equal(
    document.paths["/api/v1/acquisition/evidence"],
    undefined
  );
  assert.equal(
    document.paths["/api/v1/acquisition/candidates"].post,
    undefined
  );
  assert.equal(
    document.paths[
      "/api/v1/acquisition/candidates/{id}/qualification"
    ].post,
    undefined
  );
  assert.ok(
    document.paths[
      "/api/v1/acquisition/candidates/{id}/qualification"
    ].get
  );
  assert.doesNotThrow(() =>
    JSON.parse(JSON.stringify(document))
  );
});
