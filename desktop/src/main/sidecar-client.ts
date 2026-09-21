import type { DouyinCollectionPage, DouyinCollectionStatus, DouyinCollectionTask, DouyinLoginStatus } from "../shared/contracts.ts";
import { accountHandle, actionIdentifier, actionWireRequest, bareHash, acknowledgementTimestamp,
  mapActionReceipt, positiveVersion, strictObject, text, type LocalDouyinAction } from "./sidecar-outreach-protocol.ts";

export interface SidecarClientOptions {
  origin: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

export const SIDECAR_UPSTREAM_COMMIT = "d6f7c5bb906b6dac40ddf343ef9e26438a3de092";

export class SidecarRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Sidecar request failed (${status}): ${code.slice(0, 160)}`);
    this.name = "SidecarRequestError";
  }
}

export class SidecarClient {
  readonly #origin: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #requestTimeoutMs: number;

  constructor(options: SidecarClientOptions) {
    const origin = new URL(options.origin);
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port
      || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
      throw new TypeError("Sidecar origin must be a root loopback HTTP URL");
    if (typeof options.token !== "string" || options.token.length < 32 || /\s/u.test(options.token))
      throw new TypeError("Sidecar token is invalid");
    this.#origin = origin.origin;
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async health(signal?: AbortSignal): Promise<{ ok: true; service: "shensi-mediacrawler"; upstreamCommit: string }> {
    const value = obj(await this.#request("/internal/v1/health", {}, true, signal));
    if (Object.keys(value).sort().join(",") !== "ok,service,upstream_commit" || value.ok !== true
      || value.service !== "shensi-mediacrawler" || value.upstream_commit !== SIDECAR_UPSTREAM_COMMIT)
      throw new Error("Invalid Sidecar response");
    return { ok: true, service: "shensi-mediacrawler", upstreamCommit: SIDECAR_UPSTREAM_COMMIT };
  }

  async startDouyinLogin(accountKey: string): Promise<DouyinLoginStatus> {
    return mapLogin(await this.#request("/internal/v1/douyin/login-sessions", { method: "POST", body: JSON.stringify({ account_key: accountKey }) }));
  }

  async getDouyinLoginStatus(sessionId: string): Promise<DouyinLoginStatus> {
    return mapLogin(await this.#request(`/internal/v1/douyin/login-sessions/${encodeURIComponent(sessionId)}`));
  }

  async confirmDouyinLogin(sessionId: string): Promise<DouyinLoginStatus> {
    return this.getDouyinLoginStatus(sessionId);
  }

  async cancelDouyinLogin(sessionId: string): Promise<void> {
    await this.#request(`/internal/v1/douyin/login-sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }, false);
  }

  async startDouyinCollection(accountHandle: string, task: DouyinCollectionTask): Promise<DouyinCollectionStatus> {
    const body = { job_id: task.taskId, account_handle: accountHandle, login_state_version: task.loginStateVersion, keywords: task.keywords, max_videos: task.maxVideos, max_comments_per_video: task.maxCommentsPerVideo, ...(task.maxComments === undefined ? {} : { max_comments: task.maxComments }), max_pages_per_video: task.maxPagesPerVideo, collect_creators: task.collectCreators, collect_demand_comments: task.collectDemandComments, deadline_at: task.deadlineAt };
    return mapCollection(await this.#request("/internal/v1/douyin/crawl-jobs", { method: "POST", body: JSON.stringify(body) }));
  }

  async getDouyinCollectionStatus(taskId: string): Promise<DouyinCollectionStatus> {
    return mapCollection(await this.#request(`/internal/v1/douyin/crawl-jobs/${encodeURIComponent(taskId)}`));
  }

  async getDouyinCollectionResults(taskId: string, cursor: string | null): Promise<DouyinCollectionPage> {
    const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const value = obj(await this.#request(`/internal/v1/douyin/crawl-jobs/${encodeURIComponent(taskId)}/results${query}`));
    return { taskId: str(value.job_id), cursor: nullableStr(value.cursor), nextCursor: nullableStr(value.next_cursor), done: bool(value.done), records: array(value.records).map((entry) => {
      const record = obj(entry);
      return { recordId: str(record.record_id), kind: oneOf(record.kind, ["video", "creator", "comment"]), actorKind: nullableOneOf(record.actor_kind, ["creator", "commenter"]), canonicalUrl: str(record.canonical_url), publicDisplayName: str(record.public_display_name), publicProfileUrl: nullableStr(record.public_profile_url), textExcerpt: str(record.text_excerpt), sourceKeyword: str(record.source_keyword), observedAt: str(record.observed_at), contentHash: str(record.content_hash) };
    }) };
  }

  async cancelDouyinCollection(taskId: string): Promise<void> {
    await this.#request(`/internal/v1/douyin/crawl-jobs/${encodeURIComponent(taskId)}`, { method: "DELETE" }, false);
  }

  async controlDouyinCollection(taskId: string, action: "pause" | "resume" | "stop"): Promise<DouyinCollectionStatus> {
    return mapCollection(await this.#request(`/internal/v1/douyin/crawl-jobs/${encodeURIComponent(taskId)}/control/${action}`, { method: "POST" }));
  }

  async acknowledgeDouyinCollection(taskId: string): Promise<void> {
    const value = obj(await this.#request(
      `/internal/v1/douyin/crawl-jobs/${encodeURIComponent(taskId)}/acknowledgement`,
      { method: "POST" }
    ));
    if (Object.keys(value).sort().join(",") !== "acknowledged_at,job_id"
      || value.job_id !== taskId || typeof value.acknowledged_at !== "string"
      || !Number.isFinite(Date.parse(value.acknowledged_at))) {
      throw new Error("Invalid Sidecar response");
    }
  }

  async resolveDouyinIdentity(accountKey: string, signal?: AbortSignal) {
    bareHash(accountKey);
    const value = strictObject(await this.#request("/internal/v1/douyin/account-identities/resolve",
      { method: "POST", body: JSON.stringify({ account_key: accountKey }) }, true, signal),
    ["account_key", "account_handle", "account_display_name", "login_state_version", "profile_available"]);
    if (value.account_key !== accountKey || value.profile_available !== true) throw new Error("sidecar_identity_mismatch");
    return { accountKey, accountHandle: accountHandle(value.account_handle),
      accountDisplayName: text(value.account_display_name, 200),
      loginStateVersion: positiveVersion(value.login_state_version), profileAvailable: true as const };
  }

  async executeDouyinAction(task: LocalDouyinAction, signal?: AbortSignal) {
    if ("capability" in task || "observationLoginStateVersion" in task) throw new Error("sidecar_reconciliation_only");
    return this.#action(task, false, signal);
  }

  async reconcileDouyinAction(task: LocalDouyinAction, signal?: AbortSignal) {
    return this.#action(task, true, signal);
  }

  async #action(task: LocalDouyinAction, reconcile: boolean, signal?: AbortSignal) {
    const body = { ...actionWireRequest(task),
      ...(reconcile && task.observationLoginStateVersion !== undefined ? {
        observation_login_state_version: positiveVersion(task.observationLoginStateVersion)
      } : {}) };
    const path = `/internal/v1/douyin/actions/${encodeURIComponent(body.action_id)}${reconcile ? "/reconcile" : ""}`;
    // Unlike health/login reads, execution may wait for manual verification.
    // The central deadline is bounded; receipt transport gets 20 seconds more.
    const timeout = Math.max(1, Math.min(350_000, Date.parse(body.deadline_at) - Date.now() + 20_000));
    return mapActionReceipt(await this.#request(path,
      { method: "POST", body: JSON.stringify(body) }, true, signal, timeout), body.action_id);
  }

  async acknowledgeDouyinAction(actionId: string, requestHash: string, receiptHash: string, signal?: AbortSignal): Promise<void> {
    actionIdentifier(actionId); bareHash(requestHash); bareHash(receiptHash);
    const value = strictObject(await this.#request(`/internal/v1/douyin/actions/${encodeURIComponent(actionId)}/acknowledgement`,
      { method: "POST", body: JSON.stringify({ request_hash: requestHash, receipt_hash: receiptHash }) }, true, signal),
    ["action_id", "acknowledged_at"]);
    if (value.action_id !== actionId) throw new Error("sidecar_action_acknowledgement_mismatch");
    acknowledgementTimestamp(value.acknowledged_at);
  }

  async #request(path: string, init: RequestInit = {}, expectsJson = true, externalSignal?: AbortSignal,
    timeoutMs = this.#requestTimeoutMs): Promise<any> {
    if (externalSignal?.aborted) throw new SidecarRequestError(0, "sidecar_cancelled");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.#token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let response: Response;
    try { response = await this.#fetch(`${this.#origin}${path}`, { ...init, headers, signal: controller.signal, redirect: "manual" }); }
    catch { clearTimeout(timer); externalSignal?.removeEventListener("abort", abort); throw new SidecarRequestError(0, externalSignal?.aborted ? "sidecar_cancelled" : controller.signal.aborted ? "sidecar_timeout" : "sidecar_unreachable"); }
    try {
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) throw new SidecarRequestError(response.status, "sidecar_redirect_rejected");
      if (!response.ok) {
        await readBounded(response, 8_192, controller.signal).catch(() => undefined);
        throw new SidecarRequestError(response.status, `sidecar_http_${response.status}`);
      }
      if (!expectsJson || response.status === 204) return undefined;
      const text = await readBounded(response, path.includes("/results") ? 2_000_000 : 64_000, controller.signal);
      try { return JSON.parse(text); } catch { throw new SidecarRequestError(response.status, "sidecar_invalid_json"); }
    } catch (error) {
      if (controller.signal.aborted) throw new SidecarRequestError(0, externalSignal?.aborted ? "sidecar_cancelled" : "sidecar_timeout");
      throw error;
    } finally {
      clearTimeout(timer); externalSignal?.removeEventListener("abort", abort);
    }
  }
}

function mapLogin(input: unknown): DouyinLoginStatus {
  const value = obj(input); const diagnosticValue = value.diagnostic === null ? null : obj(value.diagnostic);
  return { sessionId: str(value.session_id), state: oneOf(value.state, ["awaiting_scan", "active", "expired", "failed"]), interactionSurface: oneOf(value.interaction_surface, ["external_window"]), runtimeState: oneOf(value.runtime_state, ["stopped", "starting", "running", "crashed"]), authState: oneOf(value.auth_state, ["unknown", "logged_out", "waiting_for_user", "verification_required", "authenticated", "expired"]), taskState: oneOf(value.task_state, ["idle", "preparing", "running", "cancelling", "completed", "failed"]), diagnostic: diagnosticValue === null ? null : { code: str(diagnosticValue.code), message: str(diagnosticValue.message), recoverable: bool(diagnosticValue.recoverable), occurredAt: str(diagnosticValue.occurred_at) }, expiresAt: str(value.expires_at), accountHandle: nullableStr(value.account_handle), accountDisplayName: nullableStr(value.account_display_name), loginStateVersion: nullableNum(value.login_state_version), failureCode: nullableStr(value.failure_code) };
}
function mapCollection(input: unknown): DouyinCollectionStatus { const value = obj(input); const activity = obj(value.activity); return { taskId: str(value.job_id), state: oneOf(value.state, ["queued", "running", "succeeded", "partial", "paused", "cancelled", "failed"]), createdAt: str(value.created_at), updatedAt: str(value.updated_at), completedAt: nullableStr(value.completed_at), acknowledgedAt: nullableStr(value.acknowledged_at), recordCount: num(value.record_count), ...(value.control_state === undefined ? {} : { controlState: oneOf(value.control_state, ["running", "pausing", "paused", "stopping"]) }), commentCount: value.comment_count == null ? null : num(value.comment_count), commentTarget: value.comment_target == null ? null : num(value.comment_target), pageCount: num(value.page_count), failureCode: nullableStr(value.failure_code), activity: { phase: oneOf(activity.phase, ["queued", "starting_browser", "opening_douyin", "searching", "collecting_comments", "finalizing", "completed"]), currentKeyword: nullableStr(activity.current_keyword), browserMode: oneOf(activity.browser_mode, ["visible", "headless"]), sequence: num(activity.sequence) } }; }

async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) { abort(); throw new SidecarRequestError(0, "sidecar_timeout"); }
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new SidecarRequestError(0, "sidecar_timeout");
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new SidecarRequestError(response.status, "sidecar_response_too_large"); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  const merged = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(merged);
}
function obj(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Sidecar response"); return value as Record<string, unknown>; }
function str(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid Sidecar response"); return value; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("Invalid Sidecar response"); return value; }
function num(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid Sidecar response"); return value; }
function nullableStr(value: unknown): string | null { return value === null ? null : str(value); }
function nullableNum(value: unknown): number | null { return value === null ? null : num(value); }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("Invalid Sidecar response"); return value; }
function oneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] { const parsed = str(value); if (!allowed.includes(parsed)) throw new Error("Invalid Sidecar response"); return parsed as T[number]; }
function nullableOneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | null { return value === null ? null : oneOf(value, allowed); }
