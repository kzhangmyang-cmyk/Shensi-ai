import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const contractsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const script = path.join(
  contractsRoot,
  "scripts",
  "generate-frontend-contract-types.mjs"
);
const input = path.join(
  contractsRoot,
  "openapi",
  "ai-acquisition.v1.yaml"
);
const growthInput = path.join(
  contractsRoot,
  "openapi",
  "growth-advisor-quote-roi.v1.yaml"
);
const tsc = path.join(
  contractsRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc"
);

function runGenerator(output, ...options) {
  return spawnSync(
    process.execPath,
    [script, ...options, "--input", input, "--output", output],
    { cwd: contractsRoot, encoding: "utf8" }
  );
}

function runGrowthGenerator(output, ...options) {
  return spawnSync(
    process.execPath,
    [script, ...options, "--input", growthInput, "--output", output],
    { cwd: contractsRoot, encoding: "utf8" }
  );
}

test("generated frontend contract types detect absent and stale outputs without mutating checks", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "goodjob-generated-types-")
  );
  const output = path.join(temporaryDirectory, "ai-acquisition.ts");

  try {
    const absent = runGenerator(output, "--check");
    assert.notEqual(absent.status, 0, "an absent output must fail --check");
    await assert.rejects(stat(output), { code: "ENOENT" });

    const written = runGenerator(output);
    assert.equal(written.status, 0, written.stderr);
    const generated = await readFile(output, "utf8");
    assert.match(generated, /export interface paths/);
    assert.match(generated, /export interface components/);
    assert.match(generated, /export (?:interface|type) operations/);
    assert.match(generated, /approveAcquisitionPlan:/);
    for (const failureCode of [
      "douyin_action_control_ambiguous",
      "douyin_action_content_mismatch",
      "douyin_action_receipt_ambiguous"
    ]) assert.match(generated, new RegExp(`\\b${failureCode}\\b`));

    const unchanged = runGenerator(output, "--check");
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(await readFile(output, "utf8"), generated);

    const corrupted = `${generated}\n// stale\n`;
    await writeFile(output, corrupted, "utf8");
    const stale = runGenerator(output, "--check");
    assert.notEqual(stale.status, 0, "a stale output must fail --check");
    assert.equal(
      await readFile(output, "utf8"),
      corrupted,
      "--check must not rewrite stale output"
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("generated Growth types expose the closed financial council aliases", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "goodjob-generated-financial-council-")
  );
  const output = path.join(temporaryDirectory, "growth.ts");
  try {
    const written = runGrowthGenerator(output);
    assert.equal(written.status, 0, written.stderr);
    const generated = await readFile(output, "utf8");
    for (const alias of [
      "FinancialCouncilRun", "FinancialCouncilCreateInput", "CandidateAction",
      "ActionPortfolio", "FinancialCouncilApproval", "FinancialCouncilDispatchView",
      "FinancialCouncilPortfolioRevisionInput", "FinancialCouncilPortfolioRevision",
      "FinancialCouncilRunEventPagedResult", "FinancialCouncilDispatchPagedResult",
      "CreateCouncilRunFromPackageInput", "FinancialCouncilModelRoutingPolicyInput",
      "FinancialCouncilModelRoutingPolicyView", "FinancialStatementPackagePreviewInput",
      "FinancialStatementPackagePreviewView", "FinancialStatementPackageView",
      "FinancialCashForecastReceivableInput", "FinancialCashForecastSupplementInput",
      "FinancialCashForecastPublicView", "FinancialStatementConsentInput",
      "FinancialCouncilAgentCenterView", "FinancialCouncilRunAgentsView"
    ]) assert.match(generated, new RegExp(`\\b${alias}\\b`));
    assert.match(generated, /collect_receivable/);
    assert.doesNotMatch(generated, /tax_filing/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("generated visual response DTOs accept real legal values without schema metadata fields", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "goodjob-generated-visual-consumer-")
  );
  const output = path.join(temporaryDirectory, "ai-acquisition.ts");
  const consumer = path.join(temporaryDirectory, "consumer.ts");
  const tsconfig = path.join(temporaryDirectory, "tsconfig.json");

  try {
    const written = runGenerator(output);
    assert.equal(written.status, 0, written.stderr);
    await writeFile(consumer, `
import type { components } from "./ai-acquisition.js";

const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const observation: components["schemas"]["DouyinVisualCommentObservation"] = {
  observationId: "visual-observation-1",
  sessionId: "visual-session-1",
  sourceUrl: "https://www.douyin.com/video/7536012345678909876",
  videoId: "7536012345678909876",
  visibleText: "visible public comment",
  textHash: digest,
  domTextHash: digest,
  ocrTextHash: null,
  displayName: "public user",
  visibleTimeText: "2 hours ago",
  likeCount: 3,
  replyCount: 1,
  platformCommentId: "1234567890123456789",
  publicProfileUrl: "https://www.douyin.com/user/MS4wLjABAAAA_public-actor",
  secUid: "MS4wLjABAAAA_public-actor",
  extractionMethod: "dom",
  fieldConfidences: { visibleText: 0.99 },
  viewportHash: digest,
  cardBounds: { x: 24, y: 32, width: 640, height: 180 },
  redactedCropHash: null,
  readerVersion: "goodjob-douyin-visual-reader@1.0.0",
  capturedAt: "2026-08-15T03:00:00.000Z"
};

const session: components["schemas"]["VisualReaderSession"] = {
  sessionId: "visual-session-1",
  runId: "run-1",
  planId: "plan-1",
  planVersionId: "plan-version-1",
  platform: "douyin",
  coverage: "authorized_visible_top_level_sample",
  status: "created",
  artifactUploadEnabled: true,
  limits: {
    maxVideos: 10,
    maxCommentsPerVideo: 30,
    maxScrolls: 5,
    maxOcrCalls: 10,
    maxDurationMs: 120000
  },
  usage: {
    videoCount: 1,
    observationCount: 1,
    scrollCount: 0,
    ocrCallCount: 0,
    domObservationCount: 1,
    accessibilityObservationCount: 0,
    ocrObservationCount: 0,
    lowConfidenceObservationCount: 0,
    artifactCount: 0
  },
  outcome: null,
  lastErrorCode: null,
  createdAt: "2026-08-15T03:00:00.000Z",
  authorizedAt: "2026-08-15T03:00:00.000Z",
  updatedAt: "2026-08-15T03:00:00.000Z",
  expiresAt: "2026-08-15T03:02:00.000Z",
  completedAt: null
};

void [observation, session];
`, "utf8");
    await writeFile(tsconfig, JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2022"
      },
      files: [output, consumer]
    }), "utf8");

    const compilation = spawnSync(tsc, ["--project", tsconfig], {
      cwd: temporaryDirectory,
      encoding: "utf8"
    });
    assert.equal(
      compilation.status,
      0,
      `${compilation.stdout}${compilation.stderr}`
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("generated visual helpers remain globally unique without renaming existing Copilot or digest helpers", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "goodjob-generated-visual-helpers-")
  );
  const output = path.join(temporaryDirectory, "ai-acquisition.ts");

  try {
    const written = runGenerator(output);
    assert.equal(written.status, 0, written.stderr);
    const generated = await readFile(output, "utf8");

    const componentHeaders = [...generated.matchAll(
      /^        (?:"([^"]+)"|([A-Za-z_$][A-Za-z0-9_$-]*)): /gmu
    )];
    const componentBlocks = new Map(componentHeaders.map((match, index) => [
      match[1] ?? match[2],
      generated.slice(
        match.index,
        componentHeaders[index + 1]?.index ?? generated.length
      )
    ]));
    const visualPublicAliases = new Set([
      "DouyinVisualCommentObservation",
      "OpaqueRectRedactionProof",
      "VisualObservationSubmission",
      "VisualReaderLimits",
      "VisualReaderUsage",
      "VisualReaderOutcome",
      "VisualReaderSession",
      "VisualReaderCreateRequest",
      "VisualObservationBatchRequest",
      "VisualObservationBatchResponse",
      "VisualReaderCompleteRequest",
      "VisualReaderAbortRequest"
    ]);
    const reachableVisualComponents = new Set(visualPublicAliases);
    const pendingComponents = [...visualPublicAliases];
    while (pendingComponents.length > 0) {
      const component = pendingComponents.pop();
      const block = componentBlocks.get(component);
      assert.ok(block, `missing generated visual component ${component}`);
      for (const reference of block.matchAll(
        /components\["schemas"\]\["([^"]+)"\]/gu
      )) {
        if (reachableVisualComponents.has(reference[1])) continue;
        reachableVisualComponents.add(reference[1]);
        pendingComponents.push(reference[1]);
      }
    }

    for (const forbiddenGenericHelper of [
      "sourceUrl",
      "videoId",
      "visibleText",
      "extractionMethod",
      "readerVersion",
      "capturedAt"
    ]) {
      assert.equal(
        componentBlocks.has(forbiddenGenericHelper),
        false,
        `visual helper leaked generic component ${forbiddenGenericHelper}`
      );
    }
    for (const component of reachableVisualComponents) {
      if (visualPublicAliases.has(component)) continue;
      assert.equal(
        component === "douyinVisualCommentObservation"
          || component.startsWith("visualObservation")
          || component.startsWith("visualReader"),
        true,
        `visual helper must use a unique prefix: ${component}`
      );
    }

    assert.match(
      generated,
      /VisualReaderUsage: components\["schemas"\]\["visualReaderUsage"\]/
    );
    assert.match(generated, /\n        usage: \{\n            input: number;/);
    assert.doesNotMatch(generated, /"\$defs-usage"/);
    assert.match(
      generated,
      /rawPayloadHash: components\["schemas"\]\["digest"\]/
    );
    assert.match(
      generated,
      /textHash: components\["schemas"\]\["\$defs-digest"\]/
    );
    assert.match(
      generated,
      /textHash: components\["schemas"\]\["visualObservationDigest"\]/
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
