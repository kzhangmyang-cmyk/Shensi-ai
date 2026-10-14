import assert from "node:assert/strict";
import test from "node:test";

import { SidecarClient } from "../src/main/sidecar-client.ts";

test("maps login and crawl DTOs between camelCase and snake_case", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    { session_id: "s1", state: "awaiting_scan", interaction_surface: "external_window", runtime_state: "running", auth_state: "waiting_for_user", task_state: "idle", diagnostic: null, expires_at: "2026-09-03T12:00:00Z", account_handle: null, account_display_name: null, login_state_version: null, failure_code: null },
    { job_id: "j1", state: "queued", created_at: "2026-09-03T10:00:00Z", updated_at: "2026-09-03T10:01:00Z", completed_at: null, acknowledged_at: null, record_count: 0, page_count: 0, failure_code: null, activity: { phase: "queued", current_keyword: null, browser_mode: "visible", sequence: 1 } },
    { job_id: "j1", cursor: null, next_cursor: null, done: true, records: [{ record_id: "r1", kind: "comment", actor_kind: "commenter", canonical_url: "https://douyin.com/x", public_display_name: "A", public_profile_url: null, text_excerpt: "x", source_keyword: "dust", observed_at: "2026-09-03T12:00:00Z", content_hash: "h" }] },
    { job_id: "j1", acknowledged_at: "2026-09-03T12:01:00Z" },
  ];
  const client = new SidecarClient({ origin: "http://127.0.0.1:4321", token: "s".repeat(32), fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
  }});
  const login = await client.startDouyinLogin("a".repeat(64));
  assert.equal(login.accountDisplayName, null);
  assert.equal(login.interactionSurface, "external_window");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { account_key: "a".repeat(64) });
  const task = await client.startDouyinCollection("acct", { taskId: "j1", loginStateVersion: 3, keywords: ["dust"], maxVideos: 2, maxCommentsPerVideo: 4, maxPagesPerVideo: 1, collectCreators: true, collectDemandComments: false, deadlineAt: "2026-09-03T12:00:00Z" });
  assert.equal(task.taskId, "j1");
  assert.equal(task.activity.browserMode, "visible");
  assert.equal(task.createdAt, "2026-09-03T10:00:00Z");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { job_id: "j1", account_handle: "acct", login_state_version: 3, keywords: ["dust"], max_videos: 2, max_comments_per_video: 4, max_pages_per_video: 1, collect_creators: true, collect_demand_comments: false, deadline_at: "2026-09-03T12:00:00Z" });
  const page = await client.getDouyinCollectionResults("j1", null);
  assert.equal(page.records[0]?.actorKind, "commenter");
  await client.acknowledgeDouyinCollection("j1");
  assert.equal(calls[3]?.url,
    "http://127.0.0.1:4321/internal/v1/douyin/crawl-jobs/j1/acknowledgement");
  assert.equal(calls[3]?.init?.method, "POST");
});

test("authenticates every call and reports bounded errors without leaking token", async () => {
  const token = "do-not-leak".repeat(4);
  let auth = "";
  const client = new SidecarClient({ origin: "http://127.0.0.1:1", token, fetch: async (_url, init) => {
    auth = String(new Headers(init?.headers).get("authorization"));
    return new Response(JSON.stringify({ detail: "denied" }), { status: 401 });
  }});
  await assert.rejects(client.getDouyinLoginStatus("s1"), (error: Error) => !error.message.includes(token) && error.message.includes("401"));
  assert.equal(auth, `Bearer ${token}`);
});

test("preserves and URL-encodes Sidecar URL-safe login identifiers", async () => {
  const sessionId = "_6NYK8JUrP5FTmGHATnkQsFI8oBhjR6V";
  const urls: string[] = [];
  const response = { session_id: sessionId, state: "awaiting_scan",
    interaction_surface: "external_window", runtime_state: "running",
    auth_state: "waiting_for_user", task_state: "idle", diagnostic: null,
    expires_at: "2026-09-03T12:00:00Z", account_handle: null,
    account_display_name: null, login_state_version: null, failure_code: null };
  const client = new SidecarClient({ origin: "http://127.0.0.1:4321", token: "s".repeat(32),
    fetch: async (url, init) => {
      urls.push(String(url));
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(response), { status: 200,
          headers: { "content-type": "application/json" } });
    } });
  assert.equal((await client.startDouyinLogin("a".repeat(64))).sessionId, sessionId);
  assert.equal((await client.getDouyinLoginStatus(sessionId)).sessionId, sessionId);
  assert.equal((await client.confirmDouyinLogin(sessionId)).sessionId, sessionId);
  await client.cancelDouyinLogin(sessionId);
  assert.deepEqual(urls.slice(1), Array(3).fill(
    `http://127.0.0.1:4321/internal/v1/douyin/login-sessions/${sessionId}`));
});

test("accepts only root loopback HTTP origins and exact pinned health", async () => {
  for (const origin of ["https://127.0.0.1:1", "http://localhost:1", "http://127.0.0.1:1/path", "http://user@127.0.0.1:1"])
    assert.throws(() => new SidecarClient({ origin, token: "x".repeat(32) }));
  const client = new SidecarClient({ origin: "http://127.0.0.1:1234", token: "x".repeat(32), fetch: async () =>
    new Response(JSON.stringify({ ok: true, service: "shensi-mediacrawler", upstream_commit: "wrong" })) });
  await assert.rejects(client.health(), /Invalid Sidecar response/);
});

test("times out hung fetches and caps response bodies", async () => {
  const hung = new SidecarClient({ origin: "http://127.0.0.1:1234", token: "x".repeat(32), requestTimeoutMs: 20,
    fetch: async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) });
  await assert.rejects(hung.health(), (error: Error) => error.message.includes("sidecar_timeout"));
  const oversized = new SidecarClient({ origin: "http://127.0.0.1:1234", token: "x".repeat(32), fetch: async () =>
    new Response("x".repeat(70_000), { status: 200, headers: { "content-type": "application/json" } }) });
  await assert.rejects(oversized.getDouyinLoginStatus("s"), /response_too_large/);
});
