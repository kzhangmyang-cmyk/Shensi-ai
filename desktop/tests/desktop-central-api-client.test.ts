import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { DesktopCentralApiClient } from "../src/main/desktop-central-api-client.ts";

const origin = "http://127.0.0.1:4321";
const buildManifestSha256 = "a".repeat(64);
const installationId = "i".repeat(43);
const deviceToken = "d".repeat(43);
const enrollmentToken = "e".repeat(43);
const workspaceId = "workspace-a";
const registration = { protocolVersion: 1 as const, installationId, enrollmentToken };
const registered = { protocolVersion: 1 as const, workspaceId, deviceToken };
const options = { idempotencyKey: "logical-registration", expectedWorkspaceId: workspaceId };
const context = { installationId, deviceToken, workspaceId };
const processInstanceId = "p".repeat(43);
const taskToken = "t".repeat(43);
const at = "2026-09-05T00:00:00.000Z";
const hashFixture: { vectors: Array<{ request: { action_id: string; account_handle: string;
  login_state_version: number; kind: "comment" | "direct_message"; canonical_target_public_url: string;
  content: string; approved_content_hash: string }; requestHash: string; receiptHash: string }> } =
  JSON.parse(readFileSync(new URL("../../contracts/fixtures/desktop-outreach-hashes.v1.json", import.meta.url), "utf8"));
const vector = hashFixture.vectors[0];
const account = { accountId: "account-a", accountHandle: vector.request.account_handle,
  loginStateVersion: vector.request.login_state_version, bindingGeneration: 2 };
const claim = { protocolVersion: 1 as const, processInstanceId, waitSeconds: 0 as const,
  availableAccounts: [account] };
const task = { actionId: vector.request.action_id, workspaceId, accountId: account.accountId,
  accountHandle: account.accountHandle, loginStateVersion: account.loginStateVersion, executorBindingGeneration: 2,
  kind: vector.request.kind, canonicalTargetPublicUrl: vector.request.canonical_target_public_url,
  content: vector.request.content, approvedContentHash: vector.request.approved_content_hash,
  taskRequestHash: vector.requestHash, deadlineAt: at, leaseVersion: 3,
  leaseExpiresAt: at, predecessorReceipt: null };
const complete = { protocolVersion: 1 as const, processInstanceId, bindingGeneration: 2,
  command: { event: "started" as const, leaseVersion: 3, loginStateVersion: account.loginStateVersion,
    taskRequestHash: vector.requestHash, occurredAt: at } };
const completion = { actionId: task.actionId, state: "executing" as const,
  replayed: false, accountPaused: false, occurredAt: at };
const reconcile = { protocolVersion: 1 as const, processInstanceId, ...account,
  originalLeaseVersion: 3, taskRequestHash: vector.requestHash, journalPhase: "central_started" as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" }
});

test("recovery accepts only a closed released response matching the exact claimed journal fence", async () => {
  const released = { kind: "released", actionId: task.actionId,
    taskRequestHash: task.taskRequestHash, originalLeaseVersion: 3, replayed: false };
  let body: unknown = released;
  const client = new DesktopCentralApiClient({ origin, buildManifestSha256,
    fetchImpl: async () => json(body) });
  const input = { ...reconcile, journalPhase: "claimed" as const };
  assert.deepEqual(await client.reconcile(context, task.actionId, input,
    { idempotencyKey: "release-after-sweep" }), released);
  for (body of [{ ...released, actionId: "other" }, { ...released, taskRequestHash: "b".repeat(64) },
    { ...released, originalLeaseVersion: 4 }, { ...released, receiptHash: vector.receiptHash },
    { ...released, taskToken }, { ...released, originalLeaseVersion: 0 },
    { ...released, taskRequestHash: undefined }, { ...released, state: "queued" }]) {
    await assert.rejects(client.reconcile(context, task.actionId, input,
      { idempotencyKey: "release-after-sweep" }), /central_response_invalid/);
  }
  body = released;
  for (const journal of [reconcile, { ...reconcile, journalPhase: "sidecar_completed" as const,
    receiptHash: vector.receiptHash }]) {
    await assert.rejects(client.reconcile(context, task.actionId, journal,
      { idempotencyKey: "release-with-started-journal" }), /central_response_invalid/);
  }
});

test("registration sends only its fixed transport and immutable Main build identity", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const config = { origin, buildManifestSha256,
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init }); return json(registered, 201);
    } };
  const client = new DesktopCentralApiClient(config);
  config.origin = "https://not-the-constructor-origin.com";
  config.buildManifestSha256 = "b".repeat(64);
  assert.deepEqual(await client.register(registration, options), registered);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${origin}/api/v1/acquisition/desktop-installations/register`);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), registration);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.redirect, "manual");
  assert.equal(calls[0].init?.credentials, "omit");
  assert.deepEqual(Object.fromEntries(new Headers(calls[0].init?.headers)), {
    accept: "application/json", "content-type": "application/json",
    "idempotency-key": options.idempotencyKey,
    "x-shensi-desktop-build-manifest-sha256": buildManifestSha256
  });
});

test("registration validates exact input, origin, workspace and closed response before trusting a device", async () => {
  for (const badOrigin of ["http://localhost:4321", "http://10.0.0.1:4321", `${origin}/x`,
    `${origin}/`, `${origin}?x=1`, "https://user:password@api.shensi.com", "https://api.shensi.com/#x"]) {
    assert.throws(() => new DesktopCentralApiClient({ origin: badOrigin, buildManifestSha256 }), /central_configuration_invalid/);
  }
  assert.throws(() => new DesktopCentralApiClient({ origin, buildManifestSha256: "X".repeat(64) }));
  let calls = 0;
  let body: unknown = registered;
  const client = new DesktopCentralApiClient({ origin, buildManifestSha256,
    fetchImpl: async () => { calls++; return json(body); } });
  for (const badInput of [{ ...registration, cookie: "secret" }, { ...registration, protocolVersion: 2 },
    { ...registration, enrollmentToken: "wrong" }]) {
    await assert.rejects(client.register(badInput as typeof registration, options), /central_request_invalid/);
  }
  await assert.rejects(client.register(registration, { ...options, idempotencyKey: " bad " }), /central_request_invalid/);
  await assert.rejects(client.register(registration, { ...options, headers: { cookie: "secret" } } as typeof options), /central_request_invalid/);
  assert.equal(calls, 0);
  for (body of [{ ...registered, workspaceId: "other" }, { ...registered, deviceToken: "bad" },
    { ...registered, profile: "private" }, { ...registered, protocolVersion: 2 }, null]) {
    await assert.rejects(client.register(registration, options), /central_response_invalid/);
  }
});

test("transport rejects redirects, oversized or malformed bodies and never exposes upstream secrets", async () => {
  const secret = "private-token-cookie-content";
  for (const [response, code] of [
    [new Response(null, { status: 302, headers: { location: `https://elsewhere.com/${secret}` } }), "central_redirect_rejected"],
    [new Response("x".repeat(65_537), { headers: { "content-type": "application/json" } }), "central_response_too_large"],
    [new Response(secret, { headers: { "content-type": "application/json" } }), "central_response_invalid"],
    [json({ error: secret }, 503), "central_http_503"],
    [new Response(secret, { status: 500 }), "central_http_500"],
    [new Response("<html>secret</html>", { headers: { "content-type": "text/html" } }), "central_response_invalid"],
    [json(registered, 202), "central_response_invalid"]
  ] as const) {
    let calls = 0;
    const client = new DesktopCentralApiClient({ origin, buildManifestSha256,
      fetchImpl: async () => { calls++; return response; } });
    await assert.rejects(client.register(registration, options), (error: Error) => {
      assert.equal(error.message, code);
      assert.equal(JSON.stringify(error).includes(secret), false);
      assert.equal(error.stack?.includes(secret), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("one ten-second budget covers hung fetch and body, and cancellation stays distinct", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const bodyStalls of [false, true]) {
    let cancelled = false;
    let requestSignal: AbortSignal | null | undefined;
    const client = new DesktopCentralApiClient({ origin, buildManifestSha256,
      fetchImpl: async (_url, init) => {
        requestSignal = init?.signal;
        return bodyStalls ? new Response(new ReadableStream({ cancel() { cancelled = true; } }),
          { headers: { "content-type": "application/json" } }) : new Promise<Response>(() => {});
      } });
    const result: { failure?: Error } = {};
    const failure = () => result.failure;
    const pending = client.register(registration, options).catch((error: Error) => { result.failure = error; });
    await nextTurn();
    t.mock.timers.tick(9_999); await nextTurn(); assert.equal(failure(), undefined);
    t.mock.timers.tick(1); await nextTurn();
    assert.equal(failure()?.message, "central_timeout");
    assert.equal(requestSignal?.aborted, true);
    if (bodyStalls) assert.equal(cancelled, true);
    await pending;
  }
  const abort = new AbortController(); let calls = 0;
  const client = new DesktopCentralApiClient({ origin, buildManifestSha256,
    fetchImpl: async () => { calls++; return new Promise<Response>(() => {}); } });
  const pending = client.register(registration, { ...options, signal: abort.signal });
  abort.abort(new Error("private abort reason"));
  await assert.rejects(pending, /central_cancelled/);
  await assert.rejects(client.register(registration, { ...options, signal: abort.signal }), /central_cancelled/);
  assert.equal(calls, 1);
});

test("claim, completion and recovery preserve frozen DTOs and method-specific capability headers", async () => {
  const claimed = { kind: "claimed", task, taskToken, serverTime: at, replayed: false };
  const responses: unknown[] = [claimed, completion, { kind: "waiting", retryAfterMs: 3000, replayed: false }];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new DesktopCentralApiClient({ origin, buildManifestSha256,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return json(responses.shift()); } });
  assert.deepEqual(await client.claim(context, claim, { idempotencyKey: "claim-key" }), claimed);
  assert.deepEqual(await client.complete(context, task.actionId, complete,
    { idempotencyKey: "start-key", taskToken }), completion);
  assert.deepEqual(await client.reconcile(context, task.actionId, reconcile,
    { idempotencyKey: "recover-key" }), { kind: "waiting", retryAfterMs: 3000, replayed: false });
  for (const [index, call] of calls.entries()) {
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("X-Shensi-Desktop-Build-Manifest-SHA256"), buildManifestSha256);
    assert.equal(headers.get("X-Shensi-Desktop-Installation-Id"), installationId);
    assert.equal(headers.get("X-Shensi-Desktop-Device-Token"), deviceToken);
    assert.equal(headers.get("X-Shensi-Desktop-Task-Token"), index === 1 ? taskToken : null);
    assert.equal(headers.has("cookie"), false); assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("X-Workspace-Id"), false);
    assert.equal(call.init?.credentials, "omit"); assert.equal(call.init?.redirect, "manual");
    assert.deepEqual(JSON.parse(String(call.init?.body)), [claim, complete, reconcile][index]);
  }
  assert.equal(calls[0].url, `${origin}/api/v1/acquisition/desktop-outreach-actions/claim`);
  assert.equal(calls[1].url, `${origin}/api/v1/acquisition/desktop-outreach-actions/${encodeURIComponent(task.actionId)}/complete`);
  assert.equal(calls[2].url, `${origin}/api/v1/acquisition/desktop-outreach-actions/${encodeURIComponent(task.actionId)}/reconcile`);
});

test("closed unions reject stale or invented authority before transport and uncorrelated tasks on receipt", async () => {
  let calls = 0; let response: unknown = {};
  const client = new DesktopCentralApiClient({ origin, buildManifestSha256,
    fetchImpl: async () => { calls++; return json(response); } });
  for (const input of [{ ...claim, taskToken }, { ...claim, processInstanceId: "wrong" },
    { ...claim, availableAccounts: [] }, { ...claim, waitSeconds: 1 },
    { ...claim, availableAccounts: [account, { ...account, loginStateVersion: 2 }] },
    { ...claim, availableAccounts: [{ ...account, loginStateVersion: 0 }] }]) {
    await assert.rejects(client.claim(context, input as typeof claim, { idempotencyKey: "claim-key" }), /central_request_invalid/);
  }
  await assert.rejects(client.claim({ ...context, cookie: "secret" } as typeof context, claim,
    { idempotencyKey: "claim-key" }), /central_request_invalid/);
  for (const [actionId, input, requestOptions] of [
    ["..", complete, { idempotencyKey: "start-key", taskToken }],
    ["/evil", complete, { idempotencyKey: "start-key", taskToken }],
    [task.actionId, complete, { idempotencyKey: "start-key" }],
    [task.actionId, { ...complete, command: { ...complete.command, loginStateVersion: undefined } }, { idempotencyKey: "start-key", taskToken }]
  ] as const) {
    await assert.rejects(client.complete(context, actionId, input as typeof complete,
      requestOptions as { idempotencyKey: string; taskToken: string }), /central_request_invalid/);
  }
  for (const input of [{ ...reconcile, receiptHash: buildManifestSha256 },
    { ...reconcile, journalPhase: "sidecar_completed" }, { ...reconcile, originalLeaseVersion: 0 },
    { ...reconcile, requestHash: buildManifestSha256 }]) {
    await assert.rejects(client.reconcile(context, task.actionId, input as typeof reconcile,
      { idempotencyKey: "recovery-key" }), /central_request_invalid/);
  }
  await assert.rejects(client.reconcile(context, task.actionId, reconcile,
    { idempotencyKey: "recovery-key", taskToken } as { idempotencyKey: string }), /central_request_invalid/);
  assert.equal(calls, 0);
  for (const badTask of [{ ...task, workspaceId: "other" }, { ...task, accountId: "other" },
    { ...task, executorBindingGeneration: 9 }, { ...task, loginStateVersion: 9 },
    { ...task, fence: {} }, { ...task, deadlineAt: "2026-09-05T00:00:00Z" }]) {
    response = { kind: "claimed", task: badTask, taskToken, serverTime: at, replayed: false };
    await assert.rejects(client.claim(context, claim, { idempotencyKey: "claim-key" }), /central_response_invalid/);
  }
  response = { ...completion, actionId: "other" };
  await assert.rejects(client.complete(context, task.actionId, complete,
    { taskToken, idempotencyKey: "start-key" }), /central_response_invalid/);
});

test("recovery handles every disposition and receipt commands remain disjoint and correlated", async () => {
  const { predecessorReceipt: _predecessor, leaseExpiresAt: _lease, ...common } = task;
  const recoveryTask = { ...common, leaseVersion: 4, originalLeaseVersion: 3,
    reconciliationGeneration: 1, capability: "reconcile_only" };
  let response: unknown;
  let calls = 0;
  const client = new DesktopCentralApiClient({ origin, buildManifestSha256,
    fetchImpl: async () => { calls++; return json(response); } });
  for (response of [{ kind: "waiting", retryAfterMs: 3000, replayed: false },
    { kind: "terminal", status: "succeeded", receiptHash: buildManifestSha256, replayed: true },
    { kind: "not_authorized", replayed: false },
    { kind: "reconcile", task: recoveryTask, taskToken, replayed: false }]) {
    assert.deepEqual(await client.reconcile(context, task.actionId, reconcile, { idempotencyKey: "recovery-key" }), response);
  }
  for (const bad of [{ ...recoveryTask, capability: "execute" }, { ...recoveryTask, originalLeaseVersion: 4 },
    { ...recoveryTask, taskRequestHash: "b".repeat(64) }, { ...recoveryTask, accountHandle: `dyacct_${"b".repeat(64)}` },
    { ...recoveryTask, taskToken }]) {
    response = { kind: "reconcile", task: bad, taskToken, replayed: false };
    await assert.rejects(client.reconcile(context, task.actionId, reconcile, { idempotencyKey: "recovery-key" }), /central_response_invalid/);
  }
  const succeeded = { actionId: task.actionId, state: "succeeded" as const,
    platformReceiptReference: "receipt-id", occurredAt: at, failureCode: null };
  const receiptCommand = { event: "receipt" as const, leaseVersion: 3, loginStateVersion: account.loginStateVersion,
    taskRequestHash: vector.requestHash, reconciliation: false, receipt: succeeded };
  response = { ...completion, state: "succeeded" };
  await client.complete(context, task.actionId, { ...complete, command: receiptCommand },
    { taskToken, idempotencyKey: "receipt-key" });
  const before = calls;
  for (const bad of [{ ...receiptCommand, receipt: { ...succeeded, actionId: "other" } },
    { ...receiptCommand, receipt: { ...succeeded, failureCode: "action_unavailable" } },
    { ...receiptCommand, receipt: { ...succeeded, state: "failed" } },
    { ...receiptCommand, reconciliation: true, receipt: { ...succeeded, state: "failed",
      failureCode: "douyin_profile_busy", platformReceiptReference: null } }]) {
    await assert.rejects(client.complete(context, task.actionId, { ...complete, command: bad } as Parameters<typeof client.complete>[2],
      { taskToken, idempotencyKey: "receipt-key" }), /central_request_invalid/);
  }
  assert.equal(calls, before);
  response = { kind: "empty", serverTime: at, retryAfterMs: 3000, replayed: true };
  assert.deepEqual(await client.claim(context, claim, { idempotencyKey: "claim-key" }), response);
});

test("logical retries retain the caller key without automatic retries and request bytes are bounded", async () => {
  let calls = 0; const keys: string[] = [];
  const client = new DesktopCentralApiClient({ origin, buildManifestSha256,
    fetchImpl: async (_url, init) => {
      calls++; keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
      if (calls === 1) throw new Error(`secret ${deviceToken}`);
      return json({ kind: "empty", serverTime: at, retryAfterMs: 3000, replayed: true });
    } });
  await assert.rejects(client.claim(context, claim, { idempotencyKey: "same-logical-key" }), /central_unreachable/);
  assert.equal(calls, 1);
  await client.claim(context, claim, { idempotencyKey: "same-logical-key" });
  assert.deepEqual(keys, ["same-logical-key", "same-logical-key"]);
  const huge = { ...claim, availableAccounts: Array.from({ length: 100 }, (_, index) => ({
    ...account, accountId: `${index}${"中".repeat(250)}` })) };
  await assert.rejects(client.claim(context, huge, { idempotencyKey: "too-large-key" }), /central_request_too_large/);
  assert.equal(calls, 2);
});

test("the full 64 KiB response budget counts streamed UTF-8 bytes and invalid encoding fails closed", async () => {
  const payload = JSON.stringify(registered);
  const bytes = new TextEncoder().encode(payload + " ".repeat(65_536 - Buffer.byteLength(payload)));
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes.slice(0, 32_768)); controller.enqueue(bytes.slice(32_768)); controller.close(); },
    cancel() { cancelled = true; }
  });
  let response = new Response(stream, { headers: { "content-type": "application/json; charset=utf-8" } });
  const client = new DesktopCentralApiClient({ origin, buildManifestSha256,
    fetchImpl: async () => response });
  assert.deepEqual(await client.register(registration, options), registered);
  assert.equal(cancelled, false);
  response = new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } });
  await assert.rejects(client.register(registration, options), /central_response_invalid/);
});

test("claim and recovery reject changed frozen content or noncanonical targets before the caller can start", async () => {
  let response: unknown;
  const client = new DesktopCentralApiClient({ origin, buildManifestSha256,
    fetchImpl: async () => json(response) });
  for (const vector of hashFixture.vectors) {
    const request = vector.request;
    const bound = { ...account, accountHandle: request.account_handle, loginStateVersion: request.login_state_version };
    const frozen = { ...task, actionId: request.action_id, accountHandle: request.account_handle,
      loginStateVersion: request.login_state_version, kind: request.kind,
      canonicalTargetPublicUrl: request.canonical_target_public_url, content: request.content,
      approvedContentHash: request.approved_content_hash, taskRequestHash: vector.requestHash };
    const { leaseExpiresAt: _lease, predecessorReceipt: _receipt, ...recovery } = frozen;
    const recoveryTask = { ...recovery, originalLeaseVersion: 3, reconciliationGeneration: 1, capability: "reconcile_only" };
    const claimInput = { ...claim, availableAccounts: [bound] };
    const recoverInput = { ...reconcile, ...bound, taskRequestHash: vector.requestHash };
    response = { kind: "claimed", task: frozen, taskToken, serverTime: at, replayed: false };
    assert.deepEqual(await client.claim(context, claimInput, { idempotencyKey: "fixture-claim" }), response);
    response = { kind: "reconcile", task: recoveryTask, taskToken, replayed: false };
    assert.deepEqual(await client.reconcile(context, frozen.actionId, recoverInput, { idempotencyKey: "fixture-recovery" }), response);
    for (const mutation of [
      { canonicalTargetPublicUrl: "javascript:alert(1)" },
      { canonicalTargetPublicUrl: `${request.canonical_target_public_url}#changed` },
      { canonicalTargetPublicUrl: "https://www.douyin.com/video/different" },
      { content: "changed-after-freeze" },
      { approvedContentHash: `sha256:${"c".repeat(64)}` },
      { taskRequestHash: "d".repeat(64) }
    ]) {
      response = { kind: "claimed", task: { ...frozen, ...mutation }, taskToken, serverTime: at, replayed: false };
      await assert.rejects(client.claim(context, claimInput, { idempotencyKey: "fixture-claim" }), /central_response_invalid/);
      response = { kind: "reconcile", task: { ...recoveryTask, ...mutation }, taskToken, replayed: false };
      await assert.rejects(client.reconcile(context, frozen.actionId, recoverInput, { idempotencyKey: "fixture-recovery" }), /central_response_invalid/);
    }
  }
});
