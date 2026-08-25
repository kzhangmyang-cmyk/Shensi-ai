import type { components } from "../generated/ai-acquisition";
import { csrfFromCookie } from "./csrf";
import { AcquisitionHttpError } from "./douyin-automation-api";

export type OutreachBatch = components["schemas"]["AcquisitionOutreachBatch"];
export type OutreachActionList = components["schemas"]["AcquisitionOutreachActionList"];
export type OutreachAction = components["schemas"]["AcquisitionOutreachAction"];

export interface OutreachBatchApi {
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
  const batchShape = (body: Record<string, unknown>) => typeof body.id === "string"
    && typeof body.etag === "string" && typeof body.revision === "number" && Array.isArray(body.candidates);
  const transition = (batchId: string, name: string, body: object, etag: string, key: string, signal?: AbortSignal) =>
    request<OutreachBatch>(`/api/v1/acquisition/outreach-batches/${segment(batchId)}/${name}`, {
      method: "POST", signal, headers: headers(key, etag), body: JSON.stringify(body)
    }, batchShape);
  return {
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
