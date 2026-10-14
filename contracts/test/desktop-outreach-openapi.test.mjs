import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import YAML from "yaml";
import { loadOpenApiSource } from "./helpers.mjs";

test("desktop transport publishes six mutations plus a scoped binding read and production schema dependencies", async () => {
  const document = await loadOpenApiSource();
  const operations = [
    ["/desktop-installations/enrollments", "createAcquisitionDesktopEnrollment", "user"],
    ["/desktop-installations/register", "registerAcquisitionDesktopInstallation", "enrollment"],
    ["/social-accounts/{accountId}/desktop-binding", "bindAcquisitionDesktopExecutor", "user"],
    ["/desktop-outreach-actions/claim", "claimAcquisitionDesktopOutreachAction", "device"],
    ["/desktop-outreach-actions/{actionId}/complete", "completeAcquisitionDesktopOutreachAction", "device"],
    ["/desktop-outreach-actions/{actionId}/reconcile", "reconcileAcquisitionDesktopOutreachAction", "device"]
  ];
  for (const [suffix, id, authority] of operations) {
    const path = document.paths[`/api/v1/acquisition${suffix}`];
    assert.deepEqual(Object.keys(path), suffix.endsWith("/desktop-binding") ? ["get", "post"] : ["post"]);
    assert.equal(path.post.operationId, id);
    assert.deepEqual(path.post.security, authority === "user"
      ? [{ bearerAuth: [] }, { cookieAuth: [], csrfToken: [] }]
      : authority === "device" ? [{ desktopInstallationId: [], desktopDeviceToken: [] }] : []);
    assert.ok(path.post.responses["409"]);
    assert.ok(path.post.responses["503"]);
    assert.equal(path.post.parameters.some((p) =>
      p.$ref === "#/components/parameters/desktopBuildManifestSha256"), true);
    assert.equal(path.post.parameters.some((p) =>
      p.$ref === "#/components/parameters/desktopOutreachTaskToken"), suffix.endsWith("/complete"));
  }
  const bindingRead = document.paths["/api/v1/acquisition/social-accounts/{accountId}/desktop-binding"].get;
  assert.equal(bindingRead.operationId, "getAcquisitionDesktopBindingStatus");
  assert.deepEqual(bindingRead.security, [{ bearerAuth: [] }, { cookieAuth: [] }]);
  assert.equal(bindingRead.requestBody, undefined);
  assert.equal(bindingRead.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/DesktopBindingStatus");
  for (const name of ["desktopInstallationId", "desktopDeviceToken"]) {
    assert.equal(document.components.securitySchemes[name].type, "apiKey");
    assert.equal(document.components.securitySchemes[name].in, "header");
    assert.equal(document.components.parameters[name].required, true);
  }
  const backend = JSON.parse(await readFile(new URL("../../backend/package.json", import.meta.url), "utf8"));
  const lock = YAML.parse(await readFile(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"));
  assert.equal(backend.dependencies.yaml, "2.8.1");
  assert.equal(backend.devDependencies.yaml, undefined);
  assert.equal(lock.importers.backend.dependencies.yaml.specifier, backend.dependencies.yaml);
  assert.equal(lock.importers.backend.devDependencies.yaml, undefined);
});

test("generated desktop types preserve full recovery snapshots and discriminated commands", () => {
  const filename = fileURLToPath(new URL("./__desktop_outreach_typecheck__.ts", import.meta.url));
  const source = `import type { components } from "../../frontend/src/generated/ai-acquisition.js";
import type { components as DesktopComponents } from "../../desktop/src/generated/ai-acquisition.js";
type Recovery = components["schemas"]["DesktopOutreachReconcileRequest"];
type Released = Extract<components["schemas"]["DesktopOutreachReconcileResponse"], { kind: "released" }>;
type DesktopReleased = Extract<DesktopComponents["schemas"]["DesktopOutreachReconcileResponse"], { kind: "released" }>;
const released = { kind: "released" as const, actionId: "action", taskRequestHash: "hash",
  originalLeaseVersion: 1, replayed: false } satisfies Released;
const desktopReleased = released satisfies DesktopReleased;
// @ts-expect-error released never fabricates or transports a receipt.
const fakeReceipt = { ...released, receiptHash: "hash" } satisfies Released;
// @ts-expect-error the original lease is part of the exact cleanup fence.
const missingFence = { kind: "released", actionId: "action", taskRequestHash: "hash", replayed: false } satisfies DesktopReleased;
type Complete = components["schemas"]["DesktopOutreachCompleteRequest"];
const snapshot = { protocolVersion: 1 as const, processInstanceId: "process", accountId: "account",
  accountHandle: "handle", loginStateVersion: 1, bindingGeneration: 1,
  originalLeaseVersion: 1, taskRequestHash: "hash" };
const pending = { ...snapshot, journalPhase: "central_started" } satisfies Recovery;
const completed = { ...snapshot, journalPhase: "sidecar_completed", receiptHash: "hash" } satisfies Recovery;
// @ts-expect-error sidecar_completed requires its durable receipt hash.
const missingReceipt = { ...snapshot, journalPhase: "sidecar_completed" } satisfies Recovery;
// @ts-expect-error claimed cannot submit a receipt hash.
const unexpectedReceipt = { ...snapshot, journalPhase: "claimed", receiptHash: "hash" } satisfies Recovery;
const start = { protocolVersion: 1 as const, processInstanceId: "process", bindingGeneration: 1,
  command: { event: "started" as const, leaseVersion: 1, loginStateVersion: 1,
    taskRequestHash: "hash", occurredAt: "time" } } satisfies Complete;
// @ts-expect-error task capability remains a header, never request-body authority.
const bodyToken = { ...start, taskToken: "token" } satisfies Complete;
// @ts-expect-error started command cannot drop frozen login-state authority.
const incomplete = { ...start, command: { event: "started", leaseVersion: 1,
  taskRequestHash: "hash", occurredAt: "time" } } satisfies Complete;
`;
  const options = { noEmit: true, strict: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  host.readFile = (name) => name === filename ? source : originalRead(name);
  host.fileExists = (name) => name === filename || originalExists(name);
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n"
  }));
});
