import type { components } from '../generated/system-reference';
import { csrfFromCookie } from '../acquisition/csrf';

type S = components['schemas'];
export type SystemReference = S['SystemReference'];
export type ConnectionStatus = S['ConnectionStatus'];
export type ConnectionBegin = S['ConnectionBegin'];
export type LibraryStatus = S['LibraryStatus'];
export interface ReferenceApi {
  status(signal?: AbortSignal): Promise<ConnectionStatus>;
  begin(signal?: AbortSignal): Promise<ConnectionBegin>;
  complete(requestId: string, signal?: AbortSignal): Promise<ConnectionStatus>;
  unbind(signal?: AbortSignal): Promise<ConnectionStatus>;
  citation(grantId: string, referenceId: string, signal?: AbortSignal): Promise<SystemReference>;
}
export class ReferenceApiError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(code); this.name = 'ReferenceApiError'; }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const hash = /^[0-9a-f]{64}$/u;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max: number, min = 1): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const id = (v: unknown): v is string => typeof v === 'string' && uuid.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && hash.test(v);
const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
export const validReferenceWarnings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every(w => text(w, 80));
export function validReferenceLocator(v: unknown): v is S['Locator'] {
  if (!record(v) || !keys(v, ['page','chapter','sheet','row','column','paragraph','table','startLine','endLine','startOffset','endOffset'])) return false;
  return Object.entries(v).every(([k, value]) => k === 'chapter' ? text(value, 300, 0) : k === 'sheet' ? text(value, 200, 0)
    : integer(value, k.endsWith('Offset') ? 0 : 1, k === 'page' ? 1000 : Number.MAX_SAFE_INTEGER));
}
export function validSystemReference(v: unknown): v is SystemReference {
  return record(v) && keys(v, ['sourceType','sourceId','referenceKey','queryGrantId','referenceId','corpusId','releaseId','sourceHash','chunkHash','excerptRange','sourceLabel','locator','excerpt','warnings'])
    && v.sourceType === 'system' && typeof v.sourceId === 'string' && /^K[1-6]$/u.test(v.sourceId)
    && [v.queryGrantId,v.referenceId,v.corpusId,v.releaseId].every(id) && digest(v.sourceHash) && digest(v.chunkHash)
    && v.referenceKey === `system:${v.releaseId}:${v.referenceId}` && text(v.sourceLabel, 1000) && text(v.excerpt, 4000)
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v.excerpt)
    && record(v.excerptRange) && keys(v.excerptRange, ['start','end']) && integer(v.excerptRange.start, 0, 4000)
    && integer(v.excerptRange.end, 1, 4000) && v.excerptRange.end - v.excerptRange.start === v.excerpt.length
    && validReferenceLocator(v.locator) && validReferenceWarnings(v.warnings);
}
const connectionStates: ConnectionStatus['status'][] = ['unconfigured','unbound','pending','ready','session_ready','embedded_ready','unconfirmed','auth_required','forbidden','unavailable'];
export function validConnectionStatus(v: unknown): v is ConnectionStatus {
  return record(v) && keys(v, ['status','generation','centralAccountLabel','expiresAt'])
    && connectionStates.some(s => s === v.status) && integer(v.generation)
    && (v.centralAccountLabel === undefined || text(v.centralAccountLabel, 191)) && (v.expiresAt === undefined || date(v.expiresAt));
}
export function validConnectionBegin(v: unknown): v is ConnectionBegin {
  if (!record(v) || !keys(v, ['requestId','displayCode','expiresAt','approvalUrl']) || !id(v.requestId)
    || typeof v.displayCode !== 'string' || !/^\d{8}$/u.test(v.displayCode) || !date(v.expiresAt) || !text(v.approvalUrl, 2048)) return false;
  try { const url = new URL(v.approvalUrl); return url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && url.pathname === '/reference-approval.html' && [...url.searchParams.keys()].length === 2
    && url.searchParams.get('requestId') === v.requestId && url.searchParams.get('displayCode') === v.displayCode; } catch { return false; }
}
const invalid = () => new ReferenceApiError('reference_response_invalid');
function identifier(value: string) { if (!id(value)) throw new ReferenceApiError('reference_input_invalid'); return value; }
export function createReferenceApi(options: { fetchImpl?: (path: string, init?: RequestInit) => Promise<Response>; workspaceId?: () => string | null; csrf?: () => string } = {}): ReferenceApi {
  const fetcher = options.fetchImpl ?? fetch;
  const workspace = options.workspaceId ?? (() => document.body.dataset.sessionWorkspaceId ?? null);
  const csrf = options.csrf ?? (() => csrfFromCookie(document.cookie) ?? '');
  async function request<T>(path: string, validate: (value: unknown) => value is T, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted(); const scope = workspace()?.trim(); if (!scope || scope === 'all') throw new ReferenceApiError('reference_workspace_required');
    const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new ReferenceApiError('reference_unavailable')); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    const timer = setTimeout(abort, 10_000);
    const operation = async () => {
      const headers: Record<string,string> = { Accept: 'application/json', 'X-Workspace-Id': scope };
      if (method !== 'GET') headers['x-csrf-token'] = csrf();
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetcher(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new ReferenceApiError('reference_unavailable'); }
      if (!response.ok) { await response.body?.cancel().catch(() => {});
        throw new ReferenceApiError(({401:'reference_auth_required',403:'reference_forbidden',404:'reference_not_found',409:'reference_changed',429:'reference_rate_limited'} as Record<number,string>)[response.status] ?? 'reference_unavailable', response.status); }
      const length = response.headers.get('content-length');
      if (response.redirected || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')
        || (length !== null && (!/^\d+$/u.test(length) || Number(length) > 262144))) { void response.body?.cancel().catch(() => {}); throw invalid(); }
      reader = response.body?.getReader(); if (!reader) throw invalid();
      const decoder = new TextDecoder('utf-8', { fatal: true }); let encoded = 0, content = '';
      try { while (true) { const part = await reader.read(); controller.signal.throwIfAborted(); if (part.done) break;
        encoded += part.value.byteLength; if (encoded > 262144) throw invalid(); content += decoder.decode(part.value, { stream: true }); }
        content += decoder.decode();
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value: unknown = JSON.parse(content); if (!validate(value)) throw invalid(); return value;
    };
    try { return await Promise.race([operation(), cancelled]);
    } catch (error) { if (error instanceof ReferenceApiError) throw error; throw new ReferenceApiError('reference_unavailable'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', rejectAbort); controller.abort();
      if (reader) void reader.cancel().catch(() => {}); }
  }
  return {
    status: signal => request('/api/v1/reference-connection', validConnectionStatus, 'GET', undefined, signal),
    begin: signal => request('/api/v1/reference-connection/begin', validConnectionBegin, 'POST', {}, signal),
    async complete(requestId, signal) { return request('/api/v1/reference-connection/complete', validConnectionStatus, 'POST', { requestId: identifier(requestId) }, signal); },
    unbind: signal => request('/api/v1/reference-connection', validConnectionStatus, 'DELETE', undefined, signal),
    async citation(grantId, referenceId, signal) {
      return request(`/api/v1/reference-connection/grants/${identifier(grantId)}/references/${identifier(referenceId)}`,
        (v): v is SystemReference => validSystemReference(v) && v.queryGrantId === grantId && v.referenceId === referenceId, 'GET', undefined, signal);
    }
  };
}
