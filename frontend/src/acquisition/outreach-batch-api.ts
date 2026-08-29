import type { components, operations } from "../generated/ai-acquisition";
import { csrfFromCookie } from "./csrf";
import { AcquisitionHttpError } from "./douyin-automation-api";

export type OutreachBatch = components["schemas"]["AcquisitionOutreachBatch"];
export type OutreachBatchList = components["schemas"]["AcquisitionOutreachBatchList"];
export type OutreachActionList = components["schemas"]["AcquisitionOutreachActionList"];
export type OutreachAction = components["schemas"]["AcquisitionOutreachAction"];
export type DirectMessageApprovalCommand = operations["approveAcquisitionOutreachBatchDirectMessages"]["requestBody"]["content"]["application/json"];

export interface OutreachBatchApi {
  listBatches(runId: string, candidateId: string, limit?: number, cursor?: string | null, signal?: AbortSignal): Promise<OutreachBatchList>;
  createBatch(runId: string, candidateIds: string[], idempotencyKey: string, signal?: AbortSignal): Promise<OutreachBatch>;
  getBatch(batchId: string, signal?: AbortSignal): Promise<OutreachBatch>;
  updateBatch(batchId: string, candidates: Array<{ candidateId: string; selected: boolean; comment: string; directMessage: string }>, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<OutreachBatch>;
  approveBatch(batchId: string, revision: number, batchHash: string, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<OutreachBatch>;
  approveDirectMessages?(batchId: string, command: DirectMessageApprovalCommand, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<OutreachBatch>;
  rejectBatch(batchId: string, reason: string, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<OutreachBatch>;
  pauseBatch(batchId: string, reason: string, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<OutreachBatch>;
  resumeBatch(batchId: string, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<OutreachBatch>;
  listActions(batchId: string, signal?: AbortSignal): Promise<OutreachActionList>;
  reconcileAction?(batchId: string, action: Pick<OutreachAction,
    "id" | "batchRevision" | "approvalHash" | "contentHash">,
    idempotencyKey: string, signal?: AbortSignal): Promise<OutreachAction>;
}

function segment(value: string): string { return encodeURIComponent(value); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
type Validator = (value: unknown) => boolean;
type OutreachBatchCandidate = OutreachBatch["candidates"][number];
type OutreachActionItem = OutreachActionList["items"][number];

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
const dateTime: Validator = (value) => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day >= 1 && day <= daysInMonth;
};
const uniqueArray = (minimum: number, maximum: number, validate: Validator): Validator =>
  (value) => Array.isArray(value) && value.length >= minimum && value.length <= maximum
    && value.every(validate) && new Set(value).size === value.length;
const douyinProfileUrl: Validator = (value) => typeof value === "string"
  && /^https:\/\/www\.douyin\.com\/user\/[A-Za-z0-9_-]{1,300}$/u.test(value);
const douyinVideoUrl: Validator = (value) => typeof value === "string"
  && /^https:\/\/www\.douyin\.com\/video\/[A-Za-z0-9_-]{1,300}$/u.test(value);

const candidateValidators = {
  candidateId: boundedString(1, 255),
  selected: (value) => typeof value === "boolean",
  candidateRevision: boundedInteger(1),
  evidenceHashes: uniqueArray(1, 20, sha256),
  publicProfileUrl: douyinProfileUrl,
  commentTargetPublicUrl: douyinVideoUrl,
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

const actionFailureCodes = new Set([
  "action_unavailable", "action_rejected", "approval_authority_changed", "predecessor_failed", "account_risk_paused", "deadline_exceeded",
  "douyin_verification_required", "douyin_rate_limited",
  "douyin_account_warning", "douyin_account_identity_changed",
  "douyin_login_expired",
  "douyin_direct_message_unavailable", "douyin_action_control_missing",
  "douyin_action_control_ambiguous", "douyin_action_content_mismatch",
  "douyin_action_receipt_ambiguous", "douyin_action_timeout"
]);
const actionValidators = {
  id: boundedString(1, 255),
  workspaceId: boundedString(1, 255),
  batchId: boundedString(1, 255),
  batchRevision: boundedInteger(1),
  candidateId: boundedString(1, 255),
  accountId: boundedString(1, 255),
  accountLoginStateVersion: boundedInteger(1),
  policyVersionId: boundedString(1, 255),
  localDate: (value) => typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/u.test(value),
  kind: (value) => value === "comment" || value === "direct_message",
  sequence: (value) => value === 1 || value === 2,
  status: (value) => typeof value === "string" && [
    "queued", "blocked_by_predecessor", "executing", "succeeded", "failed",
    "risk_paused"
  ].includes(value),
  predecessorActionId: nullable(boundedString(1, 255)),
  targetPublicUrl: boundedString(1, 2_000),
  content: boundedString(1, 800),
  contentHash: sha256,
  approvalHash: sha256,
  createdAt: dateTime,
  attemptCount: boundedInteger(0),
  platformReceiptReference: nullable(boundedString(1, 255)),
  occurredAt: nullable(dateTime),
  failureCode: nullable((value) => typeof value === "string"
    && actionFailureCodes.has(value))
} satisfies Record<Exclude<keyof OutreachActionItem,
  "authorizationVersion" | "approvedBy" | "approvedAt"
  | "directMessageDailyLimit" | "directMessageDailyOrdinal">, Validator>;
const directMessageAuthorizationValidators = {
  authorizationVersion: (value) => value === 2,
  approvedBy: boundedString(1, 255),
  approvedAt: dateTime,
  directMessageDailyLimit: boundedInteger(1, 100),
  directMessageDailyOrdinal: boundedInteger(1, 100)
} satisfies Record<
  "authorizationVersion" | "approvedBy" | "approvedAt"
  | "directMessageDailyLimit" | "directMessageDailyOrdinal",
  Validator
>;
const actionValidatorMap: Record<string, Validator> = actionValidators;
const directMessageAuthorizationValidatorMap: Record<string, Validator> =
  directMessageAuthorizationValidators;
const actionShape = (value: unknown): boolean => {
  if (!record(value)) return false;
  const baseKeys = Object.keys(actionValidators);
  const authorizationKeys = Object.keys(directMessageAuthorizationValidators);
  const hasAuthorizationMetadata = authorizationKeys.some((key) => key in value);
  const expectedKeys = hasAuthorizationMetadata
    ? [...baseKeys, ...authorizationKeys]
    : baseKeys;
  if (Object.keys(value).length !== expectedKeys.length
    || !expectedKeys.every((key) => key in value)
    || !baseKeys.every((key) => actionValidatorMap[key]!(value[key]))) return false;
  const action = value as Record<string, unknown>;
  const target = action.targetPublicUrl;
  const kind = action.kind;
  const targetValid = kind === "comment"
    ? typeof target === "string"
      && /^https:\/\/www\.douyin\.com\/video\/[A-Za-z0-9_-]{1,300}$/u.test(target)
    : kind === "direct_message" && typeof target === "string"
      && /^https:\/\/www\.douyin\.com\/user\/[A-Za-z0-9_-]{1,300}$/u.test(target);
  const status = action.status;
  const receiptValid = status === "succeeded"
    ? typeof action.platformReceiptReference === "string"
      && typeof action.occurredAt === "string" && action.failureCode === null
    : status === "failed" || status === "risk_paused"
      ? action.platformReceiptReference === null
        && typeof action.occurredAt === "string"
        && typeof action.failureCode === "string"
      : action.platformReceiptReference === null
        && action.occurredAt === null && action.failureCode === null;
  const authorizationValid = !hasAuthorizationMetadata
    || kind === "direct_message"
      && authorizationKeys.every((key) =>
        directMessageAuthorizationValidatorMap[key]!(action[key]))
      && (action.directMessageDailyOrdinal as number)
        <= (action.directMessageDailyLimit as number);
  return targetValid && receiptValid && authorizationValid && (kind === "comment"
    ? action.sequence === 1 && action.predecessorActionId === null
    : action.sequence === 2 && typeof action.predecessorActionId === "string");
};
const actionListShape = (body: Record<string, unknown>) => closedShape(body, {
  items: (value) => Array.isArray(value) && value.length <= 400
    && value.every(actionShape)
});

export function createOutreachBatchApi(fetchImpl: typeof fetch = fetch, options: { cookie?: string; cookieSource?: () => string } = {}): OutreachBatchApi {
  const cookieSource = options.cookieSource ?? (() => options.cookie ?? (typeof document === "undefined" ? "" : document.cookie));
  async function request<T>(path: string, init: RequestInit, validate: (body: Record<string, unknown>) => boolean): Promise<T> {
    const response = await fetchImpl(path, { ...init, credentials: "same-origin", headers: { accept: "application/json", ...(init.headers ?? {}) } });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const root = record(body) ? body : {};
      const nested = record(root.error) ? root.error : {};
      throw new AcquisitionHttpError(response.status,
        typeof nested.code === "string" ? nested.code
          : typeof root.code === "string" ? root.code : `http_${response.status}`,
        (typeof nested.message === "string" ? nested.message
          : typeof root.message === "string" ? root.message : `请求失败（HTTP ${response.status}）`).slice(0, 300));
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
    approveDirectMessages(batchId, command, etag, key, signal) {
      const closed: DirectMessageApprovalCommand = {
        batchRevision: command.batchRevision,
        batchHash: command.batchHash,
        commentApprovalHash: command.commentApprovalHash,
        dailyLimit: command.dailyLimit,
        candidates: command.candidates.map(({ candidateId, directMessage }) => ({
          candidateId,
          directMessage
        })),
        confirm: true
      };
      return request(`/api/v1/acquisition/outreach-batches/${segment(batchId)}/direct-messages/approve`, {
        method: "POST",
        signal,
        headers: headers(key, etag),
        body: JSON.stringify(closed)
      }, batchShape);
    },
    rejectBatch(batchId, reason, etag, key, signal) { return transition(batchId, "reject", reason ? { reason } : {}, etag, key, signal); },
    pauseBatch(batchId, reason, etag, key, signal) { return transition(batchId, "pause", reason ? { reason } : {}, etag, key, signal); },
    resumeBatch(batchId, etag, key, signal) { return transition(batchId, "resume", {}, etag, key, signal); },
    listActions(batchId, signal) {
      return request(`/api/v1/acquisition/outreach-batches/${segment(batchId)}/actions`, { method: "GET", signal },
        actionListShape);
    },
    reconcileAction(batchId, action, key, signal) {
      return request(`/api/v1/acquisition/outreach-batches/${segment(batchId)}/actions/${segment(action.id)}/reconcile`, {
        method: "POST", signal, headers: headers(key), body: JSON.stringify({
          batchRevision: action.batchRevision,
          approvalHash: action.approvalHash,
          contentHash: action.contentHash,
          confirm: true
        })
      }, actionShape);
    }
  };
}
