import SwaggerParser from "@apidevtools/swagger-parser";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { parse } from "yaml";
import {
  convertJsonSchema202012ToOpenApi30,
  loadContractSchemaDefinition,
  projectVisualReaderBatchRequestToOpenApi30
} from "./acquisition-openapi.js";
import { createOpenApiDocument } from "./swagger.js";

type ContractHttpMethod = "get" | "post" | "patch" | "delete";
type ContractOperation = Record<string, any>;

export type ContractPathItem = Partial<
  Record<ContractHttpMethod, ContractOperation>
>;

const contractPath = fileURLToPath(new URL(
  "../../contracts/openapi/ai-acquisition.v1.yaml",
  import.meta.url
));
const httpMethods: ContractHttpMethod[] = [
  "get",
  "post",
  "patch",
  "delete"
];
let validatedProductionPaths: Promise<
  Record<string, ContractPathItem>
> | undefined;

const visualComponentSchemaRefs = {
  DouyinVisualCommentObservation:
    "../json-schema/douyin-visual-comment-observation.v1.schema.json#/$defs/douyinVisualCommentObservation",
  OpaqueRectRedactionProof:
    "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderOpaqueRectRedactionProof",
  VisualObservationSubmission:
    "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderObservationSubmission",
  VisualReaderLimits:
    "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderLimits",
  VisualReaderUsage:
    "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderUsage",
  VisualReaderOutcome:
    "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderOutcome",
  VisualReaderSession:
    "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderSession",
  VisualReaderCreateRequest:
    "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderCreateRequest",
  VisualObservationBatchRequest:
    "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderObservationBatchRequest",
  VisualObservationBatchResponse:
    "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderObservationBatchResponse",
  VisualReaderCompleteRequest:
    "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderCompleteRequest",
  VisualReaderAbortRequest:
    "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderAbortRequest"
} as const;

const visualRouteSchemaRefs = [
  {
    path: [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions",
      "post",
      "requestBody",
      "content",
      "application/json",
      "schema"
    ],
    ref: "#/components/schemas/VisualReaderCreateRequest"
  },
  {
    path: [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions",
      "post",
      "responses",
      "201",
      "content",
      "application/json",
      "schema"
    ],
    ref: "#/components/schemas/VisualReaderSession"
  },
  {
    path: [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions",
      "post",
      "responses",
      "200",
      "content",
      "application/json",
      "schema"
    ],
    ref: "#/components/schemas/VisualReaderSession"
  },
  {
    path: [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}",
      "get",
      "responses",
      "200",
      "content",
      "application/json",
      "schema"
    ],
    ref: "#/components/schemas/VisualReaderSession"
  },
  {
    path: [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch",
      "post",
      "requestBody",
      "content",
      "application/json",
      "schema"
    ],
    ref: "#/components/schemas/VisualObservationBatchRequest"
  },
  {
    path: [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch",
      "post",
      "responses",
      "200",
      "content",
      "application/json",
      "schema"
    ],
    ref: "#/components/schemas/VisualObservationBatchResponse"
  },
  {
    path: [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}:complete",
      "post",
      "requestBody",
      "content",
      "application/json",
      "schema"
    ],
    ref: "#/components/schemas/VisualReaderCompleteRequest"
  },
  {
    path: [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}:complete",
      "post",
      "responses",
      "200",
      "content",
      "application/json",
      "schema"
    ],
    ref: "#/components/schemas/VisualReaderSession"
  },
  {
    path: [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}:abort",
      "post",
      "requestBody",
      "content",
      "application/json",
      "schema"
    ],
    ref: "#/components/schemas/VisualReaderAbortRequest"
  },
  {
    path: [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}:abort",
      "post",
      "responses",
      "200",
      "content",
      "application/json",
      "schema"
    ],
    ref: "#/components/schemas/VisualReaderSession"
  }
] as const;

function sourceValueAtPath(source: any, path: readonly string[]) {
  let current = source;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

function assertExactSourceSchema(
  source: any,
  path: readonly string[],
  expected: Record<string, string>
) {
  const actual = sourceValueAtPath(source, path);
  const actualKeys = actual && typeof actual === "object"
    && !Array.isArray(actual)
    ? Object.keys(actual).sort()
    : [];
  const expectedKeys = Object.keys(expected).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || expectedKeys.some((key) => actual[key] !== expected[key])
  ) {
    throw new Error(
      `Published visual reader schema source mismatch: ${path.join(".")}`
    );
  }
}

export function assertPublishedVisualReaderSchemaSources(source: any) {
  for (const [name, ref] of Object.entries(visualComponentSchemaRefs)) {
    assertExactSourceSchema(
      source,
      ["components", "schemas", name],
      { $ref: ref }
    );
  }
  for (const routeSchema of visualRouteSchemaRefs) {
    assertExactSourceSchema(
      source,
      routeSchema.path,
      { $ref: routeSchema.ref }
    );
  }
  assertExactSourceSchema(
    source,
    [
      "paths",
      "/api/v1/acquisition/visual-reader-artifacts/{artifactId}",
      "get",
      "responses",
      "200",
      "content",
      "image/webp",
      "schema"
    ],
    { type: "string", format: "binary" }
  );
}

function canonicalizeOpenApi30Schema(value: any): any {
  if (Array.isArray(value)) {
    return value.map(canonicalizeOpenApi30Schema);
  }
  if (!value || typeof value !== "object") return value;

  const normalized = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "nullable")
      .map(([key, item]) => [key, canonicalizeOpenApi30Schema(item)])
  ) as Record<string, any>;
  if (value.nullable !== true) return normalized;

  if (normalized.type !== undefined) {
    const types = Array.isArray(normalized.type)
      ? normalized.type
      : [normalized.type];
    normalized.type = [...new Set([...types, "null"])].sort();
  }
  if (Array.isArray(normalized.enum)
    && !normalized.enum.includes(null)) {
    normalized.enum = [...normalized.enum, null];
  }
  if (normalized.type === undefined && normalized.enum === undefined) {
    for (const keyword of ["oneOf", "anyOf"] as const) {
      if (Array.isArray(normalized[keyword])) {
        normalized[keyword] = [
          ...normalized[keyword],
          { type: "null" }
        ];
        break;
      }
    }
  }
  return normalized;
}

function canonicalizeSchema(value: any): any {
  let openApi30 = projectVisualReaderBatchRequestToOpenApi30(value);
  try {
    openApi30 = convertJsonSchema202012ToOpenApi30(openApi30);
  } catch (error) {
    if (!(error instanceof TypeError)
      || !error.message.startsWith(
        "Cannot safely represent JSON Schema keyword in OpenAPI 3.0:"
      )) {
      throw error;
    }
    // Synthetic harness fixtures can contain order-sensitive 3.1 keywords
    // that are absent from the production acquisition schema subset. Keep
    // those fixtures intact so the normalizer still proves it preserves them.
  }
  return canonicalizeOpenApi30Schema(openApi30);
}

function mediaSurface(content: Record<string, any> = {}) {
  const mediaTypes = Object.keys(content).sort();
  return {
    mediaTypes,
    schemas: Object.fromEntries(mediaTypes.map((mediaType) => [
      mediaType,
      canonicalizeSchema(content[mediaType]?.schema ?? {})
    ]))
  };
}

function parametersSurface(parameters: any[] = []) {
  return parameters
    .map((parameter) => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required ?? false,
      schema: canonicalizeSchema(parameter.schema ?? {})
    }))
    .sort((left, right) => {
      const identityOrder = compareText(
        JSON.stringify([left.in, left.name]),
        JSON.stringify([right.in, right.name])
      );
      return identityOrder || compareText(
        JSON.stringify(left),
        JSON.stringify(right)
      );
    });
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function securitySurface(security: any[] = []) {
  return security
    .map((requirement) => Object.fromEntries(
      Object.keys(requirement).sort(compareText).map((name) => [
        name,
        [...(requirement[name] ?? [])].sort(compareText)
      ])
    ))
    .sort((left, right) => compareText(
      JSON.stringify(left),
      JSON.stringify(right)
    ));
}

function headersSurface(headers: Record<string, any> = {}) {
  return Object.fromEntries(Object.keys(headers).sort().map((name) => [
    name,
    {
      required: headers[name]?.required ?? false,
      schema: canonicalizeSchema(headers[name]?.schema ?? {})
    }
  ]));
}

export function mergeOperationParameters(
  pathParameters: any[] = [],
  operationParameters: any[] = []
) {
  const parameters = new Map<string, any>();
  for (const parameter of pathParameters) {
    parameters.set(
      JSON.stringify([parameter.name, parameter.in]),
      parameter
    );
  }
  for (const parameter of operationParameters) {
    parameters.set(
      JSON.stringify([parameter.name, parameter.in]),
      parameter
    );
  }
  return [...parameters.values()];
}

export async function loadPublishedAcquisitionPaths(): Promise<
  Record<string, ContractPathItem>
>;
export async function loadPublishedAcquisitionPaths(
  publishedContractPath: string
): Promise<Record<string, ContractPathItem>>;
export async function loadPublishedAcquisitionPaths(
  publishedContractPath = contractPath
): Promise<Record<string, ContractPathItem>> {
  const yamlOptions = {
    merge: true,
    maxAliasCount: 1_000
  } as const;
  const source = parse(
    await readFile(publishedContractPath, "utf8"),
    yamlOptions
  );
  if (!source || typeof source !== "object" || !("paths" in source)) {
    throw new Error("Published acquisition OpenAPI document has no paths");
  }
  assertPublishedVisualReaderSchemaSources(source);
  const document = await SwaggerParser.dereference(publishedContractPath, {
    parse: {
      yaml: {
        order: 1,
        allowEmpty: false,
        canParse: [".yaml", ".yml"],
        parse(file: { data: Buffer | string }) {
          return parse(file.data.toString(), yamlOptions);
        }
      }
    }
  } as any) as any;
  // SwaggerParser collapses multiple external fragments from the visual
  // contract's single Draft 2020-12 file onto its root `$ref`. Restore the
  // exact named definitions with the production fragment dereferencer before
  // comparing the published and runtime operation surfaces.
  const visualDefinitions = {
    session: loadContractSchemaDefinition(
      "acquisition-visual-reader-session",
      "visualReaderSession"
    ),
    create: loadContractSchemaDefinition(
      "acquisition-visual-reader-session",
      "visualReaderCreateRequest"
    ),
    batchRequest: loadContractSchemaDefinition(
      "acquisition-visual-reader-session",
      "visualReaderObservationBatchRequest"
    ),
    batchResponse: loadContractSchemaDefinition(
      "acquisition-visual-reader-session",
      "visualReaderObservationBatchResponse"
    ),
    complete: loadContractSchemaDefinition(
      "acquisition-visual-reader-session",
      "visualReaderCompleteRequest"
    ),
    abort: loadContractSchemaDefinition(
      "acquisition-visual-reader-session",
      "visualReaderAbortRequest"
    )
  };
  const visualPaths = document.paths as Record<string, any>;
  const createVisual = visualPaths[
    "/api/v1/acquisition/visual-reader-sessions"
  ]?.post;
  if (createVisual) {
    createVisual.requestBody.content["application/json"].schema =
      visualDefinitions.create;
    createVisual.responses["200"].content["application/json"].schema =
      visualDefinitions.session;
    createVisual.responses["201"].content["application/json"].schema =
      visualDefinitions.session;
  }
  const detailVisual = visualPaths[
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}"
  ]?.get;
  if (detailVisual) {
    detailVisual.responses["200"].content["application/json"].schema =
      visualDefinitions.session;
  }
  const batchVisual = visualPaths[
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch"
  ]?.post;
  if (batchVisual) {
    batchVisual.requestBody.content["application/json"].schema =
      visualDefinitions.batchRequest;
    batchVisual.responses["200"].content["application/json"].schema =
      visualDefinitions.batchResponse;
  }
  for (const [suffix, body] of [
    ["complete", visualDefinitions.complete],
    ["abort", visualDefinitions.abort]
  ] as const) {
    const terminal = visualPaths[
      `/api/v1/acquisition/visual-reader-sessions/{sessionId}:${suffix}`
    ]?.post;
    if (terminal) {
      terminal.requestBody.content["application/json"].schema = body;
      terminal.responses["200"].content["application/json"].schema =
        visualDefinitions.session;
    }
  }
  const paths: Record<string, ContractPathItem> = {};

  for (const [path, pathItem] of Object.entries(
    document.paths ?? {}
  ) as Array<[string, Record<string, any>]>) {
    const normalizedPathItem: ContractPathItem = {};
    for (const method of httpMethods) {
      const operation = pathItem[method];
      if (!operation) continue;
      normalizedPathItem[method] = {
        ...operation,
        parameters: mergeOperationParameters(
          pathItem.parameters,
          operation.parameters
        )
      };
    }
    paths[path] = normalizedPathItem;
  }
  return paths;
}

export function loadValidatedProductionAcquisitionPaths(): Promise<
  Record<string, ContractPathItem>
> {
  validatedProductionPaths ??= (async () => {
    const source = createOpenApiDocument(express()) as any;
    if (source.openapi !== "3.0.3") {
      throw new Error(
        `Unexpected production OpenAPI dialect: ${String(source.openapi)}`
      );
    }
    const document = await SwaggerParser.validate(
      structuredClone(source)
    ) as any;
    const paths: Record<string, ContractPathItem> = {};
    for (const [path, pathItem] of Object.entries(
      document.paths ?? {}
    ) as Array<[string, Record<string, any>]>) {
      if (!path.startsWith("/api/v1/acquisition/")) continue;
      const normalizedPathItem: ContractPathItem = {};
      for (const method of httpMethods) {
        const operation = pathItem[method];
        if (!operation) continue;
        normalizedPathItem[method] = {
          ...operation,
          parameters: mergeOperationParameters(
            pathItem.parameters,
            operation.parameters
          )
        };
      }
      paths[path] = normalizedPathItem;
    }
    return paths;
  })();
  return validatedProductionPaths;
}

export function operationSurface(operation: ContractOperation) {
  const responses = Object.fromEntries(
    Object.keys(operation.responses ?? {}).sort().map((status) => {
      const response = operation.responses[status];
      return [status, {
        headers: headersSurface(response.headers),
        ...mediaSurface(response.content)
      }];
    })
  );
  return {
    operationId: operation.operationId ?? null,
    security: securitySurface(operation.security),
    parameters: parametersSurface(operation.parameters),
    requestBody: operation.requestBody
      ? {
          required: operation.requestBody.required ?? false,
          ...mediaSurface(operation.requestBody.content)
        }
      : null,
    responses
  };
}
