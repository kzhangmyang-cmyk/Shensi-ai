import { readFileSync } from "node:fs";

type AcquisitionHttpMethod =
  | "get"
  | "post"
  | "patch"
  | "delete";

export type AcquisitionOpenApiPaths = Record<
  string,
  Partial<Record<AcquisitionHttpMethod, Record<string, unknown>>>
>;

const unsupportedJsonSchema202012Keywords = new Set([
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$vocabulary",
  "contains",
  "contentEncoding",
  "contentMediaType",
  "dependentRequired",
  "dependentSchemas",
  "maxContains",
  "minContains",
  "prefixItems",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties"
]);

function openApi30NullOnlySchema() {
  return {
    type: "string",
    nullable: true,
    enum: [null]
  };
}

/**
 * Converts the JSON Schema 2020-12 subset used by acquisition contracts to
 * an equivalent OpenAPI 3.0 Schema Object. Unknown 2020-12-only keywords are
 * rejected so a future contract cannot silently lose validation semantics.
 */
export function convertJsonSchema202012ToOpenApi30(value: any): any {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    throw new TypeError("Expected a JSON Schema object, received an array");
  }

  for (const keyword of unsupportedJsonSchema202012Keywords) {
    if (Object.hasOwn(value, keyword)) {
      throw new TypeError(
        `Cannot safely represent JSON Schema keyword in OpenAPI 3.0: ${keyword}`
      );
    }
  }
  if (typeof value.$ref === "string" && value.$ref.includes("/$defs/")) {
    throw new TypeError(
      `JSON Schema $defs reference must be dereferenced before OpenAPI 3.0 conversion: ${value.$ref}`
    );
  }
  for (const [exclusiveKeyword, inclusiveKeyword] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"]
  ] as const) {
    if (typeof value[exclusiveKeyword] === "number"
      && Object.hasOwn(value, inclusiveKeyword)) {
      throw new TypeError(
        `Cannot safely combine JSON Schema ${exclusiveKeyword} and ${inclusiveKeyword} in OpenAPI 3.0`
      );
    }
  }

  const converted: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if ([
      "$schema",
      "$id",
      "$defs",
      "if",
      "then",
      "else",
      "const",
      "type"
    ].includes(key)) {
      continue;
    }
    if (key === "properties" || key === "patternProperties") {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new TypeError(`JSON Schema ${key} must be an object`);
      }
      converted[key] = Object.fromEntries(
        Object.entries(item).map(([name, propertySchema]) => [
          name,
          convertJsonSchema202012ToOpenApi30(propertySchema)
        ])
      );
    } else if (["allOf", "anyOf", "oneOf"].includes(key)) {
      if (!Array.isArray(item)) {
        throw new TypeError(`JSON Schema ${key} must be an array`);
      }
      converted[key] = item.map(convertJsonSchema202012ToOpenApi30);
    } else if (key === "items") {
      if (Array.isArray(item)) {
        throw new TypeError(
          "JSON Schema tuple items cannot be represented safely in OpenAPI 3.0"
        );
      }
      converted[key] = convertJsonSchema202012ToOpenApi30(item);
    } else if (key === "additionalProperties" || key === "not") {
      converted[key] = typeof item === "boolean"
        ? item
        : convertJsonSchema202012ToOpenApi30(item);
    } else if (key === "exclusiveMinimum" && typeof item === "number") {
      converted.minimum = item;
      converted.exclusiveMinimum = true;
    } else if (key === "exclusiveMaximum" && typeof item === "number") {
      converted.maximum = item;
      converted.exclusiveMaximum = true;
    } else {
      converted[key] = structuredClone(item);
    }
  }

  if (Object.hasOwn(value, "type")) {
    const sourceTypes = Array.isArray(value.type)
      ? [...new Set(value.type)]
      : [value.type];
    if (!sourceTypes.every((type) => typeof type === "string")) {
      throw new TypeError("JSON Schema type must be a string or string array");
    }
    const allowsNull = sourceTypes.includes("null");
    const nonNullTypes = sourceTypes.filter((type) => type !== "null");
    if (nonNullTypes.length === 0) {
      Object.assign(converted, openApi30NullOnlySchema());
    } else if (nonNullTypes.length === 1) {
      converted.type = nonNullTypes[0];
      if (allowsNull) converted.nullable = true;
    } else {
      converted.oneOf = [
        ...(converted.oneOf ?? []),
        ...nonNullTypes.map((type, index) => ({
          type,
          ...(allowsNull && index === 0 ? { nullable: true } : {})
        }))
      ];
    }
  }

  if (Object.hasOwn(value, "const")) {
    const constant = structuredClone(value.const);
    if (Array.isArray(converted.enum)) {
      converted.enum = converted.enum.filter((item: unknown) =>
        Object.is(item, constant));
      if (converted.enum.length === 0) {
        converted.not = {};
      }
    } else {
      converted.enum = [constant];
    }
    if (constant === null && converted.type === undefined) {
      Object.assign(converted, openApi30NullOnlySchema(), {
        ...converted,
        enum: [null]
      });
    }
  }

  const hasIf = Object.hasOwn(value, "if");
  const hasThen = Object.hasOwn(value, "then");
  const hasElse = Object.hasOwn(value, "else");
  if ((hasThen || hasElse) && !hasIf) {
    throw new TypeError(
      "JSON Schema then/else requires if before OpenAPI 3.0 conversion"
    );
  }
  if (hasIf && (hasThen || hasElse)) {
    const condition = convertJsonSchema202012ToOpenApi30(value.if);
    const thenSchema = hasThen
      ? convertJsonSchema202012ToOpenApi30(value.then)
      : {};
    const elseSchema = hasElse
      ? convertJsonSchema202012ToOpenApi30(value.else)
      : {};
    const implication = hasElse
      ? {
          oneOf: [
            { allOf: [condition, thenSchema] },
            { allOf: [{ not: condition }, elseSchema] }
          ]
        }
      : {
          anyOf: [
            { not: condition },
            { allOf: [condition, thenSchema] }
          ]
        };
    converted.allOf = [
      ...(Array.isArray(converted.allOf) ? converted.allOf : []),
      implication
    ];
  }

  return converted;
}

function convertEmbeddedSchemasToOpenApi30(value: any): any {
  if (Array.isArray(value)) {
    return value.map(convertEmbeddedSchemasToOpenApi30);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "schema"
      ? convertJsonSchema202012ToOpenApi30(item)
      : convertEmbeddedSchemasToOpenApi30(item)
  ]));
}

const readSecurity = [{ bearerAuth: [] }, { cookieAuth: [] }];
const writeSecurity = [
  { bearerAuth: [] },
  { cookieAuth: [], csrfToken: [] }
];

const errorSchema = {
  oneOf: [
    {
      type: "object",
      required: [
        "code",
        "message",
        "details",
        "requestId",
        "retryable"
      ],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: { nullable: true },
        requestId: { type: "string" },
        retryable: { type: "boolean" }
      },
      additionalProperties: false
    },
    {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            details: { nullable: true },
            requestId: { type: "string" }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    }
  ]
};

const resourceSchema = {
  type: "object",
  additionalProperties: true
};

function dereferenceContractSchema(
  value: any,
  root: Record<string, any>,
  baseUrl: URL
): any {
  if (Array.isArray(value)) {
    return value.map((item) =>
      dereferenceContractSchema(item, root, baseUrl));
  }
  if (!value || typeof value !== "object") return value;
  if (typeof value.$ref === "string") {
    const reference = value.$ref as string;
    if (reference.startsWith("#/")) {
      const target = reference.slice(2).split("/").reduce(
        (current: any, part) => current[
          part.replace(/~1/gu, "/").replace(/~0/gu, "~")
        ],
        root
      );
      return dereferenceContractSchema(target, root, baseUrl);
    }
    const targetUrl = new URL(reference, baseUrl);
    const pointer = targetUrl.hash;
    targetUrl.hash = "";
    const targetRoot = JSON.parse(
      readFileSync(targetUrl, "utf8")
    ) as Record<string, any>;
    const target = pointer.startsWith("#/")
      ? pointer.slice(2).split("/").reduce(
          (current: any, part) => current[
            part.replace(/~1/gu, "/").replace(/~0/gu, "~")
          ],
          targetRoot
        )
      : targetRoot;
    if (!target || typeof target !== "object") {
      throw new Error(`Missing contract schema reference: ${reference}`);
    }
    return dereferenceContractSchema(target, targetRoot, targetUrl);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    dereferenceContractSchema(item, root, baseUrl)
  ]));
}

function loadContractSchema(name: string): Record<string, any> {
  const filename = name === "battle-card.v2"
    ? "battle-card.v2.schema.json"
    : `${name}.v1.schema.json`;
  const schemaUrl = new URL(
    `../../contracts/json-schema/${filename}`,
    import.meta.url
  );
  const root = JSON.parse(
    readFileSync(schemaUrl, "utf8")
  ) as Record<string, any>;
  return dereferenceContractSchema(root, root, schemaUrl);
}

export function loadContractSchemaDefinition(
  name: string,
  definition: string
): Record<string, any> {
  const schemaUrl = new URL(
    `../../contracts/json-schema/${name}.v1.schema.json`,
    import.meta.url
  );
  const root = JSON.parse(
    readFileSync(schemaUrl, "utf8")
  ) as Record<string, any>;
  const target = root.$defs?.[definition] as unknown;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error(`Missing contract schema definition: ${name}#${definition}`);
  }
  return dereferenceContractSchema(target, root, schemaUrl);
}

/**
 * OpenAPI 3.0 cannot represent Draft 2020-12 `contains` cardinality. The
 * visual-reader service enforces the five-crop limit before decoding or any
 * repository call, so its runtime documentation publishes the remaining
 * closed DTO shape. Keep this exception exact and fail closed if the source
 * contract changes instead of silently dropping a new constraint.
 */
export function projectVisualReaderBatchRequestToOpenApi30(
  value: Record<string, any>
): Record<string, any> {
  const observations = value.properties?.observations;
  if (!observations || !Object.hasOwn(observations, "contains")) return value;
  const expectedContains = {
    type: "object",
    required: ["redactedCrop"],
    properties: { redactedCrop: { type: "object" } }
  };
  if (value.type !== "object"
    || value.additionalProperties !== false
    || observations.type !== "array"
    || observations.minItems !== 1
    || observations.maxItems !== 20
    || observations.minContains !== 0
    || observations.maxContains !== 5
    || JSON.stringify(observations.contains) !== JSON.stringify(expectedContains)) {
    throw new TypeError(
      "Unexpected visual reader crop cardinality contract for OpenAPI 3.0"
    );
  }
  const projected = structuredClone(value);
  delete projected.properties.observations.contains;
  delete projected.properties.observations.minContains;
  delete projected.properties.observations.maxContains;
  return projected;
}

const asyncOperationResponseSchema = loadContractSchema("async-operation");
const discoveryEvidenceResponseSchema = loadContractSchema(
  "discovery-evidence"
);
const organizationCandidateResponseSchema = loadContractSchema(
  "organization-candidate"
);
const individualCandidateResponseSchema = loadContractSchema(
  "individual-demand-signal"
);
const candidateResponseSchema = {
  oneOf: [
    organizationCandidateResponseSchema,
    individualCandidateResponseSchema
  ]
};
const qualificationDecisionResponseSchema = loadContractSchema(
  "qualification-decision"
);
const financialValueDecisionResponseSchema = loadContractSchema(
  "financial-value-decision"
);
const battleCardResponseSchema = {
  oneOf: [
    loadContractSchema("battle-card"),
    loadContractSchema("battle-card.v2")
  ]
};
const reviewEventResponseSchema = loadContractSchema("review-event");
const outcomeFeedbackResponseSchema = loadContractSchema("outcome-feedback");
const partyRefResponseSchema = loadContractSchema("party-ref");
const copilotSessionResponseSchema = loadContractSchema("copilot-session");
const copilotMessageResponseSchema = loadContractSchema("copilot-message");
const copilotTaskResponseSchema = loadContractSchema("copilot-task");
const candidateIntelligenceOperationResponseSchema = loadContractSchema(
  "candidate-intelligence-operation"
);
const douyinIdentityResolutionOperationResponseSchema = loadContractSchema(
  "douyin-identity-resolution-operation"
);
const visualReaderSessionResponseSchema = loadContractSchema(
  "acquisition-visual-reader-session"
);
const visualReaderCreateRequestSchema = loadContractSchemaDefinition(
  "acquisition-visual-reader-session",
  "visualReaderCreateRequest"
);
const visualReaderBatchRequestSchema =
  projectVisualReaderBatchRequestToOpenApi30(loadContractSchemaDefinition(
    "acquisition-visual-reader-session",
    "visualReaderObservationBatchRequest"
  ));
const visualReaderBatchResponseSchema = loadContractSchemaDefinition(
  "acquisition-visual-reader-session",
  "visualReaderObservationBatchResponse"
);
const visualReaderCompleteRequestSchema = loadContractSchemaDefinition(
  "acquisition-visual-reader-session",
  "visualReaderCompleteRequest"
);
const visualReaderAbortRequestSchema = loadContractSchemaDefinition(
  "acquisition-visual-reader-session",
  "visualReaderAbortRequest"
);

function typedPagedResponseSchema(itemSchema: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items", "nextCursor"],
    properties: {
      items: { type: "array", items: itemSchema },
      nextCursor: { type: ["string", "null"] }
    }
  };
}

const candidatePagedResponseSchema = typedPagedResponseSchema(
  candidateResponseSchema
);
const evidencePagedResponseSchema = typedPagedResponseSchema(
  discoveryEvidenceResponseSchema
);
const reviewPagedResponseSchema = typedPagedResponseSchema(
  reviewEventResponseSchema
);
const outcomePagedResponseSchema = typedPagedResponseSchema(
  outcomeFeedbackResponseSchema
);
const copilotMessagePagedResponseSchema = typedPagedResponseSchema(
  copilotMessageResponseSchema
);

const identityResolutionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "basis",
    "resolverVersion",
    "evidenceIds",
    "resolvedAt",
    "resolvedBy"
  ],
  properties: {
    status: { const: "resolved" },
    basis: {
      enum: [
        "organization_domain",
        "organization_credit_code",
        "provider_public_actor"
      ]
    },
    resolverVersion: { type: "string", minLength: 1 },
    evidenceIds: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    resolvedAt: { type: "string", format: "date-time" },
    resolvedBy: { type: "string", minLength: 1 }
  }
};

const identityConfirmationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidate", "resolution"],
  properties: {
    candidate: candidateResponseSchema,
    resolution: identityResolutionResponseSchema
  }
};

const researchAttemptResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "candidateId",
    "requestReason",
    "budgetVersion",
    "status",
    "newEvidenceIds",
    "terminationReason",
    "createdAt",
    "startedAt",
    "completedAt"
  ],
  properties: {
    id: { type: "string" },
    candidateId: { type: "string" },
    requestReason: { type: "string" },
    budgetVersion: { type: "string" },
    status: {
      enum: [
        "pending",
        "running",
        "completed",
        "no_new_evidence",
        "access_restricted",
        "failed"
      ]
    },
    newEvidenceIds: {
      type: "array",
      items: { type: "string" }
    },
    terminationReason: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    startedAt: { type: ["string", "null"], format: "date-time" },
    completedAt: { type: ["string", "null"], format: "date-time" }
  }
};

const reviewResultResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidate", "review", "research"],
  properties: {
    candidate: candidateResponseSchema,
    review: reviewEventResponseSchema,
    research: {
      oneOf: [researchAttemptResponseSchema, { type: "null" }]
    }
  }
};

const leadConversionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "candidateId",
    "decisionVersion",
    "partyRef",
    "leadId",
    "reviewerId",
    "evidenceSnapshotHash",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    candidateId: { type: "string" },
    decisionVersion: { type: "string" },
    partyRef: partyRefResponseSchema,
    leadId: { type: "string" },
    reviewerId: { type: "string" },
    evidenceSnapshotHash: { type: "string" },
    createdAt: { type: "string", format: "date-time" }
  }
};

const handoffIntelligenceResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "qualificationGrade",
    "qualificationScore",
    "financialGrade",
    "currency",
    "expectedRevenueMinor",
    "expectedGrossProfitMinor",
    "expectedContributionMinor"
  ],
  properties: {
    qualificationGrade: {
      type: "string",
      enum: ["S", "A", "B", "C", "D"]
    },
    qualificationScore: { type: "number" },
    financialGrade: {
      type: "string",
      enum: ["S", "A", "B", "C", "D"]
    },
    currency: { type: "string", minLength: 3, maxLength: 3 },
    expectedRevenueMinor: { type: "integer", minimum: 0 },
    expectedGrossProfitMinor: { type: "integer" },
    expectedContributionMinor: { type: "integer" }
  }
};

const privateDomainHandoffRecoveryRequestSchema = {
  type: "object",
  additionalProperties: false,
  oneOf: [
    { required: ["runId", "discoveredEventId"] },
    {
      not: {
        anyOf: [
          { required: ["runId"] },
          { required: ["discoveredEventId"] }
        ]
      }
    }
  ],
  required: [
    "operationCode",
    "decisionVersion",
    "mode",
    "existingCustomerId",
    "followUp"
  ],
  properties: {
    operationCode: {
      type: "string",
      enum: ["handoff_acquisition_candidate_v1"]
    },
    runId: { type: "string", minLength: 1, maxLength: 255 },
    discoveredEventId: { type: "string", minLength: 1, maxLength: 255 },
    decisionVersion: { type: "string", minLength: 1, maxLength: 100 },
    mode: { type: "string", enum: ["create_new", "link_existing"] },
    existingCustomerId: { type: "string", maxLength: 255 },
    followUp: {
      type: "object",
      additionalProperties: false,
      required: ["title", "dueAt", "priority"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 500 },
        dueAt: { type: "string", format: "date-time" },
        priority: {
          type: "string",
          enum: ["high", "medium", "normal"]
        }
      }
    }
  }
};

const privateDomainHandoffResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "replayed",
    "handoff",
    "lead",
    "customer",
    "todo",
    "intelligence"
  ],
  properties: {
    replayed: { type: "boolean" },
    handoff: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "candidateId",
        "leadId",
        "customerId",
        "todoId",
        "runId",
        "discoveredEventId",
        "decisionVersion",
        "createdAt"
      ],
      properties: {
        id: { type: "string" },
        candidateId: { type: "string" },
        leadId: { type: "string" },
        customerId: { type: "string" },
        todoId: { type: "string" },
        runId: { type: "string", nullable: true },
        discoveredEventId: { type: "string", nullable: true },
        decisionVersion: { type: "string" },
        createdAt: { type: "string", format: "date-time" }
      }
    },
    lead: { type: "object", additionalProperties: true },
    customer: { type: "object", additionalProperties: true },
    todo: { type: "object", additionalProperties: true },
    intelligence: handoffIntelligenceResponseSchema,
    recovery: {
      type: "object",
      additionalProperties: false,
      required: ["request"],
      properties: {
        request: privateDomainHandoffRecoveryRequestSchema
      }
    }
  }
};

const candidateStatuses = [
  "discovered",
  "unresolvable",
  "normalized",
  "qualified",
  "pending_review",
  "approved",
  "rejected",
  "do_not_contact",
  "needs_research",
  "converted_to_lead"
];

const auditEventResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "candidateId",
    "actorId",
    "eventType",
    "fromStatus",
    "toStatus",
    "resourceId",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    candidateId: { type: ["string", "null"] },
    actorId: { type: "string" },
    eventType: { type: "string" },
    fromStatus: { enum: [...candidateStatuses, null] },
    toStatus: { enum: [...candidateStatuses, null] },
    resourceId: { type: "string" },
    createdAt: { type: "string", format: "date-time" }
  }
};
const auditPagedResponseSchema = typedPagedResponseSchema(
  auditEventResponseSchema
);
const performanceFactSchema = {
  type: "object",
  required: ["metricId", "text", "evidenceRefs"],
  properties: {
    metricId: { type: "string", minLength: 1 },
    text: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } }
  },
  additionalProperties: false
};
const acquisitionPerformanceResponseSchema = {
  type: "object",
  required: [
    "counts",
    "rates",
    "valuesByCurrency",
    "cost",
    "roi",
    "dataQuality",
    "briefingFacts"
  ],
  properties: {
    counts: {
      type: "object",
      required: ["discovered", "highIntent", "approved", "converted", "contacted", "quoted", "won", "lost"],
      properties: Object.fromEntries([
        "discovered", "highIntent", "approved", "converted",
        "contacted", "quoted", "won", "lost"
      ].map((name) => [name, { type: "integer", minimum: 0 }])),
      additionalProperties: false
    },
    rates: {
      type: "object",
      required: ["highIntentRate", "approvalRate", "crmConversionRate", "contactRate", "quoteRate", "winRate"],
      properties: Object.fromEntries([
        "highIntentRate", "approvalRate", "crmConversionRate",
        "contactRate", "quoteRate", "winRate"
      ].map((name) => [name, {
        type: "number",
        minimum: 0,
        nullable: true
      }])),
      additionalProperties: false
    },
    valuesByCurrency: {
      type: "array",
      items: {
        type: "object",
        required: ["currency", "estimatedPipelineMinor", "quotedMinor", "wonContractMinor"],
        properties: {
          currency: { type: "string", pattern: "^[A-Z]{3}$" },
          estimatedPipelineMinor: { type: "integer", minimum: 0 },
          quotedMinor: { type: "integer", minimum: 0 },
          wonContractMinor: { type: "integer", minimum: 0 }
        },
        additionalProperties: false
      }
    },
    cost: {
      type: "object",
      required: ["status", "executionCostMinor", "currency", "coverage"],
      properties: {
        status: { type: "string", enum: ["available", "not_aggregatable"] },
        executionCostMinor: { type: "integer", minimum: 0, nullable: true },
        currency: { type: "string", pattern: "^[A-Z]{3}$", nullable: true },
        coverage: { type: "string", enum: ["recorded_api_execution_only"] }
      },
      additionalProperties: false
    },
    roi: {
      type: "object",
      required: ["status", "reason"],
      properties: {
        status: { type: "string", enum: ["not_computable"] },
        reason: { type: "string", enum: ["channel_cost_or_verified_margin_unavailable"] }
      },
      additionalProperties: false
    },
    dataQuality: {
      type: "object",
      required: ["missingAttribution", "missingFinancial", "truncated", "lastReconciledAt"],
      properties: {
        missingAttribution: { type: "integer", minimum: 0 },
        missingFinancial: { type: "integer", minimum: 0 },
        truncated: { type: "boolean" },
        lastReconciledAt: { type: "string", format: "date-time", nullable: true }
      },
      additionalProperties: false
    },
    briefingFacts: {
      type: "object",
      required: ["headlines", "risks", "actions", "metricIds"],
      properties: {
        headlines: { type: "array", items: performanceFactSchema },
        risks: { type: "array", items: performanceFactSchema },
        actions: { type: "array", items: performanceFactSchema },
        metricIds: { type: "array", items: { type: "string" } }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
};

const acquisitionPlanResponseSchema = loadContractSchema(
  "acquisition-plan"
);

const acquisitionRunResponseSchema = loadContractSchema(
  "acquisition-run"
);

const pagedResultResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: { type: "object" } },
    nextCursor: { type: ["string", "null"] }
  }
};

const providerConnectionSchema = loadContractSchema(
  "provider-connection"
);

const contentFetchOperationResponseSchema = loadContractSchema(
  "content-fetch-operation"
);

const importOperationResponseSchema = loadContractSchema(
  "import-operation"
);

const providerConnectionHealthSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "ok",
    "message",
    "errorCode",
    "retryable",
    "retryAfterAt",
    "usage"
  ],
  properties: {
    ok: { type: "boolean" },
    message: { type: "string", minLength: 1, maxLength: 2_000 },
    errorCode: {
      type: ["string", "null"],
      maxLength: 120
    },
    retryable: { type: "boolean" },
    retryAfterAt: {
      type: ["string", "null"],
      format: "date-time"
    },
    usage: { type: "string", maxLength: 2_000 }
  }
};

const acquisitionProviderSchema = {
  type: "object",
  required: ["id", "kind", "displayName", "capabilities"],
  properties: {
    id: { type: "string" },
    kind: {
      type: "string",
      enum: ["search", "content_fetch", "import"]
    },
    displayName: { type: "string" },
    officialDocsUrl: {
      type: "string",
      format: "uri"
    },
    defaultBaseUrl: {
      type: "string",
      format: "uri"
    },
    requiresKey: { type: "boolean" },
    keyHint: { type: "string" },
    costNote: { type: "string" },
    capabilities: {
      type: "array",
      items: { type: "string" }
    }
  },
  additionalProperties: false
};

function response(
  description: string,
  schema: Record<string, unknown> = resourceSchema
) {
  return {
    description,
    content: {
      "application/json": { schema }
    }
  };
}

function standardResponses(
  successStatus: number = 200,
  successDescription: string = "操作成功",
  successSchema: Record<string, unknown> = resourceSchema
) {
  return {
    [String(successStatus)]: response(
      successDescription,
      successSchema
    ),
    "400": response("请求参数无效", errorSchema),
    "401": response("需要登录", errorSchema),
    "404": response("资源不存在或不在当前租户范围", errorSchema),
    "409": response("版本、状态或幂等键冲突", errorSchema),
    "500": response("服务端无法完成请求", errorSchema)
  };
}

function idParameter(maxLength = 255, name = "id") {
  return {
    name,
    in: "path",
    required: true,
    schema: { type: "string", minLength: 1, maxLength }
  };
}

function idempotencyParameter(minLength: 1 | 8 = 8) {
  return {
    name: "Idempotency-Key",
    in: "header",
    required: true,
    description: "租户作用域内的写入幂等键；原文不会持久化。",
    schema: {
      type: "string",
      minLength,
      maxLength: 200
    }
  };
}

function ifMatchParameter(
  schema: Record<string, unknown> = {
    type: "string",
    minLength: 1
  }
) {
  return {
    name: "If-Match",
    in: "header",
    required: true,
    schema
  };
}

function jsonBody(
  schema: Record<string, unknown>,
  required = true
) {
  return {
    required,
    content: {
      "application/json": { schema }
    }
  };
}

function paginationParameters() {
  return [
    {
      name: "cursor",
      in: "query",
      required: false,
      schema: {
        type: "string",
        minLength: 1,
        maxLength: 8_192
      }
    },
    {
      name: "limit",
      in: "query",
      required: false,
      schema: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 50
      }
    }
  ];
}

function boundedLimitParameter() {
  return {
    name: "limit",
    in: "query",
    required: false,
    schema: {
      type: "integer",
      minimum: 1,
      maximum: 100
    }
  };
}

function operation(
  method: AcquisitionHttpMethod,
  summary: string,
  options: {
    parameters?: Array<Record<string, unknown>>;
    requestBody?: Record<string, unknown>;
    responses?: Record<string, unknown>;
    description?: string;
  } = {}
) {
  return {
    tags: ["AI 获客智能体"],
    summary,
    ...(options.description
      ? { description: options.description }
      : {}),
    security: method === "get" ? readSecurity : writeSecurity,
    ...(options.parameters
      ? { parameters: options.parameters }
      : {}),
    ...(options.requestBody
      ? { requestBody: options.requestBody }
      : {}),
    responses: options.responses ?? standardResponses()
  };
}

function add(
  paths: AcquisitionOpenApiPaths,
  path: string,
  method: AcquisitionHttpMethod,
  value: Record<string, unknown>
) {
  paths[path] ||= {};
  paths[path]![method] = value;
}

const acquisitionOperationIds: Record<string, string> = {
  "get /api/v1/acquisition/providers": "listAcquisitionProviders",
  "get /api/v1/acquisition/provider-connections":
    "listAcquisitionProviderConnections",
  "post /api/v1/acquisition/provider-connections":
    "createAcquisitionProviderConnection",
  "get /api/v1/acquisition/provider-connections/{id}":
    "getAcquisitionProviderConnection",
  "patch /api/v1/acquisition/provider-connections/{id}":
    "updateAcquisitionProviderConnection",
  "delete /api/v1/acquisition/provider-connections/{id}":
    "deleteAcquisitionProviderConnection",
  "post /api/v1/acquisition/provider-connections/{id}/test":
    "testAcquisitionProviderConnection",
  "get /api/v1/acquisition/content-fetch-operations":
    "listAcquisitionContentFetchOperations",
  "post /api/v1/acquisition/content-fetch-operations":
    "createAcquisitionContentFetchOperation",
  "get /api/v1/acquisition/content-fetch-operations/{id}":
    "getAcquisitionContentFetchOperation",
  "get /api/v1/acquisition/import-operations":
    "listAcquisitionImportOperations",
  "post /api/v1/acquisition/import-operations":
    "createAcquisitionImportOperation",
  "get /api/v1/acquisition/import-operations/{id}":
    "getAcquisitionImportOperation",
  "get /api/v1/acquisition/evidence/{id}": "getAcquisitionEvidence",
  "get /api/v1/acquisition/candidates": "listAcquisitionCandidates",
  "get /api/v1/acquisition/candidates/{id}": "getAcquisitionCandidate",
  "get /api/v1/acquisition/candidates/{id}/evidence":
    "listAcquisitionCandidateEvidence",
  "post /api/v1/acquisition/candidates/{id}/identity-confirmation":
    "confirmAcquisitionCandidateIdentity",
  "post /api/v1/acquisition/candidates/{candidateId}/intelligence-operations":
    "createAcquisitionCandidateIntelligenceOperation",
  "get /api/v1/acquisition/candidate-intelligence-operations/{operationId}":
    "getAcquisitionCandidateIntelligenceOperation",
  "get /api/v1/acquisition/candidates/{candidateId}/intelligence-operation":
    "getLatestAcquisitionCandidateIntelligenceOperation",
  "post /api/v1/acquisition/candidate-intelligence-operations/{operationId}/retry":
    "retryAcquisitionCandidateIntelligenceOperation",
  "get /api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operation":
    "getLatestAcquisitionDouyinIdentityResolutionOperation",
  "post /api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operations":
    "createAcquisitionDouyinIdentityResolutionOperation",
  "get /api/v1/acquisition/candidates/{id}/qualification":
    "getAcquisitionCandidateQualification",
  "get /api/v1/acquisition/candidates/{id}/financial-value":
    "getAcquisitionCandidateFinancialValue",
  "get /api/v1/acquisition/candidates/{id}/battle-card":
    "getAcquisitionCandidateBattleCard",
  "get /api/v1/acquisition/candidates/{id}/reviews":
    "listAcquisitionCandidateReviews",
  "post /api/v1/acquisition/candidates/{id}/review":
    "reviewAcquisitionCandidate",
  "post /api/v1/acquisition/candidates/{id}/convert":
    "convertAcquisitionCandidate",
  "post /api/v1/acquisition/candidates/{id}/private-domain-handoffs":
    "handoffAcquisitionCandidateToPrivateDomain",
  "get /api/v1/acquisition/candidates/{id}/private-domain-handoff":
    "getAcquisitionCandidatePrivateDomainHandoff",
  "get /api/v1/acquisition/outcomes": "listAcquisitionOutcomes",
  "get /api/v1/acquisition/performance": "getAcquisitionPerformance",
  "get /api/v1/acquisition/audit-events": "listAcquisitionAuditEvents",
  "post /api/v1/acquisition/copilot/sessions":
    "createAcquisitionCopilotSession",
  "get /api/v1/acquisition/copilot/sessions/{id}":
    "getAcquisitionCopilotSession",
  "get /api/v1/acquisition/copilot/sessions/{id}/messages":
    "listAcquisitionCopilotMessages",
  "post /api/v1/acquisition/copilot/sessions/{id}/messages":
    "sendAcquisitionCopilotMessage",
  "get /api/v1/acquisition/copilot/tasks/{id}":
    "getAcquisitionCopilotTask",
  "post /api/v1/acquisition/plans": "createAcquisitionPlan",
  "get /api/v1/acquisition/plans/{id}": "getAcquisitionPlan",
  "patch /api/v1/acquisition/plans/{id}": "updateAcquisitionPlan",
  "post /api/v1/acquisition/plans/{id}/revisions":
    "createAcquisitionPlanRevision",
  "post /api/v1/acquisition/plans/{id}/approval":
    "approveAcquisitionPlan",
  "post /api/v1/acquisition/plans/{id}/runs": "createAcquisitionRun",
  "get /api/v1/acquisition/runs/{id}": "getAcquisitionRun",
  "get /api/v1/acquisition/runs/{id}/shards":
    "listAcquisitionRunShards",
  "get /api/v1/acquisition/runs/{id}/presentation":
    "getAcquisitionRunPresentation",
  "post /api/v1/acquisition/runs/{id}/pause": "pauseAcquisitionRun",
  "post /api/v1/acquisition/runs/{id}/resume": "resumeAcquisitionRun",
  "post /api/v1/acquisition/runs/{id}/cancel": "cancelAcquisitionRun",
  "post /api/v1/acquisition/visual-reader-sessions":
    "createAcquisitionVisualReaderSession",
  "get /api/v1/acquisition/visual-reader-sessions/{sessionId}":
    "getAcquisitionVisualReaderSession",
  "post /api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch":
    "appendAcquisitionVisualReaderObservationBatch",
  "post /api/v1/acquisition/visual-reader-sessions/{sessionId}:complete":
    "completeAcquisitionVisualReaderSession",
  "post /api/v1/acquisition/visual-reader-sessions/{sessionId}:abort":
    "abortAcquisitionVisualReaderSession",
  "get /api/v1/acquisition/visual-reader-artifacts/{artifactId}":
    "getAcquisitionVisualReaderArtifact"
};

function addAcquisitionOperationIds(paths: AcquisitionOpenApiPaths) {
  const unused = new Set(Object.keys(acquisitionOperationIds));
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of ["get", "post", "patch", "delete"] as const) {
      const operation = pathItem[method];
      if (!operation) continue;
      const key = `${method} ${path}`;
      const operationId = acquisitionOperationIds[key];
      if (!operationId) {
        throw new Error(`Missing acquisition operationId: ${key}`);
      }
      operation.operationId = operationId;
      unused.delete(key);
    }
  }
  if (unused.size > 0) {
    throw new Error(
      `Unused acquisition operationId mappings: ${[...unused].join(", ")}`
    );
  }
}

const providerConnectionStatusSchema = {
  type: "string",
  enum: ["active", "disabled"]
};

const providerConnectionWriteSchema = {
  type: "object",
  required: ["providerId", "apiKey"],
  properties: {
    providerId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z0-9_]+$"
    },
    apiKey: {
      type: "string",
      minLength: 1,
      maxLength: 4_000,
      writeOnly: true,
      description: "客户自己的官方 API Key，仅加密保存且永不回显。"
    },
    baseUrl: {
      type: "string",
      format: "uri",
      maxLength: 2_000
    },
    status: {
      ...providerConnectionStatusSchema,
      default: "active"
    }
  },
  additionalProperties: false
};

function addProviderPaths(paths: AcquisitionOpenApiPaths) {
  add(paths, "/api/v1/acquisition/providers", "get", operation(
    "get",
    "列出中国及国际官方搜索服务商和系统数据源",
    {
      responses: standardResponses(200, "数据源目录", {
        type: "object",
        required: ["items", "nextCursor"],
        properties: {
          items: {
            type: "array",
            items: acquisitionProviderSchema
          },
          nextCursor: {
            type: "string",
            nullable: true
          }
        },
        additionalProperties: false
      })
    }
  ));
  add(
    paths,
    "/api/v1/acquisition/provider-connections",
    "get",
    operation("get", "列出当前账号的 BYOK 搜索连接", {
      responses: standardResponses(200, "连接列表", {
        type: "object",
        required: ["items", "nextCursor"],
        properties: {
          items: {
            type: "array",
            items: providerConnectionSchema
          },
          nextCursor: {
            type: "string",
            nullable: true
          }
        },
        additionalProperties: false
      })
    })
  );
  add(
    paths,
    "/api/v1/acquisition/provider-connections",
    "post",
    operation("post", "创建官方搜索 API 直连", {
      parameters: [idempotencyParameter(1)],
      requestBody: jsonBody(providerConnectionWriteSchema),
      responses: {
        ...standardResponses(
          201,
          "连接已创建",
          providerConnectionSchema
        ),
        "200": {
          ...response(
            "幂等重放已有连接",
            providerConnectionSchema
          ),
          headers: {
            "Idempotency-Replayed": {
              description: "值为 true 表示返回的是同一幂等请求的结果。",
              schema: {
                type: "string",
                enum: ["true"]
              }
            }
          }
        }
      }
    })
  );
  add(
    paths,
    "/api/v1/acquisition/provider-connections/{id}",
    "get",
    operation("get", "读取安全投影后的搜索连接", {
      parameters: [idParameter()],
      responses: standardResponses(
        200,
        "连接详情",
        providerConnectionSchema
      )
    })
  );
  const patchSchema = {
    oneOf: [
      {
        type: "object",
        required: ["apiKey"],
        properties: {
          apiKey: providerConnectionWriteSchema.properties.apiKey,
          baseUrl: providerConnectionWriteSchema.properties.baseUrl,
          status: providerConnectionStatusSchema
        },
        additionalProperties: false
      },
      {
        type: "object",
        required: ["status"],
        properties: {
          status: providerConnectionStatusSchema
        },
        additionalProperties: false
      }
    ]
  };
  add(
    paths,
    "/api/v1/acquisition/provider-connections/{id}",
    "patch",
    operation("patch", "轮换密钥、官方端点或连接状态", {
      parameters: [idParameter()],
      requestBody: jsonBody(patchSchema),
      responses: standardResponses(
        200,
        "连接已更新",
        providerConnectionSchema
      )
    })
  );
  add(
    paths,
    "/api/v1/acquisition/provider-connections/{id}",
    "delete",
    operation("delete", "删除当前账号的搜索连接", {
      parameters: [idParameter()],
      responses: {
        "204": { description: "连接已删除" },
        "400": response("请求参数无效", errorSchema),
        "401": response("需要登录", errorSchema),
        "403": response("系统连接只读", errorSchema),
        "404": response("连接不存在", errorSchema),
        "500": response("服务端无法完成请求", errorSchema)
      }
    })
  );
  add(
    paths,
    "/api/v1/acquisition/provider-connections/{id}/test",
    "post",
    operation("post", "执行受控健康检查", {
      parameters: [idParameter()],
      responses: standardResponses(
        200,
        "健康检查结果",
        providerConnectionHealthSchema
      )
    })
  );
}

function addDiscoveryOperationPaths(paths: AcquisitionOpenApiPaths) {
  const contentFetchListSchema = {
    type: "object",
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: contentFetchOperationResponseSchema
      }
    },
    additionalProperties: false
  };
  const importOperationListSchema = {
    type: "object",
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: importOperationResponseSchema
      }
    },
    additionalProperties: false
  };
  add(
    paths,
    "/api/v1/acquisition/content-fetch-operations",
    "get",
    operation("get", "列出受控公开网页抓取任务", {
      parameters: [boundedLimitParameter()],
      responses: standardResponses(200, "任务列表", contentFetchListSchema)
    })
  );
  add(
    paths,
    "/api/v1/acquisition/content-fetch-operations",
    "post",
    operation("post", "创建受控公开网页抓取任务", {
      parameters: [idempotencyParameter(1)],
      requestBody: jsonBody({
        type: "object",
        required: ["sourceUrl", "subjectChannel"],
        properties: {
          sourceUrl: {
            type: "string",
            format: "uri",
            pattern: "^[Hh][Tt][Tt][Pp][Ss]://",
            minLength: 1,
            maxLength: 4_096,
            description: [
              "仅允许公开 HTTPS URL。",
              "运行时还会拒绝凭据、非默认端口、内网地址和敏感查询参数。"
            ].join(" ")
          },
          subjectChannel: {
            type: "string",
            enum: ["organization", "individual"]
          }
        },
        additionalProperties: false
      }),
      responses: standardResponses(
        202,
        "任务已排队",
        contentFetchOperationResponseSchema
      )
    })
  );
  add(
    paths,
    "/api/v1/acquisition/content-fetch-operations/{id}",
    "get",
    operation("get", "读取网页抓取任务", {
      parameters: [idParameter(160)],
      responses: standardResponses(
        200,
        "网页抓取任务",
        contentFetchOperationResponseSchema
      )
    })
  );
  const importParameters = [
    idempotencyParameter(1),
    {
      name: "fileName",
      in: "query",
      required: true,
      schema: { type: "string", minLength: 1, maxLength: 255 }
    },
    {
      name: "subjectChannel",
      in: "query",
      required: true,
      schema: {
        type: "string",
        enum: ["organization", "individual"]
      }
    },
    {
      name: "mapping",
      in: "query",
      required: true,
      description: "URL 编码后的列映射 JSON。",
      schema: { type: "string", minLength: 2, maxLength: 4096 }
    }
  ];
  const binarySchema = {
    type: "string",
    format: "binary",
    maxLength: 5 * 1024 * 1024
  };
  add(
    paths,
    "/api/v1/acquisition/import-operations",
    "get",
    operation("get", "列出客户授权文件导入任务", {
      parameters: [boundedLimitParameter()],
      responses: standardResponses(200, "任务列表", importOperationListSchema)
    })
  );
  add(
    paths,
    "/api/v1/acquisition/import-operations",
    "post",
    operation("post", "上传并创建 CSV/XLSX 导入任务", {
      parameters: importParameters,
      requestBody: {
        required: true,
        description: [
          "仅接受原始 CSV/XLSX 二进制内容；",
          "application/json 返回 415 unsupported_media_type。"
        ].join(""),
        content: {
          "text/csv": { schema: binarySchema },
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
            schema: binarySchema
          },
          "application/octet-stream": { schema: binarySchema }
        }
      },
      responses: {
        ...standardResponses(
          202,
          "导入任务已排队",
          importOperationResponseSchema
        ),
        "413": response("文件超过 5 MB 限制", errorSchema),
        "415": response("文件类型不受支持", errorSchema)
      }
    })
  );
  add(
    paths,
    "/api/v1/acquisition/import-operations/{id}",
    "get",
    operation("get", "读取文件导入任务", {
      parameters: [idParameter(160)],
      responses: standardResponses(
        200,
        "文件导入任务",
        importOperationResponseSchema
      )
    })
  );
}

function visualReaderErrorResponses(
  includePayloadTooLarge: boolean,
  includeForbidden = true
) {
  return {
    "400": response("视觉读取请求无效", errorSchema),
    "401": response("需要登录", errorSchema),
    ...(includeForbidden
      ? { "403": response("CSRF 安全校验失败", errorSchema) } : {}),
    "404": response("视觉读取资源不存在", errorSchema),
    "409": response("视觉读取状态、预算或幂等键冲突", errorSchema),
    ...(includePayloadTooLarge
      ? { "413": response("视觉读取请求体过大", errorSchema) } : {}),
    "500": response("视觉读取服务无法完成请求", errorSchema)
  };
}

function visualReaderReplayHeader(required: boolean) {
  return {
    "Idempotency-Replayed": {
      ...(required ? { required: true } : {}),
      description: "值为 true 表示返回首个相同幂等请求的完整公共响应。",
      schema: { type: "string", enum: ["true"] }
    }
  };
}

function addVisualReaderPaths(paths: AcquisitionOpenApiPaths) {
  add(paths, "/api/v1/acquisition/visual-reader-sessions", "post", operation(
    "post",
    "创建显式授权的视觉评论读取会话",
    {
      parameters: [idempotencyParameter(1)],
      requestBody: jsonBody(visualReaderCreateRequestSchema),
      responses: {
        "201": response("视觉读取会话已创建", visualReaderSessionResponseSchema),
        "200": {
          ...response("既有视觉读取会话的幂等重放",
            visualReaderSessionResponseSchema),
          headers: visualReaderReplayHeader(true)
        },
        ...visualReaderErrorResponses(true)
      }
    }
  ));
  add(paths,
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}",
    "get",
    operation("get", "读取授权视觉评论会话", {
      parameters: [idParameter(160, "sessionId")],
      responses: {
        "200": response("视觉读取会话", visualReaderSessionResponseSchema),
        ...visualReaderErrorResponses(false, false)
      }
    })
  );
  add(paths,
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch",
    "post",
    operation("post", "写入有界可见评论观察批次", {
      parameters: [
        idParameter(160, "sessionId"),
        idempotencyParameter(1)
      ],
      requestBody: jsonBody(visualReaderBatchRequestSchema),
      responses: {
        "200": {
          ...response("已接受及重复的视觉评论观察",
            visualReaderBatchResponseSchema),
          headers: visualReaderReplayHeader(false)
        },
        ...visualReaderErrorResponses(true)
      }
    })
  );
  for (const terminal of [
    {
      suffix: "complete",
      summary: "完成授权视觉评论读取会话",
      body: visualReaderCompleteRequestSchema
    },
    {
      suffix: "abort",
      summary: "中止授权视觉评论读取会话",
      body: visualReaderAbortRequestSchema
    }
  ]) {
    add(paths,
      `/api/v1/acquisition/visual-reader-sessions/{sessionId}:${terminal.suffix}`,
      "post",
      operation("post", terminal.summary, {
        parameters: [
          idParameter(160, "sessionId"),
          idempotencyParameter(1)
        ],
        requestBody: jsonBody(terminal.body),
        responses: {
          "200": response("终态视觉读取会话",
            visualReaderSessionResponseSchema),
          ...visualReaderErrorResponses(true)
        }
      })
    );
  }
  add(paths,
    "/api/v1/acquisition/visual-reader-artifacts/{artifactId}",
    "get",
    operation("get", "读取授权且已遮挡的评论卡片 WebP", {
      parameters: [idParameter(160, "artifactId")],
      responses: {
        "200": {
          description: "已遮挡 WebP 评论卡片",
          headers: {
            "Cache-Control": {
              required: true,
              schema: { type: "string", enum: ["private, no-store"] }
            },
            "X-Content-Type-Options": {
              required: true,
              schema: { type: "string", enum: ["nosniff"] }
            },
            "Content-Security-Policy": {
              required: true,
              schema: {
                type: "string",
                enum: ["default-src 'none'; frame-ancestors 'none'; sandbox"]
              }
            }
          },
          content: {
            "image/webp": { schema: { type: "string", format: "binary" } }
          }
        },
        ...visualReaderErrorResponses(false, false)
      }
    })
  );
}

const identityConfirmationWriteSchema = {
  oneOf: [
    {
      type: "object",
      required: [
        "subjectKind",
        "domain",
        "creditCode",
        "evidenceIds",
        "rationale"
      ],
      properties: {
        subjectKind: {
          type: "string",
          enum: ["organization"]
        },
        domain: {
          type: "string",
          nullable: true,
          maxLength: 255
        },
        creditCode: {
          type: "string",
          nullable: true,
          maxLength: 50
        },
        evidenceIds: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 255 }
        },
        rationale: {
          type: "string",
          minLength: 1,
          maxLength: 2_000
        }
      },
      additionalProperties: false
    },
    {
      type: "object",
      required: [
        "subjectKind",
        "publicProfileUrl",
        "sourcePlatform",
        "evidenceIds",
        "rationale"
      ],
      properties: {
        subjectKind: {
          type: "string",
          enum: ["individual"]
        },
        publicProfileUrl: {
          type: "string",
          format: "uri",
          maxLength: 2_000
        },
        sourcePlatform: {
          type: "string",
          minLength: 1,
          maxLength: 100
        },
        evidenceIds: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 255 }
        },
        rationale: {
          type: "string",
          minLength: 1,
          maxLength: 2_000
        }
      },
      additionalProperties: false
    }
  ],
  discriminator: {
    propertyName: "subjectKind"
  }
};

const strictEmptyWriteSchema = {
  type: "object",
  additionalProperties: false,
  maxProperties: 0
};

const acquisitionUsageWriteSchema = {
  type: "object",
  required: ["requests", "results", "amountMinor", "durationSeconds"],
  properties: {
    requests: { type: "integer", minimum: 0 },
    results: { type: "integer", minimum: 0 },
    amountMinor: { type: "integer", minimum: 0 },
    durationSeconds: { type: "integer", minimum: 0 }
  },
  additionalProperties: false
};

const douyinPublicCommentSampleWriteSchema = {
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

const enabledDouyinCommentProviderRequirement = {
  if: {
    type: "object",
    required: ["douyinPublicCommentSample"],
    properties: {
      douyinPublicCommentSample: {
        type: "object",
        required: ["enabled"],
        properties: { enabled: { enum: [true] } }
      }
    }
  },
  then: {
    type: "object",
    required: ["targetPlatform", "providerConnections"],
    properties: {
      targetPlatform: { enum: ["douyin"] },
      providerConnections: {
        type: "array",
        not: {
          items: {
            not: {
              type: "object",
              required: ["providerId", "kind", "status"],
              properties: {
                providerId: { enum: ["experimental_public_sample"] },
                kind: { enum: ["content_fetch"] },
                status: { enum: ["active"] }
              }
            }
          }
        }
      }
    }
  }
};

const planCreateWriteSchema = {
  type: "object",
  required: [
    "name",
    "objective",
    "icp",
    "subjectChannels",
    "providerConnections",
    "operations",
    "budgetSnapshot",
    "stopConditions"
  ],
  properties: {
    targetPlatform: {
      type: "string",
      enum: ["douyin", "web"]
    },
    douyinPublicCommentSample: douyinPublicCommentSampleWriteSchema,
    name: { type: "string", minLength: 1, maxLength: 200 },
    objective: { type: "string", minLength: 1, maxLength: 2_000 },
    icp: {
      type: "object",
      required: [
        "industries",
        "regions",
        "organizationCriteria",
        "individualCriteria",
        "exclusionRules"
      ],
      properties: {
        industries: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 120 }
        },
        regions: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 120 }
        },
        organizationCriteria: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 500 }
        },
        individualCriteria: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 500 }
        },
        exclusionRules: {
          type: "array",
          maxItems: 200,
          items: { type: "string", minLength: 1, maxLength: 500 }
        }
      },
      additionalProperties: false
    },
    subjectChannels: {
      type: "object",
      required: ["organization", "individual"],
      properties: {
        organization: { type: "boolean" },
        individual: { type: "boolean" }
      },
      additionalProperties: false
    },
    providerConnections: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        required: [
          "connectionId",
          "providerId",
          "kind",
          "status",
          "credentialVersion"
        ],
        properties: {
          connectionId: { type: "string", minLength: 1, maxLength: 255 },
          providerId: { type: "string", minLength: 1, maxLength: 100 },
          kind: {
            type: "string",
            enum: ["search", "content_fetch", "import"]
          },
          status: {
            type: "string",
            enum: ["active", "inactive", "disabled"]
          },
          credentialVersion: { type: "integer", minimum: 1 }
        },
        additionalProperties: false
      }
    },
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 500,
      items: {
        type: "object",
        required: [
          "operationId",
          "subjectChannel",
          "kind",
          "connectionId",
          "allocatedBudget"
        ],
        properties: {
          operationId: { type: "string", minLength: 1, maxLength: 255 },
          subjectChannel: {
            type: "string",
            enum: ["organization", "individual"]
          },
          kind: {
            type: "string",
            enum: ["search", "content_fetch", "import_rows"]
          },
          connectionId: { type: "string", minLength: 1, maxLength: 255 },
          query: { type: "string", minLength: 1, maxLength: 4_000 },
          sourceRef: { type: "string", minLength: 1, maxLength: 4_000 },
          allocatedBudget: acquisitionUsageWriteSchema
        },
        additionalProperties: false
      }
    },
    budgetSnapshot: {
      type: "object",
      required: [
        "billingCurrency",
        "maxRequests",
        "maxResults",
        "maxAmountMinor",
        "maxDurationSeconds"
      ],
      properties: {
        billingCurrency: {
          type: "string",
          minLength: 3,
          maxLength: 3
        },
        maxRequests: { type: "integer", minimum: 0 },
        maxResults: { type: "integer", minimum: 0 },
        maxAmountMinor: { type: "integer", minimum: 0 },
        maxDurationSeconds: { type: "integer", minimum: 0 }
      },
      additionalProperties: false
    },
    modelConnectionId: {
      type: "string",
      nullable: true,
      minLength: 1,
      maxLength: 255,
      description: "可选 BYOK 模型连接；服务端据此绑定不可伪造的模型快照。"
    },
    stopConditions: {
      type: "object",
      required: [
        "stopWhenBudgetExhausted",
        "stopWhenNoMoreResults"
      ],
      properties: {
        stopWhenBudgetExhausted: { type: "boolean" },
        stopWhenNoMoreResults: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  allOf: [enabledDouyinCommentProviderRequirement],
  additionalProperties: false
};

const reviewWriteSchema = {
  oneOf: [
    {
      type: "object",
      required: ["action", "decisionVersion", "reason"],
      properties: {
        action: {
          type: "string",
          enum: ["approved", "do_not_contact"]
        },
        decisionVersion: {
          type: "string",
          minLength: 1,
          maxLength: 100
        },
        reason: {
          type: "string",
          nullable: true,
          maxLength: 2_000
        }
      },
      additionalProperties: false
    },
    {
      type: "object",
      required: ["action", "decisionVersion", "reason"],
      properties: {
        action: {
          type: "string",
          enum: ["rejected", "needs_research", "reopen"]
        },
        decisionVersion: {
          type: "string",
          minLength: 1,
          maxLength: 100
        },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 2_000
        }
      },
      additionalProperties: false
    }
  ]
};

const convertWriteSchema = {
  type: "object",
  required: ["decisionVersion"],
  properties: {
    decisionVersion: {
      type: "string",
      minLength: 1,
      maxLength: 100
    }
  },
  additionalProperties: false
};

const privateDomainHandoffWriteSchema = {
  oneOf: ["create_new", "link_existing"].map((mode) => ({
    type: "object",
    required: [
      "operationCode",
      "runId",
      "discoveredEventId",
      "decisionVersion",
      "mode",
      "existingCustomerId",
      "followUp"
    ],
    properties: {
      operationCode: {
        type: "string",
        enum: ["handoff_acquisition_candidate_v1"]
      },
      runId: { type: "string", minLength: 1, maxLength: 255 },
      discoveredEventId: { type: "string", minLength: 1, maxLength: 255 },
      decisionVersion: {
        type: "string",
        minLength: 1,
        maxLength: 100
      },
      mode: { type: "string", enum: [mode] },
      existingCustomerId: mode === "link_existing"
        ? { type: "string", minLength: 1, maxLength: 255 }
        : { type: "string", maxLength: 0 },
      followUp: {
        type: "object",
        required: ["title", "dueAt", "priority"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 500 },
          dueAt: { type: "string", format: "date-time" },
          priority: {
            type: "string",
            enum: ["high", "medium", "normal"]
          }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  }))
};

const privateDomainHandoffPendingResponseSchema = {
  type: "object",
  required: ["replayed", "inProgress"],
  properties: {
    replayed: { type: "boolean", enum: [false] },
    inProgress: {
      type: "object",
      required: [
        "id",
        "candidateId",
        "decisionVersion",
        "mode",
        "existingCustomerId",
        "stage",
        "request",
        "createdAt"
      ],
      properties: {
        id: { type: "string" },
        candidateId: { type: "string" },
        decisionVersion: { type: "string" },
        mode: {
          type: "string",
          enum: ["create_new", "link_existing"]
        },
        existingCustomerId: { type: "string" },
        stage: {
          type: "string",
          enum: [
            "reserved",
            "lead_ready",
            "customer_ready",
            "activity_ready",
            "todo_ready",
            "completed"
          ]
        },
        request: privateDomainHandoffRecoveryRequestSchema,
        createdAt: { type: "string", format: "date-time" }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
};

const privateDomainHandoffStatusResponseSchema = {
  oneOf: [
    privateDomainHandoffResponseSchema,
    privateDomainHandoffPendingResponseSchema
  ]
};

const copilotSessionWriteSchema = {
  type: "object",
  properties: {
    connectionId: {
      type: "string",
      nullable: true,
      minLength: 1,
      maxLength: 255
    }
  },
  additionalProperties: false
};

const copilotMessageWriteSchema = {
  type: "object",
  required: ["message"],
  properties: {
    message: {
      type: "string",
      minLength: 1,
      maxLength: 20_000
    },
    responseMode: {
      type: "string",
      enum: ["assistant", "plan_draft"],
      default: "assistant"
    },
    targetPlatform: {
      type: "string",
      enum: ["douyin", "web"],
      default: "web"
    }
  },
  additionalProperties: false
};

const planModelSnapshotWriteSchema = {
  type: "object",
  required: [
    "jobSnapshotId",
    "connectionId",
    "credentialVersion",
    "provider",
    "model",
    "capabilitySnapshotHash",
    "promptVersion",
    "schemaVersion",
    "promptHash",
    "schemaHash"
  ],
  properties: {
    jobSnapshotId: { type: "string", minLength: 1, maxLength: 255 },
    connectionId: { type: "string", minLength: 1, maxLength: 255 },
    credentialVersion: { type: "integer", minimum: 1 },
    provider: { type: "string", minLength: 1, maxLength: 100 },
    model: { type: "string", minLength: 1, maxLength: 200 },
    capabilitySnapshotHash: {
      type: "string",
      minLength: 1,
      maxLength: 200
    },
    promptVersion: { type: "string", minLength: 1, maxLength: 100 },
    schemaVersion: { type: "string", minLength: 1, maxLength: 100 },
    promptHash: { type: "string", minLength: 1, maxLength: 200 },
    schemaHash: { type: "string", minLength: 1, maxLength: 200 }
  },
  additionalProperties: false
};

const planMutationWriteSchema = {
  type: "object",
  minProperties: 1,
  properties: {
    targetPlatform: planCreateWriteSchema.properties.targetPlatform,
    douyinPublicCommentSample:
      douyinPublicCommentSampleWriteSchema,
    name: planCreateWriteSchema.properties.name,
    objective: planCreateWriteSchema.properties.objective,
    icp: planCreateWriteSchema.properties.icp,
    subjectChannels: planCreateWriteSchema.properties.subjectChannels,
    providerConnections:
      planCreateWriteSchema.properties.providerConnections,
    operations: planCreateWriteSchema.properties.operations,
    budgetSnapshot: planCreateWriteSchema.properties.budgetSnapshot,
    modelSnapshotRef: planModelSnapshotWriteSchema,
    stopConditions: planCreateWriteSchema.properties.stopConditions
  },
  additionalProperties: false
};

const planApprovalWriteSchema = {
  type: "object",
  required: ["decision", "reason"],
  properties: {
    decision: {
      type: "string",
      enum: ["approve"]
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 2_000
    }
  },
  additionalProperties: false
};

const planRunWriteSchema = {
  type: "object",
  properties: {
    parentRunId: {
      type: "string",
      minLength: 1,
      maxLength: 255
    },
    reason: {
      type: "string",
      maxLength: 2_000
    }
  },
  additionalProperties: false
};

const planControlWriteSchema = {
  type: "object",
  required: ["reason"],
  properties: {
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 2_000
    }
  },
  additionalProperties: false
};

const visualReaderStableErrorCodeSchema = {
  type: "string",
  enum: [
    "visual_reader_not_enabled",
    "visual_reader_session_expired",
    "visual_reader_budget_exhausted",
    "visual_source_invalid",
    "visual_observation_invalid",
    "visual_artifact_invalid",
    "visual_extraction_method_disabled",
    "visual_extraction_low_confidence",
    "visual_reader_user_takeover"
  ]
};

const visualReaderUsageSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "videoCount",
    "observationCount",
    "scrollCount",
    "ocrCallCount",
    "domObservationCount",
    "accessibilityObservationCount",
    "ocrObservationCount",
    "lowConfidenceObservationCount",
    "artifactCount"
  ],
  properties: {
    videoCount: { type: "integer", minimum: 0, maximum: 10 },
    observationCount: { type: "integer", minimum: 0, maximum: 300 },
    scrollCount: { type: "integer", minimum: 0, maximum: 5 },
    ocrCallCount: { type: "integer", minimum: 0, maximum: 10 },
    domObservationCount: { type: "integer", minimum: 0, maximum: 300 },
    accessibilityObservationCount: {
      type: "integer",
      minimum: 0,
      maximum: 300
    },
    ocrObservationCount: { type: "integer", minimum: 0, maximum: 300 },
    lowConfidenceObservationCount: {
      type: "integer",
      minimum: 0,
      maximum: 300
    },
    artifactCount: { type: "integer", minimum: 0, maximum: 300 }
  }
};

const visualReaderStepSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "status",
    "startedAt",
    "completedAt",
    "durationMs",
    "processedCount",
    "errorCode",
    "message"
  ],
  properties: {
    id: {
      type: "string",
      enum: [
        "authorize_visual_reader",
        "read_visible_comment_cards",
        "extract_visible_text",
        "persist_visual_observations",
        "review_visual_signal_confidence"
      ]
    },
    status: {
      type: "string",
      enum: [
        "pending",
        "running",
        "succeeded",
        "partial_success",
        "failed",
        "skipped"
      ]
    },
    startedAt: { type: ["null", "string"], format: "date-time" },
    completedAt: { type: ["null", "string"], format: "date-time" },
    durationMs: { type: ["null", "integer"], minimum: 0 },
    processedCount: { type: "integer", minimum: 0 },
    errorCode: {
      oneOf: [visualReaderStableErrorCodeSchema, { type: "null" }]
    },
    message: { type: "string", minLength: 1, maxLength: 500 }
  }
};

const runPresentationSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://goodjob.example/contracts/json-schema/acquisition-run-presentation.v1.schema.json",
  title: "AcquisitionRunPresentation",
  type: "object",
  required: [
    "run",
    "providers",
    "summary",
    "automationSteps",
    "commentSignals",
    "candidateEvents",
    "nextAfter",
    "hasMore"
  ],
  properties: {
    run: {
      type: "object",
      required: ["id", "status", "etag", "updatedAt", "completedAt"],
      properties: {
        id: { type: "string" },
        status: {
          type: "string",
          enum: [
            "queued",
            "running",
            "pause_requested",
            "paused",
            "cancel_requested",
            "cancelled",
            "succeeded",
            "succeeded_empty",
            "partial_success",
            "failed",
            "budget_exhausted"
          ]
        },
        etag: { type: "string" },
        updatedAt: { type: "string", format: "date-time" },
        completedAt: {
          type: "string",
          format: "date-time",
          nullable: true
        }
      },
      additionalProperties: false
    },
    providers: {
      type: "array",
      items: {
        type: "object",
        required: [
          "shardId",
          "connectionId",
          "providerId",
          "status",
          "rawResultCount",
          "acceptedResultCount",
          "duplicateResultCount",
          "failedResultCount",
          "errorCode",
          "retryAfterAt"
        ],
        properties: {
          shardId: { type: "string" },
          connectionId: { type: "string" },
          providerId: { type: "string" },
          status: { type: "string" },
          rawResultCount: { type: "integer", minimum: 0 },
          acceptedResultCount: { type: "integer", minimum: 0 },
          duplicateResultCount: { type: "integer", minimum: 0 },
          failedResultCount: { type: "integer", minimum: 0 },
          errorCode: { type: "string", nullable: true },
          retryAfterAt: {
            type: "string",
            format: "date-time",
            nullable: true
          }
        },
        additionalProperties: false
      }
    },
    summary: {
      type: "object",
      required: [
        "sourcesSearched",
        "pagesAnalyzed",
        "organizationsFound",
        "dedupedCandidates",
        "validOpportunities",
        "highIntent",
        "financialEvaluatedHighIntentCount",
        "financialPendingHighIntentCount",
        "expectedRevenueByCurrency",
        "discoveredVideos",
        "commentsSampled",
        "validDemandSignals",
        "unresolvedActors",
        "highPotentialSignals"
      ],
      properties: {
        sourcesSearched: { type: "integer", minimum: 0 },
        pagesAnalyzed: {
          type: "integer",
          minimum: 0,
          description: "所有运行分片持久化的执行结果页数。"
        },
        organizationsFound: { type: "integer", minimum: 0 },
        dedupedCandidates: { type: "integer", minimum: 0 },
        validOpportunities: { type: "integer", minimum: 0 },
        highIntent: { type: "integer", minimum: 0 },
        financialEvaluatedHighIntentCount: {
          type: "integer",
          minimum: 0
        },
        financialPendingHighIntentCount: {
          type: "integer",
          minimum: 0
        },
        discoveredVideos: { type: "integer", minimum: 0 },
        commentsSampled: { type: "integer", minimum: 0 },
        validDemandSignals: { type: "integer", minimum: 0 },
        unresolvedActors: { type: "integer", minimum: 0 },
        highPotentialSignals: { type: "integer", minimum: 0 },
        expectedRevenueByCurrency: {
          type: "array",
          description: "仅合计高意向且绑定当前资格决定的财务值；币种不换算。",
          items: {
            type: "object",
            required: ["currency", "amountMinor"],
            properties: {
              currency: { type: "string" },
              amountMinor: { type: "integer" }
            },
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    automationSteps: {
      type: "array",
      minItems: 7,
      maxItems: 7,
      items: {
        type: "object",
        required: [
          "id",
          "status",
          "startedAt",
          "completedAt",
          "durationMs",
          "processedCount",
          "errorCode",
          "message"
        ],
        properties: {
          id: {
            type: "string",
            enum: [
              "discover_video_urls",
              "resolve_video_ids",
              "fetch_public_comment_samples",
              "normalize_platform_events",
              "aggregate_actor_signals",
              "qualify_candidates",
              "refresh_run_presentation"
            ]
          },
          status: {
            type: "string",
            enum: [
              "pending",
              "running",
              "succeeded",
              "partial_success",
              "failed",
              "skipped"
            ]
          },
          startedAt: { type: "string", format: "date-time", nullable: true },
          completedAt: { type: "string", format: "date-time", nullable: true },
          durationMs: { type: "integer", minimum: 0, nullable: true },
          processedCount: { type: "integer", minimum: 0 },
          errorCode: {
            type: "string",
            nullable: true,
            enum: [
              null,
              "public_sample_unavailable",
              "access_restricted",
              "rate_limited",
              "video_id_unresolved",
              "source_payload_invalid",
              "no_public_comments",
              "model_output_invalid"
            ]
          },
          message: { type: "string", minLength: 1, maxLength: 500 }
        },
        additionalProperties: false
      }
    },
    authorizedVisualReader: {
      type: "object",
      additionalProperties: false,
      required: [
        "sessionId",
        "coverage",
        "status",
        "limits",
        "usage",
        "outcome",
        "lastErrorCode",
        "sessionCount",
        "aggregateStatus",
        "aggregateUsage",
        "visualSteps"
      ],
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: 160 },
        coverage: { const: "authorized_visible_top_level_sample" },
        status: {
          type: "string",
          enum: [
            "created",
            "collecting",
            "completed",
            "partial_success",
            "aborted",
            "expired"
          ]
        },
        limits: {
          type: "object",
          additionalProperties: false,
          required: [
            "maxVideos",
            "maxCommentsPerVideo",
            "maxScrolls",
            "maxOcrCalls",
            "maxDurationMs"
          ],
          properties: {
            maxVideos: { type: "integer", minimum: 1, maximum: 10 },
            maxCommentsPerVideo: { type: "integer", minimum: 1, maximum: 30 },
            maxScrolls: { type: "integer", minimum: 0, maximum: 5 },
            maxOcrCalls: { type: "integer", minimum: 0, maximum: 10 },
            maxDurationMs: { type: "integer", minimum: 1, maximum: 120_000 }
          }
        },
        usage: visualReaderUsageSchema,
        outcome: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: [
                "status",
                "videoCount",
                "observationCount",
                "domObservationCount",
                "accessibilityObservationCount",
                "ocrObservationCount",
                "lowConfidenceObservationCount",
                "artifactCount",
                "errorCodes"
              ],
              properties: {
                status: {
                  type: "string",
                  enum: ["completed", "partial_success", "aborted", "expired"]
                },
                videoCount: { type: "integer", minimum: 0, maximum: 10 },
                observationCount: { type: "integer", minimum: 0, maximum: 300 },
                domObservationCount: { type: "integer", minimum: 0, maximum: 300 },
                accessibilityObservationCount: {
                  type: "integer", minimum: 0, maximum: 300
                },
                ocrObservationCount: { type: "integer", minimum: 0, maximum: 300 },
                lowConfidenceObservationCount: {
                  type: "integer", minimum: 0, maximum: 300
                },
                artifactCount: { type: "integer", minimum: 0, maximum: 300 },
                errorCodes: {
                  type: "array",
                  maxItems: 9,
                  uniqueItems: true,
                  items: visualReaderStableErrorCodeSchema
                }
              }
            }
            , { type: "null" }
          ]
        },
        lastErrorCode: {
          oneOf: [visualReaderStableErrorCodeSchema, { type: "null" }]
        },
        sessionCount: {
          type: "integer",
          minimum: 1,
          maximum: 1_000
        },
        aggregateStatus: {
          type: "string",
          enum: ["active", "succeeded", "partial_success", "failed", "stopped"]
        },
        aggregateUsage: {
          type: "object",
          additionalProperties: false,
          required: [...visualReaderUsageSchema.required],
          properties: {
            videoCount: { type: "integer", minimum: 0, maximum: 10_000 },
            observationCount: {
              type: "integer", minimum: 0, maximum: 300_000
            },
            scrollCount: { type: "integer", minimum: 0, maximum: 5_000 },
            ocrCallCount: { type: "integer", minimum: 0, maximum: 10_000 },
            domObservationCount: {
              type: "integer", minimum: 0, maximum: 300_000
            },
            accessibilityObservationCount: {
              type: "integer", minimum: 0, maximum: 300_000
            },
            ocrObservationCount: {
              type: "integer", minimum: 0, maximum: 300_000
            },
            lowConfidenceObservationCount: {
              type: "integer", minimum: 0, maximum: 300_000
            },
            artifactCount: {
              type: "integer", minimum: 0, maximum: 300_000
            }
          }
        },
        visualSteps: {
          type: "array",
          minItems: 5,
          maxItems: 5,
          items: visualReaderStepSchema
        }
      }
    },
    commentSignals: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        required: [
          "eventId",
          "candidateId",
          "displayName",
          "handle",
          "text",
          "occurredAt",
          "likeCount",
          "replyCount",
          "ipLabel",
          "sourceUrl",
          "intentBand",
          "reasons",
          "confidence",
          "identityStatus",
          "evidenceId"
        ],
        properties: {
          eventId: { type: "string", minLength: 1, maxLength: 255 },
          candidateId: { type: "string", minLength: 1, maxLength: 255 },
          displayName: { type: "string", minLength: 1, maxLength: 255 },
          handle: { type: "string", maxLength: 255, nullable: true },
          text: { type: "string", minLength: 1, maxLength: 2_000 },
          occurredAt: { type: "string", format: "date-time" },
          likeCount: { type: "integer", minimum: 0 },
          replyCount: { type: "integer", minimum: 0 },
          ipLabel: { type: "string", maxLength: 100, nullable: true },
          sourceUrl: { type: "string", format: "uri", maxLength: 2_000 },
          intentBand: {
            type: "string",
            enum: ["strong_signal", "potential_signal", "noise", "negative"]
          },
          reasons: {
            type: "array",
            maxItems: 20,
            items: { type: "string", maxLength: 200 }
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          identityStatus: {
            type: "string",
            enum: ["resolved", "needs_research"]
          },
          evidenceId: { type: "string", minLength: 1, maxLength: 255 }
        },
        additionalProperties: false
      }
    },
    candidateEvents: {
      type: "array",
      items: {
        type: "object",
        required: [
          "eventId",
          "createdAt",
          "candidateId",
          "candidate",
          "qualification",
          "financialValue",
          "sourcePlatforms",
          "evidenceCount"
        ],
        properties: {
          eventId: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          candidateId: { type: "string" },
          candidate: {
            type: "object",
            required: [
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
            ],
            properties: {
              id: { type: "string" },
              subjectKind: {
                type: "string",
                enum: ["organization", "individual"]
              },
              displayName: { type: "string" },
              industry: { type: "string", nullable: true },
              region: { type: "string", nullable: true },
              domain: { type: "string", nullable: true },
              status: { type: "string" },
              version: { type: "integer", minimum: 1 },
              identityResolved: { type: "boolean" },
              updatedAt: { type: "string", format: "date-time" }
            },
            additionalProperties: false
          },
          qualification: {
            type: "object",
            nullable: true,
            required: [
              "id",
              "candidateId",
              "decisionVersion",
              "decisionEngine",
              "grade",
              "score",
              "recommendedAction",
              "evidence",
              "positiveSignals",
              "negativeSignals",
              "reasons",
              "confidence",
              "ruleVersion",
              "promptVersion",
              "modelProvider",
              "model",
              "hardGateFailures",
              "createdAt"
            ],
            properties: {
              id: { type: "string" },
              candidateId: { type: "string" },
              decisionVersion: { type: "string" },
              decisionEngine: {
                type: "string",
                enum: ["model", "rules"]
              },
              grade: {
                type: "string",
                enum: ["S", "A", "B", "C", "D"]
              },
              score: { type: "number" },
              recommendedAction: {
                type: "string",
                enum: [
                  "priority_review",
                  "public_response",
                  "nurture",
                  "observe",
                  "do_not_contact"
                ]
              },
              evidence: {
                type: "array",
                items: {
                  type: "object",
                  required: ["evidenceId", "excerpt"],
                  properties: {
                    evidenceId: { type: "string" },
                    excerpt: { type: "string" }
                  },
                  additionalProperties: false
                }
              },
              positiveSignals: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "score"],
                  properties: {
                    name: { type: "string" },
                    score: { type: "number" }
                  },
                  additionalProperties: false
                }
              },
              negativeSignals: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "score"],
                  properties: {
                    name: { type: "string" },
                    score: { type: "number" }
                  },
                  additionalProperties: false
                }
              },
              reasons: {
                type: "array",
                items: { type: "string" }
              },
              confidence: { type: "number" },
              ruleVersion: { type: "string" },
              promptVersion: { type: "string", nullable: true },
              modelProvider: { type: "string", nullable: true },
              model: { type: "string", nullable: true },
              hardGateFailures: {
                type: "array",
                items: {
                  type: "string",
                  enum: [
                    "missing_original_source",
                    "identity_unresolved",
                    "do_not_contact",
                    "explicit_rejection",
                    "non_public_or_sensitive_data",
                    "stale_evidence",
                    "schema_invalid"
                  ]
                }
              },
              createdAt: { type: "string", format: "date-time" }
            },
            additionalProperties: false
          },
          financialValue: {
            type: "object",
            nullable: true,
            required: [
              "id",
              "candidateId",
              "qualificationDecisionId",
              "version",
              "grade",
              "score",
              "currency",
              "expectedRevenueMinor",
              "expectedGrossProfitMinor",
              "expectedContributionMinor",
              "factors",
              "createdAt"
            ],
            properties: {
              id: { type: "string" },
              candidateId: { type: "string" },
              qualificationDecisionId: { type: "string" },
              version: { type: "string" },
              grade: {
                type: "string",
                enum: ["S", "A", "B", "C", "D"]
              },
              score: { type: "number" },
              currency: { type: "string" },
              expectedRevenueMinor: { type: "integer" },
              expectedGrossProfitMinor: { type: "integer" },
              expectedContributionMinor: { type: "integer" },
              factors: {
                type: "object",
                required: [
                  "profitability",
                  "cashFlow",
                  "creditQuality",
                  "repeatPotential",
                  "referralPotential",
                  "closeProbability"
                ],
                properties: {
                  profitability: { type: "number" },
                  cashFlow: { type: "number" },
                  creditQuality: { type: "number" },
                  repeatPotential: { type: "number" },
                  referralPotential: { type: "number" },
                  closeProbability: { type: "number" }
                },
                additionalProperties: false
              },
              createdAt: { type: "string", format: "date-time" }
            },
            additionalProperties: false
          },
          sourcePlatforms: {
            type: "array",
            items: { type: "string" }
          },
          evidenceCount: { type: "integer", minimum: 0 }
        },
        additionalProperties: false
      }
    },
    nextAfter: { type: "string" },
    hasMore: { type: "boolean" }
  },
  additionalProperties: false
};

function addCoreAgentPaths(paths: AcquisitionOpenApiPaths) {
  const definitions: Array<
    [
      string,
      AcquisitionHttpMethod,
      string
    ]
  > = [
    ["/api/v1/acquisition/evidence/{id}", "get", "读取公开证据"],
    ["/api/v1/acquisition/candidates", "get", "列出候选客户"],
    ["/api/v1/acquisition/candidates/{id}", "get", "读取候选客户"],
    ["/api/v1/acquisition/candidates/{id}/evidence", "get", "列出候选证据"],
    ["/api/v1/acquisition/candidates/{id}/identity-confirmation", "post", "人工确认公开主体身份"],
    ["/api/v1/acquisition/candidates/{candidateId}/intelligence-operations", "post", "创建候选客户情报任务"],
    ["/api/v1/acquisition/candidate-intelligence-operations/{operationId}", "get", "读取候选客户情报任务"],
    ["/api/v1/acquisition/candidates/{candidateId}/intelligence-operation", "get", "读取候选客户最新情报任务"],
    ["/api/v1/acquisition/candidate-intelligence-operations/{operationId}/retry", "post", "重试候选客户情报任务"],
    ["/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operation", "get", "读取候选最新抖音主体核验任务"],
    ["/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operations", "post", "创建或重试候选抖音主体核验任务"],
    ["/api/v1/acquisition/candidates/{id}/qualification", "get", "读取资格判断"],
    ["/api/v1/acquisition/candidates/{id}/financial-value", "get", "读取财务价值判断"],
    ["/api/v1/acquisition/candidates/{id}/battle-card", "get", "读取客户作战卡"],
    ["/api/v1/acquisition/candidates/{id}/reviews", "get", "读取人工审核历史"],
    ["/api/v1/acquisition/candidates/{id}/review", "post", "提交人工审核"],
    ["/api/v1/acquisition/candidates/{id}/convert", "post", "人工确认转换为 CRM 线索"],
    ["/api/v1/acquisition/candidates/{id}/private-domain-handoffs", "post", "交接已批准候选至 CRM/私域"],
    ["/api/v1/acquisition/candidates/{id}/private-domain-handoff", "get", "读取候选的 CRM/私域交接"],
    ["/api/v1/acquisition/outcomes", "get", "列出成交反馈"],
    ["/api/v1/acquisition/performance", "get", "读取获客经营漏斗、分币种合同额和老板简报事实"],
    ["/api/v1/acquisition/audit-events", "get", "读取获客审计事件"],
    ["/api/v1/acquisition/copilot/sessions", "post", "创建绑定模型快照的 Pi 会话"],
    ["/api/v1/acquisition/copilot/sessions/{id}", "get", "读取 Pi 会话"],
    ["/api/v1/acquisition/copilot/sessions/{id}/messages", "get", "读取 Pi 会话消息"],
    ["/api/v1/acquisition/copilot/sessions/{id}/messages", "post", "向 AI 增长参谋提交任务"],
    ["/api/v1/acquisition/copilot/tasks/{id}", "get", "读取 AI 任务状态"],
    ["/api/v1/acquisition/plans", "post", "创建可审计获客计划"],
    ["/api/v1/acquisition/plans/{id}", "get", "读取获客计划"],
    ["/api/v1/acquisition/plans/{id}", "patch", "更新草稿计划"],
    ["/api/v1/acquisition/plans/{id}/revisions", "post", "创建计划修订"],
    ["/api/v1/acquisition/plans/{id}/approval", "post", "人工批准获客计划"],
    ["/api/v1/acquisition/plans/{id}/runs", "post", "运行已批准计划"],
    ["/api/v1/acquisition/runs/{id}", "get", "读取运行状态"],
    ["/api/v1/acquisition/runs/{id}/shards", "get", "读取运行分片"],
    ["/api/v1/acquisition/runs/{id}/presentation", "get", "读取运行权威展示事件"],
    ["/api/v1/acquisition/runs/{id}/pause", "post", "暂停运行"],
    ["/api/v1/acquisition/runs/{id}/resume", "post", "恢复运行"],
    ["/api/v1/acquisition/runs/{id}/cancel", "post", "取消运行"]
  ];

  const writeBodies: Record<string, {
    schema: Record<string, unknown>;
    required?: boolean;
    successStatus?: number;
    successDescription?: string;
  }> = {
    "post /api/v1/acquisition/candidates/{id}/identity-confirmation": {
      schema: identityConfirmationWriteSchema
    },
    "post /api/v1/acquisition/candidates/{candidateId}/intelligence-operations": {
      schema: strictEmptyWriteSchema,
      successStatus: 202,
      successDescription: "候选客户情报任务已接受"
    },
    "post /api/v1/acquisition/candidate-intelligence-operations/{operationId}/retry": {
      schema: strictEmptyWriteSchema,
      successStatus: 202,
      successDescription: "候选客户情报重试已接受"
    },
    "post /api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operations": {
      schema: strictEmptyWriteSchema,
      successStatus: 202,
      successDescription: "抖音主体核验任务已接受"
    },
    "post /api/v1/acquisition/candidates/{id}/review": {
      schema: reviewWriteSchema
    },
    "post /api/v1/acquisition/candidates/{id}/convert": {
      schema: convertWriteSchema
    },
    "post /api/v1/acquisition/candidates/{id}/private-domain-handoffs": {
      schema: privateDomainHandoffWriteSchema
    },
    "post /api/v1/acquisition/copilot/sessions": {
      schema: copilotSessionWriteSchema,
      successStatus: 202,
      successDescription: "Pi 会话创建任务已接受"
    },
    "post /api/v1/acquisition/copilot/sessions/{id}/messages": {
      schema: copilotMessageWriteSchema,
      successStatus: 202,
      successDescription: "Pi 消息任务已接受"
    },
    "post /api/v1/acquisition/plans": {
      schema: planCreateWriteSchema,
      successStatus: 201,
      successDescription: "获客计划已创建"
    },
    "patch /api/v1/acquisition/plans/{id}": {
      schema: planMutationWriteSchema
    },
    "post /api/v1/acquisition/plans/{id}/revisions": {
      schema: planMutationWriteSchema,
      successStatus: 201,
      successDescription: "计划修订已创建"
    },
    "post /api/v1/acquisition/plans/{id}/approval": {
      schema: planApprovalWriteSchema
    },
    "post /api/v1/acquisition/plans/{id}/runs": {
      schema: planRunWriteSchema,
      required: false,
      successStatus: 202,
      successDescription: "计划运行已接受"
    },
    "post /api/v1/acquisition/runs/{id}/pause": {
      schema: planControlWriteSchema
    },
    "post /api/v1/acquisition/runs/{id}/resume": {
      schema: planControlWriteSchema
    },
    "post /api/v1/acquisition/runs/{id}/cancel": {
      schema: planControlWriteSchema
    }
  };
  const v1IdempotentWrites = new Set([
    "/api/v1/acquisition/candidates/{id}/identity-confirmation",
    "/api/v1/acquisition/candidates/{candidateId}/intelligence-operations",
    "/api/v1/acquisition/candidate-intelligence-operations/{operationId}/retry",
    "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operations",
    "/api/v1/acquisition/candidates/{id}/review",
    "/api/v1/acquisition/candidates/{id}/convert",
    "/api/v1/acquisition/candidates/{id}/private-domain-handoffs",
    "/api/v1/acquisition/copilot/sessions",
    "/api/v1/acquisition/copilot/sessions/{id}/messages"
  ]);
  const planIdempotentWrites = new Set([
    "/api/v1/acquisition/plans",
    "/api/v1/acquisition/plans/{id}/runs"
  ]);
  const etagWrites = new Set([
    "/api/v1/acquisition/candidates/{id}/identity-confirmation",
    "/api/v1/acquisition/plans/{id}",
    "/api/v1/acquisition/plans/{id}/revisions",
    "/api/v1/acquisition/plans/{id}/approval",
    "/api/v1/acquisition/runs/{id}/pause",
    "/api/v1/acquisition/runs/{id}/resume",
    "/api/v1/acquisition/runs/{id}/cancel"
  ]);
  const etagResponses = new Set([
    "/api/v1/acquisition/candidates/{id}",
    "/api/v1/acquisition/candidates/{id}/identity-confirmation",
    "/api/v1/acquisition/plans",
    "/api/v1/acquisition/plans/{id}",
    "/api/v1/acquisition/plans/{id}/revisions",
    "/api/v1/acquisition/plans/{id}/approval",
    "/api/v1/acquisition/plans/{id}/runs",
    "/api/v1/acquisition/runs/{id}",
    "/api/v1/acquisition/runs/{id}/pause",
    "/api/v1/acquisition/runs/{id}/resume",
    "/api/v1/acquisition/runs/{id}/cancel"
  ]);
  const planResponsePaths = new Set([
    "/api/v1/acquisition/plans",
    "/api/v1/acquisition/plans/{id}",
    "/api/v1/acquisition/plans/{id}/revisions",
    "/api/v1/acquisition/plans/{id}/approval"
  ]);
  const runResponsePaths = new Set([
    "/api/v1/acquisition/plans/{id}/runs",
    "/api/v1/acquisition/runs/{id}",
    "/api/v1/acquisition/runs/{id}/pause",
    "/api/v1/acquisition/runs/{id}/resume",
    "/api/v1/acquisition/runs/{id}/cancel"
  ]);
  const coreResponseSchemas: Record<string, Record<string, unknown>> = {
    "get /api/v1/acquisition/evidence/{id}":
      discoveryEvidenceResponseSchema,
    "get /api/v1/acquisition/candidates": candidatePagedResponseSchema,
    "get /api/v1/acquisition/candidates/{id}": candidateResponseSchema,
    "get /api/v1/acquisition/candidates/{id}/evidence":
      evidencePagedResponseSchema,
    "post /api/v1/acquisition/candidates/{id}/identity-confirmation":
      identityConfirmationResponseSchema,
    "post /api/v1/acquisition/candidates/{candidateId}/intelligence-operations":
      candidateIntelligenceOperationResponseSchema,
    "get /api/v1/acquisition/candidate-intelligence-operations/{operationId}":
      candidateIntelligenceOperationResponseSchema,
    "get /api/v1/acquisition/candidates/{candidateId}/intelligence-operation":
      candidateIntelligenceOperationResponseSchema,
    "post /api/v1/acquisition/candidate-intelligence-operations/{operationId}/retry":
      candidateIntelligenceOperationResponseSchema,
    "get /api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operation":
      douyinIdentityResolutionOperationResponseSchema,
    "post /api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operations":
      douyinIdentityResolutionOperationResponseSchema,
    "get /api/v1/acquisition/candidates/{id}/qualification":
      qualificationDecisionResponseSchema,
    "get /api/v1/acquisition/candidates/{id}/financial-value":
      financialValueDecisionResponseSchema,
    "get /api/v1/acquisition/candidates/{id}/battle-card":
      battleCardResponseSchema,
    "get /api/v1/acquisition/candidates/{id}/reviews":
      reviewPagedResponseSchema,
    "post /api/v1/acquisition/candidates/{id}/review":
      reviewResultResponseSchema,
    "post /api/v1/acquisition/candidates/{id}/convert":
      leadConversionResponseSchema,
    "post /api/v1/acquisition/candidates/{id}/private-domain-handoffs":
      privateDomainHandoffResponseSchema,
    "get /api/v1/acquisition/candidates/{id}/private-domain-handoff":
      privateDomainHandoffStatusResponseSchema,
    "get /api/v1/acquisition/outcomes": outcomePagedResponseSchema,
    "get /api/v1/acquisition/performance":
      acquisitionPerformanceResponseSchema,
    "get /api/v1/acquisition/audit-events": auditPagedResponseSchema,
    "post /api/v1/acquisition/copilot/sessions":
      asyncOperationResponseSchema,
    "get /api/v1/acquisition/copilot/sessions/{id}":
      copilotSessionResponseSchema,
    "get /api/v1/acquisition/copilot/sessions/{id}/messages":
      copilotMessagePagedResponseSchema,
    "post /api/v1/acquisition/copilot/sessions/{id}/messages":
      copilotTaskResponseSchema,
    "get /api/v1/acquisition/copilot/tasks/{id}":
      copilotTaskResponseSchema
  };

  for (const [path, method, summary] of definitions) {
    const parameters: Array<Record<string, unknown>> = [];
    const pathParameterName = path.includes("{candidateId}")
      ? "candidateId"
      : path.includes("{operationId}")
        ? "operationId"
        : path.includes("{id}")
          ? "id"
          : null;
    if (pathParameterName) {
      parameters.push(idParameter(
        pathParameterName === "id"
          ? 255
          : path.includes("/douyin-identity-resolution-")
            ? 120
            : 160,
        pathParameterName
      ));
    }
    if (method === "get") {
      if ([
        "/api/v1/acquisition/candidates",
        "/api/v1/acquisition/candidates/{id}/evidence",
        "/api/v1/acquisition/candidates/{id}/reviews",
        "/api/v1/acquisition/outcomes",
        "/api/v1/acquisition/audit-events",
        "/api/v1/acquisition/copilot/sessions/{id}/messages"
      ].includes(path)) {
        parameters.push(...paginationParameters());
      }
      if (path === "/api/v1/acquisition/candidates") {
        parameters.push(
          {
            name: "subjectKind",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["organization", "individual"]
            }
          },
          {
            name: "status",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: [
                ...candidateStatuses
              ]
            }
          }
        );
      }
      if (path === "/api/v1/acquisition/outcomes") {
        parameters.push({
          name: "candidateId",
          in: "query",
          required: true,
          schema: {
            type: "string",
            minLength: 1,
            maxLength: 255
          }
        });
      }
      if (path === "/api/v1/acquisition/performance") {
        parameters.push(
          {
            name: "platform",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["douyin", "web"] }
          },
          {
            name: "from",
            in: "query",
            required: true,
            schema: { type: "string", format: "date" }
          },
          {
            name: "to",
            in: "query",
            required: true,
            schema: { type: "string", format: "date" }
          }
        );
      }
      if (path === "/api/v1/acquisition/audit-events") {
        parameters.push({
          name: "candidateId",
          in: "query",
          required: false,
          schema: {
            type: "string",
            minLength: 1,
            maxLength: 255
          }
        });
      }
      if (path === "/api/v1/acquisition/runs/{id}/presentation") {
        parameters.push(
          {
            name: "after",
            in: "query",
            required: false,
            schema: {
              type: "string",
              minLength: 1,
              maxLength: 8192
            }
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 50
            }
          }
        );
      }
    } else {
      if (v1IdempotentWrites.has(path)) {
        parameters.push(idempotencyParameter(
          path.endsWith("/private-domain-handoffs") ? 8 : 1
        ));
      } else if (planIdempotentWrites.has(path)) {
        parameters.push(idempotencyParameter(8));
      }
      if (etagWrites.has(path)) {
        parameters.push(
          path.endsWith("/identity-confirmation")
            ? ifMatchParameter({
                type: "string",
                pattern: '^"candidate-v[1-9]\\d*"$'
              })
            : ifMatchParameter()
        );
      }
    }
    const body = method === "get"
      ? null
      : writeBodies[`${method} ${path}`];
    if (method !== "get" && !body) {
      throw new Error(`Missing OpenAPI write body for ${method} ${path}`);
    }
    const successStatus = body?.successStatus ?? 200;
    const successSchema = coreResponseSchemas[`${method} ${path}`]
      ?? (planResponsePaths.has(path)
        ? acquisitionPlanResponseSchema
        : runResponsePaths.has(path)
          ? acquisitionRunResponseSchema
          : path === "/api/v1/acquisition/runs/{id}/shards"
            ? pagedResultResponseSchema
            : path === "/api/v1/acquisition/runs/{id}/presentation"
              ? runPresentationSchema
              : resourceSchema);
    const responses = standardResponses(
      successStatus,
      body?.successDescription ?? "操作成功",
      successSchema
    );
    if (path === "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operation") {
      for (const status of Object.keys(responses)) {
        if (!["200", "401", "404"].includes(status)) delete responses[status];
      }
    }
    if (path === "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operations") {
      for (const status of Object.keys(responses)) {
        if (!["202", "400", "401", "403", "404", "409"].includes(status)) {
          delete responses[status];
        }
      }
      responses["422"] = response("候选主体不满足安全核验条件", errorSchema);
      responses["403"] = response("CSRF 安全校验失败", errorSchema);
      responses["429"] = response("请求过于频繁", errorSchema);
      (responses["202"] as Record<string, unknown>).headers = {
        "Idempotency-Replayed": {
          description: "值为 true 表示返回的是同一幂等请求的既有结果。",
          schema: { type: "string", enum: ["true"] }
        }
      };
    }
    if (etagResponses.has(path)) {
      (responses[String(successStatus)] as Record<string, unknown>).headers = {
        ETag: {
          required: true,
          schema: path.startsWith("/api/v1/acquisition/candidates/")
            ? {
                type: "string",
                pattern: '^"candidate-v[1-9]\\d*"$'
              }
            : { type: "string", minLength: 1 }
        }
      };
    }
    if (method === "post"
      && path.endsWith("/private-domain-handoffs")) {
      (responses[String(successStatus)] as Record<string, unknown>).headers = {
        "Idempotency-Replayed": {
          description: "值为 true 表示返回的是同一幂等请求的既有结果。",
          schema: {
            type: "string",
            enum: ["true"]
          }
        }
      };
    }
    if (method !== "get" && etagWrites.has(path)) {
      if (
        path
        !== "/api/v1/acquisition/candidates/{id}/identity-confirmation"
      ) {
        responses["412"] = response("资源版本不匹配", errorSchema);
      }
      responses["428"] = response("缺少 If-Match 版本条件", errorSchema);
    }
    add(
      paths,
      path,
      method,
      operation(method, summary, {
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(body
          ? {
              requestBody: jsonBody(
                body.schema,
                body.required ?? true
              )
            }
          : {}),
        responses
      })
    );
  }
}

export function createAcquisitionOpenApiPaths():
AcquisitionOpenApiPaths {
  const paths: AcquisitionOpenApiPaths = {};
  addProviderPaths(paths);
  addDiscoveryOperationPaths(paths);
  addVisualReaderPaths(paths);
  addCoreAgentPaths(paths);
  addAcquisitionOperationIds(paths);
  return convertEmbeddedSchemasToOpenApi30(paths);
}
