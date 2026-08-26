import type { components } from "../generated/ai-acquisition";
import { csrfFromCookie } from "./csrf";
import { AcquisitionHttpError } from "./douyin-automation-api";

export type OutreachBatch = components["schemas"]["AcquisitionOutreachBatch"];
export type OutreachBatchList = components["schemas"]["AcquisitionOutreachBatchList"];
export type OutreachActionList = components["schemas"]["AcquisitionOutreachActionList"];
export type OutreachAction = components["schemas"]["AcquisitionOutreachAction"];

export interface OutreachBatchApi {
  listBatches(runId: string, candidateId: string, limit?: number, cursor?: string | null, signal?: AbortSignal): Promise<OutreachBatchList>;
  createBatch(runId: string, candidateIds: string[], idempotencyKey: string, signal?: AbortSignal): Promise<OutreachBatch>;
  getBatch(batchId: string, signal?: AbortSignal): Promise<OutreachBatch>;
  updateBatch(batchId: string, candidates: Array<{ candidateId: string; selected: boolean; comment: string; directMessage: string }>, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<OutreachBatch>;
  approveBatch(batchId: string, revision: number, batchHash: string, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<OutreachBatch>;
  rejectBatch(batchId: string, reason: string, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<OutreachBatch>;
  pauseBatch(batchId: string, reason: string, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<OutreachBatch>;
  resumeBatch(batchId: string, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<OutreachBatch>;
  listActions(batchId: string, signal?: AbortSignal): Promise<OutreachActionList>;
}

function segment(value: string): string { return encodeURIComponent(value); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
type Validator = (value: unknown) => boolean;
type OutreachBatchCandidate = OutreachBatch["candidates"][number];

function closedShape(value: unknown, validators: Record<string, Validator>): boolean {
  if (!record(value)) return false;
  const keys = Object.keys(validators);
  return Object.keys(value).length === keys.length
    && keys.every((key) => key in value && validators[key]!(value[key]));
}
const boundedString = (minimum: number, maximum: number): Validator =>
  (value) => typeof value === "string" && value.length >= minimum && value.length <= maximum;
const boundedInteger = (minimum: number, maximum = Number.MAX_SAFE_INTEGER): Validator =>
  (value) => Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
const nullable = (validate: Validator): Validator => (value) => value === null || validate(value);
const sha256: Validator = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const dateTime: Validator = (value) => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  && Number.isFinite(Date.parse(value));
const uniqueArray = (minimum: number, maximum: number, validate: Validator): Validator =>
  (value) => Array.isArray(value) && value.length >= minimum && value.length <= maximum
    && value.every(validate) && new Set(value).size === value.length;

const candidateValidators = {
  candidateId: boundedString(1, 255),
  selected: (value) => typeof value === "boolean",
  candidateRevision: boundedInteger(1),
  evidenceHashes: uniqueArray(1, 20, sha256),
  draftRevision: boundedInteger(1),
  comment: boundedString(1, 300),
  commentHash: sha256,
  directMessage: boundedString(1, 800),
  directMessageHash: sha256,
  rationaleCodes: uniqueArray(1, 5, (value) => typeof value === "string"
    && ["evidence_grounded", "public_need_signal", "manual_review_required"].includes(value)),
  modelSnapshotId: boundedString(1, 255),
  sourceModelSnapshotId: boundedString(1, 255),
  contentHash: sha256
} satisfies Record<keyof OutreachBatchCandidate, Validator>;

const batchValidators = {
  id: boundedString(1, 255),
  workspaceId: boundedString(1, 255),
  runId: boundedString(1, 160),
  planId: boundedString(1, 160),
  planVersionId: boundedString(1, 160),
  planVersion: boundedInteger(1),
  planSnapshotHash: boundedString(1, 200),
  policyVersionId: boundedString(1, 255),
  policyHash: sha256,
  accountId: boundedString(1, 255),
  accountLoginStateVersion: boundedInteger(1),
  dailyBudgetId: sha256,
  localDate: (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value),
  dailyCandidateLimit: boundedInteger(1, 200),
  dailyRemainingLimit: boundedInteger(0, 200),
  revision: boundedInteger(1),
  etag: boundedString(1, 255),
  state: (value) => typeof value === "string"
    && ["awaiting_approval", "approved", "rejected", "paused"].includes(value),
  candidates: (value) => Array.isArray(value) && value.length >= 1 && value.length <= 200
    && value.every((candidate) => closedShape(candidate, candidateValidators)),
  batchHash: sha256,
  approvedBy: nullable(boundedString(0, 255)),
  approvedAt: nullable(dateTime),
  approvalHash: nullable(sha256),
  rejectedBy: nullable(boundedString(0, 255)),
  rejectedAt: nullable(dateTime),
  rejectionReason: nullable(boundedString(0, 2_000)),
  pauseReason: nullable(boundedString(0, 2_000)),
  createdBy: boundedString(1, 255),
  createdAt: dateTime,
  updatedBy: boundedString(1, 255),
  updatedAt: dateTime
} satisfies Record<keyof OutreachBatch, Validator>;

const batchListValidators = {
  items: (value) => Array.isArray(value) && value.length <= 50
    && value.every((item) => closedShape(item, batchValidators)),
  nextCursor: (value) => value === null
    || (typeof value === "string" && value.length <= 8_192)
} satisfies Record<keyof OutreachBatchList, Validator>;

export function createOutreachBatchApi(fetchImpl: typeof fetch = fetch, options: { cookie?: string; cookieSource?: () => string } = {}): OutreachBatchApi {
  const cookieSource = options.cookieSource ?? (() => options.cookie ?? (typeof document === "undefined" ? "" : document.cookie));
  async function request<T>(path: string, init: RequestInit, validate: (body: Record<string, unknown>) => boolean): Promise<T> {
    const response = await fetchImpl(path, { ...init, credentials: "same-origin", headers: { accept: "application/json", ...(init.headers ?? {}) } });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const root = record(body) ? body : {};
      const nested = record(root.error) ? root.error : {};
      throw new AcquisitionHttpError(response.status,
        typeof nested.code === "string" ? nested.code : `http_${response.status}`,
        typeof nested.message === "string" ? nested.message.slice(0, 300) : `请求失败（HTTP ${response.status}）`);
    }
    if (!record(body) || !validate(body) || /cookie|accountHandle|leaseToken|serviceSecret/iu.test(JSON.stringify(body))) {
      throw new AcquisitionHttpError(502, "malformed_response", "服务器返回了无法识别的数据");
    }
    return body as T;
  }
  const headers = (key: string, etag?: string) => ({
    "content-type": "application/json", "Idempotency-Key": key,
    "X-CSRF-Token": csrfFromCookie(cookieSource()), ...(etag ? { "If-Match": etag } : {})
  });
  const batchShape = (body: Record<string, unknown>) => closedShape(body, batchValidators);
  const batchListShape = (body: Record<string, unknown>) => closedShape(body, batchListValidators);
  const transition = (batchId: string, name: string, body: object, etag: string, key: string, signal?: AbortSignal) =>
    request<OutreachBatch>(`/api/v1/acquisition/outreach-batches/${segment(batchId)}/${name}`, {
      method: "POST", signal, headers: headers(key, etag), body: JSON.stringify(body)
    }, batchShape);
  return {
    listBatches(runId, candidateId, limit = 20, cursor = null, signal) {
      const query = new URLSearchParams({
        runId, candidateId, limit: String(limit)
      });
      if (cursor) query.set("cursor", cursor);
      return request(`/api/v1/acquisition/outreach-batches?${query}`, {
        method: "GET", signal
      }, batchListShape);
    },
    createBatch(runId, candidateIds, key, signal) {
      return request(`/api/v1/acquisition/runs/${segment(runId)}/outreach-batches`, {
        method: "POST", signal, headers: headers(key), body: JSON.stringify({ candidateIds: [...candidateIds] })
      }, batchShape);
    },
    getBatch(batchId, signal) {
      return request(`/api/v1/acquisition/outreach-batches/${segment(batchId)}`, { method: "GET", signal }, batchShape);
    },
    updateBatch(batchId, candidates, etag, key, signal) {
      const closed = candidates.map(({ candidateId, selected, comment, directMessage }) => ({ candidateId, selected, comment, directMessage }));
      return request(`/api/v1/acquisition/outreach-batches/${segment(batchId)}`, {
        method: "PUT", signal, headers: headers(key, etag), body: JSON.stringify({ candidates: closed })
      }, batchShape);
    },
    approveBatch(batchId, revision, batchHash, etag, key, signal) { return transition(batchId, "approve", { revision, batchHash, confirm: true }, etag, key, signal); },
    rejectBatch(batchId, reason, etag, key, signal) { return transition(batchId, "reject", reason ? { reason } : {}, etag, key, signal); },
    pauseBatch(batchId, reason, etag, key, signal) { return transition(batchId, "pause", reason ? { reason } : {}, etag, key, signal); },
    resumeBatch(batchId, etag, key, signal) { return transition(batchId, "resume", {}, etag, key, signal); },
    listActions(batchId, signal) {
      return request(`/api/v1/acquisition/outreach-batches/${segment(batchId)}/actions`, { method: "GET", signal },
        (body) => Array.isArray(body.items));
    }
  };
}
