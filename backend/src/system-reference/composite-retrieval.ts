import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineGrowthPrivateServiceKey } from '../growth-commercial-private-services.js';
import { assertKnowledgeScope, knowledgeRoleSchema, type KnowledgeEvidence, type KnowledgeScope } from '../knowledge/domain.js';
import { knowledgeEvidenceSchema } from '../knowledge/answer.js';
import type { KnowledgeRetrievalPort } from '../knowledge/retrieval.js';
import { ReferenceAccessError } from './authority.js';
import type { ReferenceClient } from './client.js';
import type { ReferenceConnectionService } from './connection-service.js';
import type {EmbeddedReferenceService} from './embedded-reference.js';
import { connectionStatusSchema, libraryStatusSchema, queryResultSchema, referenceEvidenceSchema, systemReferenceQuerySchema,
  type LibraryStatus, type PreparedReferences, type ReferenceCitation, type ReferenceEvidence, type ReferenceRole } from './domain.js';
import { projectReferenceTopics, REFERENCE_VOCABULARY_VERSION, referenceTopicSelectionSchema, type ReferenceTopicId } from './topics.js';

export interface ReferencePreparationInput {
  question: string; role: ReferenceRole; knowledgeMode?: 'auto' | 'off';
  referenceProtocol?: 'system-v1'; referenceTopicIds?: ReferenceTopicId[];
}
export interface ReferenceRetrievalPort {
  prepare(ctx: KnowledgeScope, input: ReferencePreparationInput, signal?: AbortSignal): Promise<PreparedReferences>;
}
export const REFERENCE_RETRIEVER = defineGrowthPrivateServiceKey<ReferenceRetrievalPort>('system-reference-retriever');
type Connections = Pick<ReferenceConnectionService, 'status' | 'clientFor'>;
const inputSchema = z.object({ question: z.string().max(8000), role: knowledgeRoleSchema, knowledgeMode: z.enum(['auto', 'off']).optional(),
  referenceProtocol: z.literal('system-v1').optional(), referenceTopicIds: referenceTopicSelectionSchema.optional() })
  .refine(value => value.referenceTopicIds === undefined || value.referenceProtocol === 'system-v1', 'reference_protocol_required');
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stale = () => new Error('knowledge_reference_stale');
const empty = (status: KnowledgeEvidence['status']): KnowledgeEvidence => ({ status, sources: [] });
function failureStatus(error: unknown): LibraryStatus['system'] {
  if (!(error instanceof ReferenceAccessError)) return 'unavailable';
  if (error.status === 401) return 'auth_required';
  if ([403, 404, 409].includes(error.status)) return 'forbidden';
  if (error.status === 429) return 'rate_limited';
  if (error.status === 400 && error.code === 'reference_vocabulary_mismatch') return 'vocabulary_mismatch';
  return 'unavailable';
}

/** No provider prompt, raw question or private evidence crosses the central port. */
export class CompositeReferenceRetriever implements ReferenceRetrievalPort {
  constructor(private readonly options: { private?: KnowledgeRetrievalPort; connections?: Connections; embedded?: EmbeddedReferenceService } = {}) {}
  async prepare(ctx: KnowledgeScope, raw: ReferencePreparationInput, signal?: AbortSignal): Promise<PreparedReferences> {
    signal?.throwIfAborted();
    // Select known local fields explicitly; other callers' company/history fields are never forwarded.
    const input = inputSchema.parse({ question: raw.question, role: raw.role, knowledgeMode: raw.knowledgeMode,
      referenceProtocol: raw.referenceProtocol, referenceTopicIds: raw.referenceTopicIds });
    const contextHash = fingerprint(ctx), role = input.role, privatePort = this.options.private;
    const assertContext = () => { signal?.throwIfAborted(); if (fingerprint(ctx) !== contextHash) throw stale(); };
    let privateOriginal: KnowledgeEvidence | undefined, client: ReferenceClient | undefined, grantId: string | undefined;
    let privateValue = empty('no_match'), systemSources: ReferenceCitation[] = [];
    const libraryStatus: LibraryStatus = { private: 'off', system: 'off' };
    if (input.knowledgeMode === 'auto') {
      assertKnowledgeScope(ctx, 'knowledge.read');
      privateValue = empty('unavailable');
      if (privatePort) {
        try {
          const original = await privatePort.retrieve(ctx, { question: input.question, role }, signal);
          privateValue = knowledgeEvidenceSchema.parse(original);
          privateOriginal = original; // Only this unmodified object may be handed back to its WeakMap proof.
        } catch { assertContext(); }
      }
      libraryStatus.private = privateValue.status;
      assertContext();
      if (input.referenceProtocol === 'system-v1') {
        if(this.options.embedded){
          try{
            client=await this.options.embedded.clientFor(ctx,signal);
            const result=queryResultSchema.parse(await this.options.embedded.queryLocal(ctx,{question:input.question,role},signal));
            assertContext();libraryStatus.system=result.status==='used'?'ready':result.status;
            if(result.status==='used'){systemSources=result.sources;grantId=result.grantId;}
          }catch(error){
            assertContext();
            if(error instanceof ReferenceAccessError&&error.code==='reference_connection_changed')throw stale();
            libraryStatus.system=failureStatus(error);
          }
        }else{
        const topics = projectReferenceTopics(input.question, input.referenceTopicIds);
        if (!topics.length) libraryStatus.system = 'no_match';
        else if (!this.options.connections) libraryStatus.system = 'unconfigured';
        else {
          try {
            const connection = connectionStatusSchema.parse(await this.options.connections.status(ctx));
            assertContext();
            if (connection.status !== 'ready' && connection.status !== 'session_ready') {
              libraryStatus.system = connection.status === 'pending' ? 'unbound' : ['unconfirmed','embedded_ready'].includes(connection.status) ? 'unavailable' : connection.status as LibraryStatus['system'];
            } else {
              client = await this.options.connections.clientFor(ctx, signal);
              const query = systemReferenceQuerySchema.parse({ vocabularyVersion: REFERENCE_VOCABULARY_VERSION, topicIds: topics, role, requestId: randomUUID() });
              const result = queryResultSchema.parse(await client.query(query, signal));
              assertContext();
              libraryStatus.system = result.status === 'used' ? 'ready' : result.status;
              if (result.status === 'used') { systemSources = result.sources; grantId = result.grantId; }
            }
          } catch (error) {
            assertContext();
            // Local logout/rebinding is a question cancellation, not a usable degraded answer.
            if (error instanceof ReferenceAccessError && error.code === 'reference_connection_changed') throw stale();
            libraryStatus.system = failureStatus(error);
          }
        }
        }
      }
    }
    const sources: ReferenceCitation[] = [], seen = new Set<string>(); let characters = 0;
    for (let rank = 0; rank < Math.max(privateValue.sources.length, systemSources.length) && sources.length < 6; rank++) {
      for (const candidate of [privateValue.sources[rank], systemSources[rank]]) {
        if (!candidate || sources.length === 6 || candidate.excerpt.length > 4000 || characters + candidate.excerpt.length > 12000) continue;
        const normalized = candidate.excerpt.normalize('NFKC').replace(/\s+/gu, ' ').trim();
        if (seen.has(normalized)) continue;
        seen.add(normalized); characters += candidate.excerpt.length;
        sources.push({ ...structuredClone(candidate), sourceId: `K${sources.length + 1}` });
      }
    }
    const failed = libraryStatus.private === 'unavailable' || !['off', 'ready', 'no_match'].includes(libraryStatus.system);
    const evidence: ReferenceEvidence = referenceEvidenceSchema.parse({ status: sources.length ? 'used' : failed ? 'unavailable' : 'no_match', sources });
    libraryStatusSchema.parse(libraryStatus);
    const proofHash = fingerprint({ evidence, libraryStatus });
    const check = (currentSignal?: AbortSignal) => {
      currentSignal?.throwIfAborted(); assertContext();
      if (prepared.evidence !== evidence || prepared.libraryStatus !== libraryStatus || fingerprint({ evidence, libraryStatus }) !== proofHash) throw stale();
    };
    const prepared: PreparedReferences = { evidence, libraryStatus, assertCurrent: async currentSignal => {
      const combined = signal && currentSignal ? AbortSignal.any([signal, currentSignal]) : currentSignal ?? signal;
      try {
        check(combined);
        if (privateOriginal && privatePort) await privatePort.assertCurrent(ctx, { role, evidence: privateOriginal }, combined);
        if (client && grantId) await client.assertCurrent(grantId, combined);
        check(combined);
      } catch { combined?.throwIfAborted(); throw stale(); }
    } };
    // Either read may have become stale while awaiting the other library. Never hand it to a model first.
    await prepared.assertCurrent(signal);
    return prepared;
  }
}
