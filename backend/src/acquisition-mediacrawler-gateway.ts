import { z } from "zod";

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LOGIN_CREATION_TIMEOUT_MS = 35_000;
export const MEDIACRAWLER_PINNED_UPSTREAM_COMMIT = "d6f7c5bb906b6dac40ddf343ef9e26438a3de092" as const;

const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("shensi-mediacrawler"),
  upstream_commit: z.literal(MEDIACRAWLER_PINNED_UPSTREAM_COMMIT)
}).strict();
const loginSessionResponseSchema = z.object({
  session_id: z.string().min(1),
  state: z.enum(["awaiting_scan", "active", "expired", "failed"]),
  qr_image_data_url: z.string().startsWith("data:image/").nullable(),
  expires_at: z.string().datetime(),
  account_handle: z.string().min(1).nullable(),
  account_display_name: z.string().nullable(),
  login_state_version: z.number().int().positive().nullable()
}).strict();
const crawlJobStateSchema = z.enum(["queued", "running", "succeeded", "partial", "paused", "cancelled", "failed"]);
const crawlerActivitySchema = z.object({
  phase: z.enum(["queued", "starting_browser", "opening_douyin", "searching",
    "collecting_comments", "finalizing", "completed"]),
  current_keyword: z.string().min(1).nullable(),
  browser_mode: z.enum(["visible", "headless"]),
  sequence: z.number().int().nonnegative()
}).strict();
const crawlJobResponseSchema = z.object({
  job_id: z.string().min(1), state: crawlJobStateSchema,
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
  acknowledged_at: z.string().datetime().nullable(),
  record_count: z.number().int().nonnegative(),
  page_count: z.number().int().nonnegative(),
  failure_code: z.string().regex(/^[a-z0-9_]{1,100}$/u).nullable(),
  activity: crawlerActivitySchema.optional()
}).strict().superRefine((value, context) => {
  if (!value.activity && !["succeeded", "partial"].includes(value.state)) {
    context.addIssue({ code: "custom", message: "missing_live_crawler_activity" });
  }
});
const crawlJobAcknowledgementSchema = z.object({
  job_id: z.string().min(1),
  acknowledged_at: z.string().datetime()
}).strict();
const douyinActorProfileSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname === "www.douyin.com"
    && url.port === "" && url.search === "" && url.hash === ""
    && /^\/user\/[A-Za-z0-9_-]{1,300}$/u.test(url.pathname);
}, "invalid_douyin_actor_profile");
const normalizedRecordSchema = z.object({
  record_id: z.string().min(1), kind: z.enum(["video", "creator", "comment"]),
  actor_kind: z.enum(["creator", "commenter"]).nullable(),
  canonical_url: z.string().url().startsWith("https://www.douyin.com/"),
  public_display_name: z.string().max(200), public_profile_url: douyinActorProfileSchema.nullable(),
  text_excerpt: z.string().max(500), source_keyword: z.string().max(100),
  observed_at: z.string().datetime(), content_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/u)
}).strict().superRefine((record, context) => {
  const valid = record.kind === "video"
    ? record.actor_kind === null
    : record.kind === "creator"
      ? record.actor_kind === "creator" && record.public_profile_url !== null
      : record.actor_kind === "commenter" && record.public_profile_url !== null;
  if (!valid) context.addIssue({ code: "custom", message: "invalid_douyin_actor_binding" });
});
const crawlPageResponseSchema = z.object({
  job_id: z.string().min(1), cursor: z.string().nullable(), next_cursor: z.string().nullable(),
  done: z.boolean(), records: z.array(normalizedRecordSchema).max(200)
}).strict();
const actionReceiptResponseSchema = z.object({
  action_id: z.string().min(1), state: z.enum(["succeeded", "failed"]),
  platform_receipt_reference: z.string().min(1).max(255).nullable(),
  occurred_at: z.string().datetime(),
  failure_code: z.enum(["action_unavailable", "action_rejected", "deadline_exceeded",
    "douyin_verification_required", "douyin_rate_limited", "douyin_account_warning",
    "douyin_login_expired", "douyin_action_control_missing", "douyin_action_control_ambiguous",
    "douyin_action_content_mismatch", "douyin_action_receipt_ambiguous",
    "douyin_action_timeout"]).nullable()
}).strict().superRefine((value, context) => {
  const valid = value.state === "succeeded"
    ? value.platform_receipt_reference !== null && value.failure_code === null
    : value.platform_receipt_reference === null && value.failure_code !== null;
  if (!valid) context.addIssue({ code: "custom", message: "invalid_action_receipt" });
});

type GatewayCode = "mediacrawler_unavailable" | "mediacrawler_invalid_response";

class MediaCrawlerGatewayError extends Error {
  readonly code: GatewayCode;

  constructor(code: GatewayCode) {
    super(code);
    this.name = "MediaCrawlerGatewayError";
    this.code = code;
  }
}

export interface DouyinMediaCrawlerGateway {
  health(signal?: AbortSignal): Promise<Readonly<{
    ok: true;
    service: "shensi-mediacrawler";
    upstreamCommit: typeof MEDIACRAWLER_PINNED_UPSTREAM_COMMIT;
  }>>;
  createLoginSession(signal?: AbortSignal): Promise<DouyinLoginSession>;
  getLoginSession(sessionId: string, signal?: AbortSignal): Promise<DouyinLoginSession>;
  disconnectLoginSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  startCrawlJob(input: DouyinCrawlJobInput, signal?: AbortSignal): Promise<DouyinCrawlJob>;
  findCrawlJob(jobId: string, signal?: AbortSignal): Promise<DouyinCrawlJob | null>;
  getCrawlJob(jobId: string, signal?: AbortSignal): Promise<DouyinCrawlJob>;
  getCrawlResults(jobId: string, cursor: string | null, signal?: AbortSignal): Promise<DouyinCrawlJobPage>;
  acknowledgeCrawlJob(jobId: string, signal?: AbortSignal): Promise<Readonly<{
    jobId: string;
    acknowledgedAt: string;
  }>>;
  cancelCrawlJob(jobId: string, signal?: AbortSignal): Promise<void>;
  executeAction(input: import("./acquisition-outreach-action-worker.js").OutreachActionExecutionRequest,
    signal?: AbortSignal): Promise<import("./acquisition-outreach-action-worker.js").OutreachActionExecutionReceipt>;
}

export interface DouyinCrawlJobInput {
  jobId: string; accountHandle: string; loginStateVersion: number; keywords: string[];
  maxVideos: number; maxCommentsPerVideo: number; maxPagesPerVideo: number; deadlineAt: string;
  collectCreators: boolean; collectDemandComments: boolean;
}
export interface DouyinCrawlJob {
  jobId: string;
  state: z.infer<typeof crawlJobStateSchema>;
  recordCount: number;
  pageCount: number;
  failureCode: string | null;
  activity: import("./acquisition-crawler-job.js").AcquisitionCrawlerActivity;
}
export interface DouyinCrawlJobPage {
  jobId: string; cursor: string | null; nextCursor: string | null; done: boolean;
  records: import("./acquisition-crawler-job.js").NormalizedDouyinRecord[];
}

export interface DouyinLoginSession {
  sessionId: string;
  state: "awaiting_scan" | "active" | "expired" | "failed";
  qrImageDataUrl: string | null;
  expiresAt: string;
  accountHandle: string | null;
  accountDisplayName: string | null;
  loginStateVersion: number | null;
}

export interface DouyinMediaCrawlerGatewayOptions {
  baseUrl: string;
  serviceSecret: string;
  timeoutMs?: number;
  loginCreationTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function isPrivateHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const privateIpv4 = /^(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/u.test(host);
  const privateIpv6 = host === "::1" || /^f[cd][0-9a-f:]*$/u.test(host) || /^fe[89ab][0-9a-f:]*$/u.test(host);
  if (url.protocol !== "http:" || url.username || url.password || !(host === "localhost" || privateIpv4 || privateIpv6)) {
    throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
  }
  return url;
}

function normalizedSecret(value: string): string {
  if (/\s/u.test(value) || Buffer.byteLength(value, "utf8") < 32) {
    throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
  }
  return value;
}

function requestAbortSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }
  const timeout = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
}

async function responseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createDouyinMediaCrawlerGateway(
  options: DouyinMediaCrawlerGatewayOptions
): DouyinMediaCrawlerGateway {
  const baseUrl = isPrivateHttpUrl(options.baseUrl);
  const serviceSecret = normalizedSecret(options.serviceSecret);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const loginCreationTimeoutMs = options.loginCreationTimeoutMs
    ?? DEFAULT_LOGIN_CREATION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0
    || !Number.isFinite(loginCreationTimeoutMs)
    || loginCreationTimeoutMs <= 0) {
    throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  async function loginSessionRequest(
    method: "GET" | "POST", path: string, signal?: AbortSignal
  ): Promise<DouyinLoginSession> {
    const request = requestAbortSignal(
      signal,
      method === "POST" ? loginCreationTimeoutMs : timeoutMs,
    );
    try {
      if (request.signal.aborted) throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
      const response = await fetchImpl(new URL(path, baseUrl), {
        method,
        headers: { authorization: `Bearer ${serviceSecret}` },
        signal: request.signal
      });
      if (!response.ok) throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
      let body: unknown;
      try { body = JSON.parse(await responseText(response)); } catch (error) {
        if (error instanceof MediaCrawlerGatewayError) throw error;
        throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
      }
      const parsed = loginSessionResponseSchema.safeParse(body);
      if (!parsed.success) throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
      return Object.freeze({
        sessionId: parsed.data.session_id, state: parsed.data.state,
        qrImageDataUrl: parsed.data.qr_image_data_url, expiresAt: parsed.data.expires_at,
        accountHandle: parsed.data.account_handle,
        accountDisplayName: parsed.data.account_display_name,
        loginStateVersion: parsed.data.login_state_version
      });
    } catch (error) {
      if (error instanceof MediaCrawlerGatewayError) throw error;
      throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
    } finally { request.dispose(); }
  }

  async function jsonRequest(method: "GET" | "POST", path: string, body: unknown,
                             signal?: AbortSignal, allowNotFound = false) {
    const request = requestAbortSignal(signal, timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, baseUrl), {
        method, headers: { authorization: `Bearer ${serviceSecret}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: request.signal
      });
      if (allowNotFound && response.status === 404) return null;
      if (!response.ok) throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
      try { return JSON.parse(await responseText(response)) as unknown; }
      catch (error) { if (error instanceof MediaCrawlerGatewayError) throw error; throw new MediaCrawlerGatewayError("mediacrawler_invalid_response"); }
    } catch (error) { if (error instanceof MediaCrawlerGatewayError) throw error; throw new MediaCrawlerGatewayError("mediacrawler_unavailable"); }
    finally { request.dispose(); }
  }

  function crawlJob(value: unknown): DouyinCrawlJob {
    const parsed = crawlJobResponseSchema.safeParse(value);
    if (!parsed.success) throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
    const activity = parsed.data.activity ?? {
      phase: "completed" as const,
      current_keyword: null,
      browser_mode: "headless" as const,
      sequence: 1
    };
    return Object.freeze({
      jobId: parsed.data.job_id,
      state: parsed.data.state,
      recordCount: parsed.data.record_count,
      pageCount: parsed.data.page_count,
      failureCode: parsed.data.failure_code,
      activity: {
        phase: activity.phase,
        currentKeyword: activity.current_keyword,
        browserMode: activity.browser_mode,
        sequence: activity.sequence
      }
    });
  }

  return Object.freeze({
    createLoginSession(signal?: AbortSignal) {
      return loginSessionRequest("POST", "/internal/v1/douyin/login-sessions", signal);
    },
    getLoginSession(sessionId: string, signal?: AbortSignal) {
      return loginSessionRequest("GET", `/internal/v1/douyin/login-sessions/${encodeURIComponent(sessionId)}`, signal);
    },
    async disconnectLoginSession(sessionId: string, signal?: AbortSignal) {
      const request = requestAbortSignal(signal, timeoutMs);
      try {
        const response = await fetchImpl(new URL(`/internal/v1/douyin/login-sessions/${encodeURIComponent(sessionId)}`, baseUrl), { method: "DELETE", headers: { authorization: `Bearer ${serviceSecret}` }, signal: request.signal });
        if (!response.ok && response.status !== 404) throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
      } catch (error) { if (error instanceof MediaCrawlerGatewayError) throw error; throw new MediaCrawlerGatewayError("mediacrawler_unavailable"); } finally { request.dispose(); }
    },
    async startCrawlJob(input: DouyinCrawlJobInput, signal?: AbortSignal) {
      return crawlJob(await jsonRequest("POST", "/internal/v1/douyin/crawl-jobs", {
        job_id: input.jobId, account_handle: input.accountHandle,
        login_state_version: input.loginStateVersion, keywords: input.keywords,
        max_videos: input.maxVideos, max_comments_per_video: input.maxCommentsPerVideo,
        max_pages_per_video: input.maxPagesPerVideo,
        collect_creators: input.collectCreators,
        collect_demand_comments: input.collectDemandComments,
        deadline_at: input.deadlineAt
      }, signal));
    },
    async findCrawlJob(jobId: string, signal?: AbortSignal) {
      const value = await jsonRequest(
        "GET",
        `/internal/v1/douyin/crawl-jobs/${encodeURIComponent(jobId)}`,
        null,
        signal,
        true
      );
      return value === null ? null : crawlJob(value);
    },
    async getCrawlJob(jobId: string, signal?: AbortSignal) {
      return crawlJob(await jsonRequest("GET", `/internal/v1/douyin/crawl-jobs/${encodeURIComponent(jobId)}`, null, signal));
    },
    async getCrawlResults(jobId: string, cursor: string | null, signal?: AbortSignal) {
      const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
      const parsed = crawlPageResponseSchema.safeParse(await jsonRequest("GET", `/internal/v1/douyin/crawl-jobs/${encodeURIComponent(jobId)}/results${query}`, null, signal));
      if (!parsed.success) throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
      return Object.freeze({
        jobId: parsed.data.job_id, cursor: parsed.data.cursor, nextCursor: parsed.data.next_cursor,
        done: parsed.data.done, records: parsed.data.records.map((record) => Object.freeze({
          recordId: record.record_id, kind: record.kind, actorKind: record.actor_kind,
          canonicalUrl: record.canonical_url,
          publicDisplayName: record.public_display_name, publicProfileUrl: record.public_profile_url,
          textExcerpt: record.text_excerpt, sourceKeyword: record.source_keyword,
          observedAt: record.observed_at, contentHash: record.content_hash
        }))
      });
    },
    async acknowledgeCrawlJob(jobId: string, signal?: AbortSignal) {
      const parsed = crawlJobAcknowledgementSchema.safeParse(await jsonRequest(
        "POST",
        `/internal/v1/douyin/crawl-jobs/${encodeURIComponent(jobId)}/acknowledgement`,
        null,
        signal
      ));
      if (!parsed.success || parsed.data.job_id !== jobId) {
        throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
      }
      return Object.freeze({
        jobId: parsed.data.job_id,
        acknowledgedAt: parsed.data.acknowledged_at
      });
    },
    async cancelCrawlJob(jobId: string, signal?: AbortSignal) {
      const request = requestAbortSignal(signal, timeoutMs);
      try {
        const response = await fetchImpl(new URL(`/internal/v1/douyin/crawl-jobs/${encodeURIComponent(jobId)}`, baseUrl), {
          method: "DELETE", headers: { authorization: `Bearer ${serviceSecret}` }, signal: request.signal
        });
        if (!response.ok && response.status !== 404) throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
      } finally { request.dispose(); }
    },
    async executeAction(input: import("./acquisition-outreach-action-worker.js").OutreachActionExecutionRequest,
      signal?: AbortSignal) {
      const parsed = actionReceiptResponseSchema.safeParse(await jsonRequest("POST",
        `/internal/v1/douyin/actions/${encodeURIComponent(input.actionId)}`, {
          action_id: input.actionId, account_handle: input.accountHandle,
          login_state_version: input.loginStateVersion, kind: input.kind,
          target_public_url: input.targetPublicUrl, content: input.content,
          deadline_at: input.deadlineAt, approved_content_hash: input.approvedContentHash
        }, signal));
      if (!parsed.success || parsed.data.action_id !== input.actionId) {
        throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
      }
      return Object.freeze({ actionId: parsed.data.action_id, state: parsed.data.state,
        platformReceiptReference: parsed.data.platform_receipt_reference,
        occurredAt: parsed.data.occurred_at, failureCode: parsed.data.failure_code });
    },
    async health(signal?: AbortSignal) {
      const request = requestAbortSignal(signal, timeoutMs);
      try {
        if (request.signal.aborted) {
          throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
        }
        const response = await fetchImpl(new URL("/internal/v1/health", baseUrl), {
          headers: { authorization: `Bearer ${serviceSecret}` },
          signal: request.signal
        });
        if (!response.ok) throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
        let body: unknown;
        try {
          body = JSON.parse(await responseText(response));
        } catch (error) {
          if (error instanceof MediaCrawlerGatewayError) throw error;
          throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
        }
        const parsed = healthResponseSchema.safeParse(body);
        if (!parsed.success) throw new MediaCrawlerGatewayError("mediacrawler_invalid_response");
        return Object.freeze({
          ok: parsed.data.ok,
          service: parsed.data.service,
          upstreamCommit: parsed.data.upstream_commit
        });
      } catch (error) {
        if (error instanceof MediaCrawlerGatewayError) throw error;
        throw new MediaCrawlerGatewayError("mediacrawler_unavailable");
      } finally {
        request.dispose();
      }
    }
  });
}
