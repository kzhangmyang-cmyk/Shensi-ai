import type { components } from '../generated/system-reference';
import { csrfFromCookie } from '../acquisition/csrf';
import { ReferenceApiError, validReferenceWarnings } from './api';
import { centralRequest, type CentralFetch } from './central-http';

type S = components['schemas'];
export type ReferenceRelease = S['ReleaseDraft'];
export type ReferenceReleaseDetail = S['ReleaseDetail'];
export type PublicationAction = 'publish' | 'revoke';
export interface ReferenceAdminApi {
  inspect(releaseId: string, signal: AbortSignal): Promise<ReferenceReleaseDetail>;
  transition(release: ReferenceRelease, action: PublicationAction, input: S['ReleaseTransition'], key: string, signal: AbortSignal): Promise<ReferenceRelease>;
  commandStatus(release: ReferenceRelease, action: PublicationAction, key: string, signal: AbortSignal): Promise<S['PublicationCommandStatus']>;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export const validReleaseId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
function validRelease(v: unknown): v is ReferenceRelease {
  return record(v) && keys(v, ['id','corpusId','revision','status','manifestHash']) && validReleaseId(v.id) && validReleaseId(v.corpusId)
    && integer(v.revision, 1) && typeof v.status === 'string' && ['staging','ready','published','revoked','failed'].includes(v.status) && hash(v.manifestHash);
}
function validCoverage(v: unknown): v is S['Coverage'] {
  if (!record(v) || !keys(v, ['totalPages','extractedPages','missingPages']) || !Array.isArray(v.missingPages) || v.missingPages.length > 1000
    || !v.missingPages.every(page => integer(page, 1, 1000))) return false;
  if (v.totalPages === null) return v.extractedPages === null && v.missingPages.length === 0;
  return integer(v.totalPages, 1, 1000) && integer(v.extractedPages, 0, v.totalPages)
    && new Set(v.missingPages).size === v.missingPages.length && v.missingPages.every(page => page <= Number(v.totalPages))
    && v.extractedPages + v.missingPages.length === v.totalPages;
}
function validDetail(v: unknown): v is ReferenceReleaseDetail {
  if (!record(v) || !keys(v, ['release','manifest','activeReleaseId','sources']) || !validRelease(v.release)
    || !(v.activeReleaseId === null || validReleaseId(v.activeReleaseId)) || !record(v.manifest) || !keys(v.manifest, ['corpusId','sources'])
    || v.manifest.corpusId !== v.release.corpusId || !Array.isArray(v.manifest.sources) || v.manifest.sources.length < 1 || v.manifest.sources.length > 100) return false;
  const sources = v.manifest.sources;
  if (!sources.every((source: unknown) => record(source) && keys(source, ['sourceHash','artifactHash','parsedHash','parserVersion','title','roles','coverage','warnings'])
    && hash(source.sourceHash) && hash(source.artifactHash) && hash(source.parsedHash) && text(source.parserVersion, 100) && text(source.title, 300)
    && Array.isArray(source.roles) && source.roles.length > 0 && source.roles.length <= 6 && new Set(source.roles).size === source.roles.length
    && source.roles.every(role => typeof role === 'string' && ['cfo','finance','profit','cost','cashflow','tax'].includes(role))
    && validReferenceWarnings(source.warnings) && validCoverage(source.coverage))) return false;
  const sourceHashes = new Set(sources.map(source => source.sourceHash));
  return sourceHashes.size === sources.length && Array.isArray(v.sources) && v.sources.length === sources.length
    && v.sources.every((source: unknown) => record(source) && keys(source, ['sourceHash','totalChunks','receivedChunks','complete']) && sourceHashes.has(source.sourceHash)
      && (source.totalChunks === null || integer(source.totalChunks, 1, 50000)) && integer(source.receivedChunks, 0, 50000) && typeof source.complete === 'boolean')
    && new Set(v.sources.map(source => source.sourceHash)).size === sources.length;
}
const invalid = () => new ReferenceApiError('reference_response_invalid');
export function createReferenceAdminApi(options: { fetchImpl?: CentralFetch; csrf?: () => string } = {}): ReferenceAdminApi {
  const fetcher = options.fetchImpl ?? fetch, csrf = options.csrf ?? (() => csrfFromCookie(document.cookie));
  const currentCsrf = () => { try { return csrf() || null; } catch { return null; } }, capturedCsrf = currentCsrf();
  const assertAccount = () => { if (!capturedCsrf || currentCsrf() !== capturedCsrf) throw new ReferenceApiError('reference_auth_required', 401); };
  const request = async (path: string, init: RequestInit, signal: AbortSignal) => {
    assertAccount(); const value = await centralRequest(fetcher, path, init, signal); assertAccount(); return value;
  };
  return {
    async inspect(releaseId, signal) {
      if (!validReleaseId(releaseId)) throw invalid();
      const value = await request(`/api/platform/v1/system-reference/releases/${releaseId}`, { method: 'GET', headers: { Accept: 'application/json' } }, signal);
      if (!validDetail(value) || value.release.id !== releaseId) throw invalid(); return value;
    },
    async transition(release, action, input, key, signal) {
      if (!validRelease(release) || !['publish','revoke'].includes(action) || !/^[A-Za-z0-9_.:-]{1,191}$/u.test(key)
        || !record(input) || !keys(input, ['reason']) || !text(input.reason, 500) || !input.reason.trim()) throw invalid();
      const value = await request(`/api/platform/v1/system-reference/releases/${release.id}/${action}`, { method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': capturedCsrf ?? '', 'If-Match': `"${release.revision}"`, 'Idempotency-Key': key },
        body: JSON.stringify({ reason: input.reason.trim() }) }, signal);
      if (!validRelease(value) || value.id !== release.id || value.corpusId !== release.corpusId || value.manifestHash !== release.manifestHash
        || value.revision <= release.revision || value.status !== (action === 'publish' ? 'published' : 'revoked')) throw invalid();
      return value;
    },
    async commandStatus(release, action, key, signal) {
      if (!validRelease(release) || !['publish','revoke'].includes(action) || !/^[A-Za-z0-9_.:-]{1,191}$/u.test(key)) throw invalid();
      const value = await request(`/api/platform/v1/system-reference/commands/status?corpusId=${release.corpusId}&operation=${action}`,
        { method: 'GET', headers: { Accept: 'application/json', 'Idempotency-Key': key } }, signal);
      if (!record(value) || value.operation !== action) throw invalid();
      if (value.outcome === 'not_observed' && keys(value, ['operation','outcome'])) return { operation: action, outcome: 'not_observed' };
      if (value.outcome !== 'committed' || !keys(value, ['operation','outcome','requestHash','release']) || !hash(value.requestHash) || !validRelease(value.release)
        || value.release.id !== release.id || value.release.corpusId !== release.corpusId || value.release.manifestHash !== release.manifestHash
        || value.release.revision <= release.revision || value.release.status !== (action === 'publish' ? 'published' : 'revoked')) throw invalid();
      return { operation: action, outcome: 'committed', requestHash: value.requestHash, release: value.release };
    }
  };
}
