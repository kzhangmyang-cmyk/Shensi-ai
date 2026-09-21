import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import * as contractHelpers from "./acquisition-openapi-contract-test-helpers.js";

const contractDirectory = fileURLToPath(new URL(
  "../../contracts/",
  import.meta.url
));
const publishedContractPath = join(
  contractDirectory,
  "openapi/ai-acquisition.v1.yaml"
);
const yamlOptions = {
  merge: true,
  maxAliasCount: 1_000
} as const;

type JsonRecord = Record<string, any>;

function requireSourceAssertion() {
  const candidate = (contractHelpers as JsonRecord)
    .assertPublishedVisualReaderSchemaSources;
  assert.equal(
    typeof candidate,
    "function",
    "the published-contract loader must expose its raw visual schema assertion"
  );
  return candidate as (source: JsonRecord) => void;
}

function getParentAtPath(source: JsonRecord, path: string[]) {
  let current: JsonRecord = source;
  for (const segment of path.slice(0, -1)) {
    current = current[segment];
  }
  return {
    parent: current,
    key: path.at(-1)!
  };
}

async function loadRawPublishedSource() {
  return parse(
    await readFile(publishedContractPath, "utf8"),
    yamlOptions
  ) as JsonRecord;
}

async function withPublishedContractFixture(
  mutate: (source: JsonRecord) => void,
  run: (path: string) => Promise<void>
) {
  const temporaryRoot = await mkdtemp(join(
    tmpdir(),
    "goodjob-acquisition-contract-"
  ));
  try {
    const fixtureContracts = join(temporaryRoot, "contracts");
    await cp(contractDirectory, fixtureContracts, { recursive: true });
    const fixturePath = join(
      fixtureContracts,
      "openapi/ai-acquisition.v1.yaml"
    );
    const source = parse(
      await readFile(fixturePath, "utf8"),
      yamlOptions
    ) as JsonRecord;
    mutate(source);
    await writeFile(fixturePath, stringify(source), "utf8");
    await run(fixturePath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("raw visual route schemas and Task 1 fragment targets are exact", async () => {
  const assertSources = requireSourceAssertion();
  const source = await loadRawPublishedSource();
  assert.doesNotThrow(() => assertSources(source));

  const refNodes: string[][] = [
    ["components", "schemas", "DouyinVisualCommentObservation"],
    ["components", "schemas", "OpaqueRectRedactionProof"],
    ["components", "schemas", "VisualObservationSubmission"],
    ["components", "schemas", "VisualReaderLimits"],
    ["components", "schemas", "VisualReaderUsage"],
    ["components", "schemas", "VisualReaderOutcome"],
    ["components", "schemas", "VisualReaderSession"],
    ["components", "schemas", "VisualReaderCreateRequest"],
    ["components", "schemas", "VisualObservationBatchRequest"],
    ["components", "schemas", "VisualObservationBatchResponse"],
    ["components", "schemas", "VisualReaderCompleteRequest"],
    ["components", "schemas", "VisualReaderAbortRequest"],
    [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions",
      "post",
      "requestBody",
      "content",
      "application/json",
      "schema"
    ],
    [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions",
      "post",
      "responses",
      "201",
      "content",
      "application/json",
      "schema"
    ],
    [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions",
      "post",
      "responses",
      "200",
      "content",
      "application/json",
      "schema"
    ],
    [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}",
      "get",
      "responses",
      "200",
      "content",
      "application/json",
      "schema"
    ],
    [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch",
      "post",
      "requestBody",
      "content",
      "application/json",
      "schema"
    ],
    [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch",
      "post",
      "responses",
      "200",
      "content",
      "application/json",
      "schema"
    ],
    [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}:complete",
      "post",
      "requestBody",
      "content",
      "application/json",
      "schema"
    ],
    [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}:complete",
      "post",
      "responses",
      "200",
      "content",
      "application/json",
      "schema"
    ],
    [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}:abort",
      "post",
      "requestBody",
      "content",
      "application/json",
      "schema"
    ],
    [
      "paths",
      "/api/v1/acquisition/visual-reader-sessions/{sessionId}:abort",
      "post",
      "responses",
      "200",
      "content",
      "application/json",
      "schema"
    ]
  ];

  for (const path of refNodes) {
    const mutated = structuredClone(source);
    const { parent, key } = getParentAtPath(mutated, path);
    parent[key] = { $ref: "#/components/schemas/ApiError" };
    assert.throws(
      () => assertSources(mutated),
      /Published visual reader schema source mismatch/,
      path.join(".")
    );
  }

  const artifactPath = [
    "paths",
    "/api/v1/acquisition/visual-reader-artifacts/{artifactId}",
    "get",
    "responses",
    "200",
    "content",
    "image/webp",
    "schema"
  ];
  const withoutArtifactSchema = structuredClone(source);
  const { parent, key } = getParentAtPath(
    withoutArtifactSchema,
    artifactPath
  );
  delete parent[key];
  assert.throws(
    () => assertSources(withoutArtifactSchema),
    /Published visual reader schema source mismatch/,
    artifactPath.join(".")
  );
});

test("published loader rejects a wrong external visual fragment before replacement", async () => {
  await withPublishedContractFixture(
    (source) => {
      source.components.schemas.VisualReaderCreateRequest.$ref =
        "../json-schema/acquisition-visual-reader-session.v1.schema.json#/$defs/visualReaderAbortRequest";
    },
    async (fixturePath) => {
      await assert.rejects(
        () => (contractHelpers.loadPublishedAcquisitionPaths as (
          path?: string
        ) => Promise<unknown>)(fixturePath),
        /Published visual reader schema source mismatch/
      );
    }
  );
});

test("published loader rejects a wrong route schema before replacement", async () => {
  await withPublishedContractFixture(
    (source) => {
      source.paths[
        "/api/v1/acquisition/visual-reader-sessions/{sessionId}:complete"
      ].post.requestBody.content["application/json"].schema = {
        $ref: "#/components/schemas/VisualReaderAbortRequest"
      };
    },
    async (fixturePath) => {
      await assert.rejects(
        () => (contractHelpers.loadPublishedAcquisitionPaths as (
          path?: string
        ) => Promise<unknown>)(fixturePath),
        /Published visual reader schema source mismatch/
      );
    }
  );
});
