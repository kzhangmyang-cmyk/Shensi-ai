import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SidecarClient } from "../src/main/sidecar-client.ts";
import { accountKey } from "../src/main/desktop-ipc.ts";

const vectors = JSON.parse(await readFile(new URL("../../contracts/fixtures/desktop-outreach-hashes.v1.json", import.meta.url), "utf8"));
const vector = vectors.vectors[0];

test("cold identity recovery uses the same fixed ASCII and Unicode profile keys as Python", () => {
  assert.equal(accountKey("account-ascii-01"), "f7755efa1f580ce3b3e8fa5ec3c506a1b087af59bf773c9bc2a930028e397d3a");
  assert.equal(accountKey("账号-海外🚀"), "e389da1d759786cb22720b68e1e3096f0a6b50bc35815a2c211e535ad2e1654f");
});
function task(v = vector) {
  const r = v.request;
  return { actionId: r.action_id, accountHandle: r.account_handle,
    loginStateVersion: r.login_state_version, kind: r.kind,
    canonicalTargetPublicUrl: r.canonical_target_public_url, content: r.content,
    approvedContentHash: r.approved_content_hash, taskRequestHash: v.requestHash,
    deadlineAt: "2026-09-05T12:00:00.000Z" };
}
function harness(responses: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new SidecarClient({ origin: "http://127.0.0.1:4321", token: "s".repeat(43),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify(responses.shift()), { headers: { "content-type": "application/json" } });
    } });
  return { client, calls };
}

test("a rotated login can observe the original action but never enter the write endpoint", async () => {
  const { client, calls } = harness([vector.receipt]);
  const observation = { ...task(), observationLoginStateVersion: 8 };
  await client.reconcileDouyinAction(observation);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    ...vector.request, deadline_at: observation.deadlineAt,
    request_hash: vector.requestHash, observation_login_state_version: 8
  });
  await assert.rejects(client.executeDouyinAction(observation), /reconciliation_only/);
  assert.equal(calls.length, 1);
});

test("local action methods preserve canonical tasks and return exact cross-language receipt hashes", async () => {
  for (const v of vectors.vectors) {
    const { client, calls } = harness([v.receipt, v.receipt,
      { action_id: v.request.action_id, acknowledged_at: "2026-09-05T12:00:01.000Z" }]);
    const result = await client.executeDouyinAction(task(v));
    assert.deepEqual(result, { receipt: { actionId: v.receipt.action_id, state: v.receipt.state,
      platformReceiptReference: v.receipt.platform_receipt_reference,
      occurredAt: v.receipt.occurred_at, failureCode: v.receipt.failure_code }, receiptHash: v.receiptHash });
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      ...v.request, deadline_at: "2026-09-05T12:00:00.000Z", request_hash: v.requestHash });
    assert.deepEqual(await client.reconcileDouyinAction(task(v)), result);
    assert.ok(calls[1].url.endsWith(`/${v.request.action_id}/reconcile`));
    await client.acknowledgeDouyinAction(v.request.action_id, v.requestHash, v.receiptHash);
    assert.deepEqual(JSON.parse(String(calls[2].init.body)), { request_hash: v.requestHash, receipt_hash: v.receiptHash });
    for (const { init } of calls) {
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${"s".repeat(43)}`);
      assert.equal(init.redirect, "manual");
      assert.equal(init.method, "POST");
    }
  }
});

test("identity resolution validates the requested account and never returns filesystem or credential fields", async () => {
  const key = "a".repeat(64);
  const identity = { account_key: key, account_handle: vector.request.account_handle,
    account_display_name: "测试", login_state_version: 7, profile_available: true };
  const { client, calls } = harness([identity]);
  assert.deepEqual(await client.resolveDouyinIdentity(key), { accountKey: key,
    accountHandle: identity.account_handle, accountDisplayName: "测试", loginStateVersion: 7, profileAvailable: true });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { account_key: key });
  for (const bad of [{ ...identity, account_key: "b".repeat(64) },
    { ...identity, profile_path: "/private/profile" }, { ...identity, profile_available: false },
    { ...identity, account_handle: "wrong" }, { ...identity, login_state_version: 0 }]) {
    await assert.rejects(harness([bad]).client.resolveDouyinIdentity(key));
  }
});

test("invalid or changed frozen tasks fail before local network IO", async () => {
  const { client, calls } = harness([]);
  for (const bad of [{ ...task(), taskRequestHash: "0".repeat(64) },
    { ...task(), content: "changed" }, { ...task(), loginStateVersion: 8 },
    { ...task(), accountHandle: "wrong" }, { ...task(), actionId: ".." },
    ...vectors.rejectedTargets.map((v: any) => ({ ...task(), kind: v.kind, canonicalTargetPublicUrl: v.raw })),
    ...vectors.acceptedTargets.filter((v: any) => v.raw !== v.canonical)
      .map((v: any) => ({ ...task(), kind: v.kind, canonicalTargetPublicUrl: v.raw })),
    ...vectors.rejectedTimestamps.map((v: string) => ({ ...task(), deadlineAt: v }))]) {
    await assert.rejects(client.executeDouyinAction(bad));
  }
  assert.equal(calls.length, 0);
});

test("a matching hash cannot authorize a noncanonical or double-decoded target", async () => {
  const { client, calls } = harness([]);
  const badTargets = [...vectors.rejectedTargets, ...vectors.acceptedTargets.filter((v: any) => v.raw !== v.canonical),
    { kind: "comment", raw: "https://www.douyin.com/video/abc?x=?z=%252F" }];
  for (const v of badTargets) {
    const raw = { ...vector.request, kind: v.kind, canonical_target_public_url: v.raw };
    // Hash the supplied (invalid) bytes, not a production normalization helper.
    const suppliedHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
    await assert.rejects(client.executeDouyinAction({ ...task(), kind: v.kind,
      canonicalTargetPublicUrl: v.raw, taskRequestHash: suppliedHash }));
  }
  assert.equal(calls.length, 0);
});

test("unexpected receipt identities, timestamps, states and keys cannot become central completions", async () => {
  for (const receipt of [{ ...vector.receipt, action_id: "another-action" },
    { ...vector.receipt, state: "accepted" }, { ...vector.receipt, cookie: "secret" },
    { ...vector.receipt, state: "succeeded", failure_code: "action_unavailable" },
    { ...vector.receipt, state: "failed", failure_code: "unknown" },
    { ...vector.receipt, platform_receipt_reference: null },
    ...vectors.rejectedTimestamps.map((v: string) => ({ ...vector.receipt, occurred_at: v }))]) {
    await assert.rejects(harness([receipt]).client.executeDouyinAction(task()));
  }
});

test("only local action fields cross the Sidecar boundary, never central task capabilities", async () => {
  const { client, calls } = harness([vector.receipt]);
  await client.executeDouyinAction({ ...task(), taskToken: "secret-task", deviceToken: "secret-device",
    workspaceId: "tenant", executorBindingGeneration: 3 } as any);
  const body = String(calls[0].init.body);
  assert.ok(!body.includes("secret") && !body.includes("tenant") && !body.includes("executor"));
});

test("a central read-only recovery task cannot enter the local write method", async () => {
  const { client, calls } = harness([vector.receipt]);
  const recovery = { ...task(), capability: "reconcile_only" as const, originalLeaseVersion: 1, reconciliationGeneration: 1 };
  await assert.rejects(client.executeDouyinAction(recovery), /reconciliation_only/);
  assert.equal(calls.length, 0);
  await client.reconcileDouyinAction(recovery);
  assert.ok(calls[0].url.endsWith("/reconcile"));
});

test("acknowledgement accepts Python datetime precision but rejects mismatched identity and malformed time", async () => {
  for (const timestamp of ["2026-09-05T12:00:00Z", "2026-09-05T12:00:00.000Z", "2026-09-05T12:00:00.123456Z"]) {
    await harness([{ action_id: task().actionId, acknowledged_at: timestamp }]).client
      .acknowledgeDouyinAction(task().actionId, vector.requestHash, vector.receiptHash);
  }
  for (const value of [{ action_id: "other", acknowledged_at: "2026-09-05T12:00:00.000Z" },
    { action_id: task().actionId, acknowledged_at: "yesterday" },
    { action_id: task().actionId, acknowledged_at: "2026-02-30T12:00:00Z" }]) {
    await assert.rejects(harness([value]).client.acknowledgeDouyinAction(task().actionId, vector.requestHash, vector.receiptHash));
  }
});

test("cancellation while sending a local request is not mislabeled as a timeout", async () => {
  const controller = new AbortController();
  const client = new SidecarClient({ origin: "http://127.0.0.1:4321", token: "s".repeat(43),
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      controller.abort();
    }) });
  await assert.rejects(client.executeDouyinAction(task(), controller.signal), /sidecar_cancelled/);
});

test("already-cancelled actions issue no request, and cancellation during a response cancels the reader", async () => {
  const { client, calls } = harness([vector.receipt]);
  await assert.rejects(client.executeDouyinAction(task(), AbortSignal.abort()));
  assert.equal(calls.length, 0);
  let cancelCount = 0;
  const controller = new AbortController();
  const blocked = new SidecarClient({ origin: "http://127.0.0.1:4321", token: "s".repeat(43),
    fetch: async () => new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode("{")); queueMicrotask(() => controller.abort());
    }, cancel() { cancelCount++; } })) });
  await assert.rejects(blocked.executeDouyinAction(task(), controller.signal), /sidecar_cancelled/);
  assert.equal(cancelCount, 1);
});
