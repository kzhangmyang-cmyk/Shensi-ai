import { z } from 'zod';
import { ReferenceAccessError } from './authority.js';
import { bindingCreateSchema, bindingProofSchema } from './binding-service.js';
import { centralReaderSchema, queryResultSchema, systemReferenceQuerySchema, systemReferenceSchema,
  type QueryResult, type ReferenceQuery, type SystemReference } from './domain.js';

export interface ReferenceClient {
  query(input: ReferenceQuery, signal?: AbortSignal): Promise<QueryResult>;
  assertCurrent(grantId: string, signal?: AbortSignal): Promise<void>;
  citation(grantId: string, referenceId: string, signal?: AbortSignal): Promise<SystemReference>;
}
export const bindingPendingSchema = z.object({ requestId: z.string().uuid(), displayCode: z.string().regex(/^\d{8}$/u), expiresAt: z.string().datetime({ offset: true }) }).strict();
export const bindingExchangeSchema = z.object({ readerToken: bindingProofSchema.shape.verifier, reader: centralReaderSchema, expiresAt: z.string().datetime({ offset: true }) }).strict();
export interface ReferenceBindingTransport {
  readonly origin: string;
  create(challenge: string, signal?: AbortSignal): Promise<z.infer<typeof bindingPendingSchema>>;
  exchange(requestId: string, verifier: string, signal?: AbortSignal): Promise<z.infer<typeof bindingExchangeSchema>>;
  cancel(requestId: string, verifier: string, signal?: AbortSignal): Promise<void>;
  reader(token: string): ReferenceClient;
}
const invalid = () => new ReferenceAccessError(503, 'reference_response_invalid');
const unavailable = () => new ReferenceAccessError(503, 'reference_unavailable');
const vocabularyErrorSchema = z.object({ error: z.object({ code: z.literal('reference_vocabulary_mismatch'),
  message: z.string().min(1).max(300) }).strict() }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw invalid(); return result.data;
}
export function referenceOrigin(value: string, testOnlyLoopback = false): string {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(testOnlyLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw invalid();
    return value;
  } catch { throw new Error('reference_origin_invalid'); }
}
/** This object exists only in a trusted backend. No automatic retry or redirect. */
export class ReferenceTransport implements ReferenceBindingTransport {
  readonly origin: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: { origin: string; fetch?: typeof fetch; timeoutMs?: number; testOnlyLoopback?: boolean }) {
    this.origin = referenceOrigin(options.origin, options.testOnlyLoopback);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 10000) throw new Error('reference_timeout_invalid');
  }
  private async request(path: string, method: 'POST' | 'GET', body: unknown, expectedStatus: number, token?: string, signal?: AbortSignal): Promise<unknown> {
    const json = body === undefined ? undefined : JSON.stringify(body);
    if (json && Buffer.byteLength(json) > 4096) throw new ReferenceAccessError(400, 'reference_input_invalid');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(unavailable()); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    if (signal?.aborted) abort();
    try {
      const operation = async () => {
        if (controller.signal.aborted) throw unavailable();
        const response = await this.fetch(this.origin + path, { method, body: json, redirect: 'error', credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw unavailable(); }
        if (response.body) reader = response.body.getReader();
        if (response.redirected) throw unavailable();
        const vocabularyResponse = path === '/api/v1/system-reference/query' && response.status === 400;
        if (response.status !== expectedStatus && !vocabularyResponse) {
          const status = response.status;
          if (status === 401 || status === 403 || status === 404 || status === 409 || status === 429) {
            throw new ReferenceAccessError(status, status === 401 ? 'reference_auth_required' : status === 429 ? 'reference_rate_limited' : 'reference_forbidden');
          }
          throw unavailable();
        }
        if (expectedStatus === 204) { if (reader) throw invalid(); return undefined; }
        if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) throw invalid();
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 262144)) throw invalid();
        const parts: Uint8Array[] = []; let bytes = 0;
        if (!reader) throw invalid();
        for (;;) {
          const part = await reader.read();
          if (controller.signal.aborted) throw unavailable();
          if (part.done) break;
          bytes += part.value.byteLength; if (bytes > 262144) throw invalid(); parts.push(part.value);
        }
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
        catch { throw invalid(); }
        if (vocabularyResponse) {
          if (!vocabularyErrorSchema.safeParse(value).success) throw invalid();
          // Discard even a valid remote message; only this fixed classification may escape.
          throw new ReferenceAccessError(400, 'reference_vocabulary_mismatch');
        }
        return value;
      };
      return await Promise.race([operation(), cancelled]);
    } catch (error) {
      if (error instanceof ReferenceAccessError) throw error;
      throw unavailable(); // Never carry arbitrary provider error text or response bodies.
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectAbort); controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
  }
  async create(challenge: string, signal?: AbortSignal) {
    const body = parse(bindingCreateSchema, { challenge });
    return parse(bindingPendingSchema, await this.request('/api/v1/system-reference/binding-requests', 'POST', body, 201, undefined, signal));
  }
  async exchange(requestId: string, verifier: string, signal?: AbortSignal) {
    const id = parse(z.string().uuid(), requestId), body = parse(bindingProofSchema, { verifier });
    return parse(bindingExchangeSchema, await this.request(`/api/v1/system-reference/binding-requests/${id}/exchange`, 'POST', body, 200, undefined, signal));
  }
  async cancel(requestId: string, verifier: string, signal?: AbortSignal) {
    const id = parse(z.string().uuid(), requestId), body = parse(bindingProofSchema, { verifier });
    await this.request(`/api/v1/system-reference/binding-requests/${id}/cancel`, 'POST', body, 204, undefined, signal);
  }
  reader(token: string): ReferenceClient {
    parse(bindingProofSchema, { verifier: token });
    return Object.freeze({
      query: async (input: ReferenceQuery, signal?: AbortSignal) => parse(queryResultSchema,
        await this.request('/api/v1/system-reference/query', 'POST', parse(systemReferenceQuerySchema, input), 200, token, signal)),
      assertCurrent: async (grantId: string, signal?: AbortSignal) => {
        const id = parse(z.string().uuid(), grantId);
        parse(z.object({ valid: z.literal(true), grantId: z.literal(id), releaseId: z.string().uuid() }).strict(),
          await this.request(`/api/v1/system-reference/grants/${id}/check`, 'POST', {}, 200, token, signal));
      },
      citation: async (grantId: string, referenceId: string, signal?: AbortSignal) => {
        const id = parse(z.string().uuid(), grantId), ref = parse(z.string().uuid(), referenceId);
        const result = parse(systemReferenceSchema, await this.request(`/api/v1/system-reference/grants/${id}/references/${ref}`, 'GET', undefined, 200, token, signal));
        if (result.queryGrantId !== id || result.referenceId !== ref) throw invalid(); return result;
      }
    });
  }
}
