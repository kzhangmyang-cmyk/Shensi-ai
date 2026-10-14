import { z } from 'zod';
import { knowledgeCoverageSchema, knowledgeLocatorSchema, knowledgeRoleSchema, knowledgeCitationSchema } from '../knowledge/domain.js';
import { REFERENCE_VOCABULARY_VERSION, referenceTopicSelectionSchema } from './topics.js';

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z.number().int().nonnegative().safe();
const warnings = z.array(z.string().min(1).max(80)).max(100);
const roles = z.array(knowledgeRoleSchema).min(1).max(6).refine(values => new Set(values).size === values.length);
export const referenceCommandKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,191}$/u);
export type ReferenceRole = z.infer<typeof knowledgeRoleSchema>;
export const systemReferenceQuerySchema = z.object({
  vocabularyVersion: z.literal(REFERENCE_VOCABULARY_VERSION),
  topicIds: referenceTopicSelectionSchema.refine(values => values.length > 0, 'reference_topics_invalid'),
  role: knowledgeRoleSchema, requestId: uuid
}).strict();
export type ReferenceQuery = z.infer<typeof systemReferenceQuerySchema>;
export const privateReferenceSchema = knowledgeCitationSchema.extend({ sourceType: z.literal('private').optional() }).strict();
export type PrivateReference = z.infer<typeof privateReferenceSchema>;
export const systemReferenceSchema = z.object({
  sourceType: z.literal('system'), sourceId: z.string().regex(/^K[1-6]$/u),
  referenceKey: z.string().max(80), queryGrantId: uuid, referenceId: uuid, corpusId: uuid, releaseId: uuid,
  sourceHash: hash, chunkHash: hash,
  excerptRange: z.object({ start: z.number().int().nonnegative().max(4000), end: z.number().int().min(1).max(4000) }).strict(),
  sourceLabel: z.string().min(1).max(1000), locator: knowledgeLocatorSchema,
  excerpt: z.string().min(1).max(4000), warnings
}).strict().refine(value => value.referenceKey === `system:${value.releaseId}:${value.referenceId}`
  && value.excerptRange.end - value.excerptRange.start === value.excerpt.length
  // Full source/range equality is checked against the immutable chunk by D5.
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value.excerpt), 'reference_invalid');
export type SystemReference = z.infer<typeof systemReferenceSchema>;
export const referenceCitationSchema = z.union([privateReferenceSchema, systemReferenceSchema]);
export type ReferenceCitation = z.infer<typeof referenceCitationSchema>;
export const referenceEvidenceSchema = z.object({
  status: z.enum(['used', 'no_match', 'unavailable']), sources: z.array(referenceCitationSchema).max(6)
}).strict().refine(value => (value.status === 'used' ? value.sources.length > 0 : value.sources.length === 0)
  && new Set(value.sources.map(source => source.sourceId)).size === value.sources.length
  && value.sources.reduce((total, source) => total + source.excerpt.length, 0) <= 12000, 'reference_invalid');
export type ReferenceEvidence = z.infer<typeof referenceEvidenceSchema>;
export const libraryStatusSchema = z.object({
  private: z.enum(['off', 'used', 'no_match', 'unavailable']),
  system: z.enum(['off', 'unconfigured', 'unbound', 'ready', 'no_match', 'unavailable', 'auth_required', 'forbidden', 'rate_limited', 'vocabulary_mismatch'])
}).strict();
export type LibraryStatus = z.infer<typeof libraryStatusSchema>;
export interface PreparedReferences { evidence: ReferenceEvidence; libraryStatus: LibraryStatus; assertCurrent(signal?: AbortSignal): Promise<void>; }

// Existing identity storage uses opaque strings (including u_*), not UUIDs.
const identity = z.string().min(1).max(191);
export const centralReaderSchema = z.object({ subjectId: identity, workspaceId: identity, authVersion: revision, authorityRevision: revision }).strict();
export type CentralReader = z.infer<typeof centralReaderSchema>;
export const centralOwnerSchema = z.object({ userId: identity, authVersion: revision, platformRevision: revision, sessionVersion: revision }).strict();
export type CentralOwner = z.infer<typeof centralOwnerSchema>;
export const connectionStatusSchema = z.object({
  status: z.enum(['unconfigured', 'unbound', 'pending', 'ready', 'session_ready', 'embedded_ready', 'unconfirmed', 'auth_required', 'forbidden', 'unavailable']),
  generation: revision, centralAccountLabel: z.string().min(1).max(191).optional(), expiresAt: z.string().datetime({ offset: true }).optional()
}).strict();
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export const releaseDraftSchema = z.object({
  id: uuid, corpusId: uuid, revision: revision.min(1),
  status: z.enum(['staging', 'ready', 'published', 'revoked', 'failed']), manifestHash: hash
}).strict();
export type ReleaseDraft = z.infer<typeof releaseDraftSchema>;
export const publicationManifestSchema = z.object({ corpusId: uuid, sources: z.array(z.object({
  sourceHash: hash, artifactHash: hash, parsedHash: hash, parserVersion: z.string().min(1).max(100),
  title: z.string().min(1).max(300), roles, coverage: knowledgeCoverageSchema, warnings
}).strict()).min(1).max(100) }).strict().refine(value => new Set(value.sources.map(source => source.sourceHash)).size === value.sources.length, 'duplicate_source');
export type PublicationManifest = z.infer<typeof publicationManifestSchema>;
export const sourcePageSchema = z.object({ sourceHash: hash, pageIndex: z.number().int().min(0).max(499),
  totalChunks: z.number().int().min(1).max(50000), chunks: z.array(z.object({
    order: z.number().int().min(0).max(49999), text: z.string().trim().min(1).max(4000), locator: knowledgeLocatorSchema, warnings
  }).strict()).min(1).max(100)
}).strict().refine(value => value.chunks.length === Math.min(100, value.totalChunks - value.pageIndex * 100)
  && value.chunks.every((chunk, index) => chunk.order === value.pageIndex * 100 + index), 'source_page_invalid');
export type SourcePage = z.infer<typeof sourcePageSchema>;
export const publicationOperationSchema=z.enum(['stage','source','publish','revoke']);
export const releaseListSchema=z.object({items:z.array(releaseDraftSchema).max(50),activeReleaseId:uuid.nullable(),nextCursor:uuid.nullable()}).strict();
export const releaseDetailSchema=z.object({release:releaseDraftSchema,manifest:publicationManifestSchema,activeReleaseId:uuid.nullable(),
  sources:z.array(z.object({sourceHash:hash,totalChunks:z.number().int().min(1).max(50000).nullable(),receivedChunks:z.number().int().min(0).max(50000),complete:z.boolean()}).strict()).min(1).max(100)
}).strict();
export const publicationCommandStatusSchema=z.discriminatedUnion('outcome',[
  z.object({operation:publicationOperationSchema,outcome:z.literal('not_observed')}).strict(),
  z.object({operation:publicationOperationSchema,outcome:z.literal('committed'),requestHash:hash,release:releaseDraftSchema}).strict()
]);
export const queryResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('used'), grantId: uuid, releaseId: uuid, sources: z.array(systemReferenceSchema).min(1).max(6) }).strict(),
  z.object({ status: z.literal('no_match'), releaseId: uuid.optional(), sources: z.array(systemReferenceSchema).max(0) }).strict(),
  z.object({ status: z.literal('rate_limited'), releaseId: uuid.optional(), sources: z.array(systemReferenceSchema).max(0) }).strict()
]).refine(value => value.status !== 'used' || (value.sources.every(source => source.queryGrantId === value.grantId && source.releaseId === value.releaseId)
  && new Set(value.sources.map(source => source.referenceId)).size === value.sources.length
  && new Set(value.sources.map(source => source.sourceId)).size === value.sources.length
  && value.sources.reduce((total, source) => total + source.excerpt.length, 0) <= 12000), 'reference_invalid');
export type QueryResult = z.infer<typeof queryResultSchema>;
