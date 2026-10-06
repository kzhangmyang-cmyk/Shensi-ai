import { z } from 'zod';
import type { ActiveWorkspaceContext } from '../growth-workspace-context.js';
import { GrowthHttpError } from '../growth-command-context.js';
import type { GrowthCapability } from '../growth-capabilities.js';

export const KNOWLEDGE_MAX_BYTES = 50 * 1024 * 1024;
export const knowledgeRoleSchema = z.enum(['cfo', 'finance', 'profit', 'cost', 'cashflow', 'tax']);
export type KnowledgeRole = z.infer<typeof knowledgeRoleSchema>;
export type KnowledgeScope = ActiveWorkspaceContext;
const warnings = z.array(z.string().min(1).max(80)).max(100);
const roles = z.array(knowledgeRoleSchema).min(1).max(6)
  .refine(values => new Set(values).size === values.length, 'duplicate roles');
export const knowledgeUploadInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  filename: z.string().trim().min(1).max(255).refine(value => !/[\/\\\x00-\x1f\x7f]/u.test(value) && value !== '.' && value !== '..'),
  format: z.enum(['pdf', 'docx', 'xlsx', 'csv', 'txt', 'md']),
  bytes: z.number().int().min(1).max(KNOWLEDGE_MAX_BYTES),
  sourceKind: z.enum(['book', 'company', 'reference']), roles
}).strict();
export type KnowledgeUploadInput = z.infer<typeof knowledgeUploadInputSchema>;
export const knowledgeDocumentPatchSchema = knowledgeUploadInputSchema.pick({ title: true, sourceKind: true, roles: true })
  .partial().extend({ enabled: z.boolean().optional(), deleted: z.literal(true).optional() }).strict()
  .refine(value => Object.keys(value).length > 0, 'empty patch');
export type KnowledgeDocumentPatch = z.infer<typeof knowledgeDocumentPatchSchema>;
export const knowledgeLocatorSchema = z.object({
  page: z.number().int().min(1).max(1000).optional(), chapter: z.string().max(300).optional(),
  sheet: z.string().max(200).optional(), row: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(), paragraph: z.number().int().min(1).optional(),
  table: z.number().int().min(1).optional(), startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(), startOffset: z.number().int().min(0).optional(),
  endOffset: z.number().int().min(0).optional()
}).strict();
export type KnowledgeLocator = z.infer<typeof knowledgeLocatorSchema>;
export const knowledgeCoverageSchema = z.object({
  totalPages: z.number().int().min(1).max(1000).nullable(),
  extractedPages: z.number().int().min(0).max(1000).nullable(),
  missingPages: z.array(z.number().int().min(1).max(1000)).max(1000)
}).strict().refine(value => value.totalPages === null
  ? value.extractedPages === null && value.missingPages.length === 0
  : value.extractedPages !== null && value.extractedPages <= value.totalPages
    && new Set(value.missingPages).size === value.missingPages.length
    && value.missingPages.every(page => page <= value.totalPages!)
    && value.extractedPages + value.missingPages.length === value.totalPages, 'invalid coverage');
export type KnowledgeCoverage = z.infer<typeof knowledgeCoverageSchema>;
export const parsedKnowledgeSchema = z.object({
  parserVersion: z.string().min(1).max(100), coverage: knowledgeCoverageSchema, warnings,
  chunks: z.array(z.object({ order: z.number().int().min(0), text: z.string().trim().min(1).max(4000),
    locator: knowledgeLocatorSchema, warnings }).strict()).min(1).max(50_000)
}).strict().refine(value => value.chunks.every((chunk, index) => chunk.order === index), 'invalid chunk order');
export type ParsedKnowledge = z.infer<typeof parsedKnowledgeSchema>;
export type KnowledgeStatus = 'queued' | 'parsing' | 'indexing' | 'ready' | 'failed' | 'cancelled';
export interface KnowledgeDocument {
  id: string; revision: number; title: string; sourceKind: KnowledgeUploadInput['sourceKind'];
  roles: KnowledgeRole[]; enabled: boolean; activeVersionId: string | null; latestVersionId: string; updatedAt: string;
}
export interface KnowledgeDocumentRecord extends KnowledgeDocument {
  workspaceId: string; actorId: string; deleted: boolean;
}
export interface KnowledgeVersion {
  id: string; documentId: string; revision: number; jobId: string | null; filename: string; format: KnowledgeUploadInput['format'];
  bytes: number; sourceHash: string | null; uploadComplete: boolean; status: KnowledgeStatus;
  coverage: KnowledgeCoverage | null; warnings: string[]; failureCode: string | null;
}
export interface KnowledgeVersionRecord extends KnowledgeVersion {
  workspaceId: string; actorId: string; storageKey: string | null; parserVersion: string | null;
}
export interface KnowledgeChunk {
  id: string; versionId: string; order: number; text: string; locator: KnowledgeLocator; warnings: string[];
}
export interface KnowledgeCitation {
  sourceId: string; documentId: string; versionId: string; sourceHash: string; chunkId: string;
  sourceLabel: string; locator: KnowledgeLocator; excerpt: string; warnings: string[];
}
export interface KnowledgeEvidence { status: 'used' | 'no_match' | 'unavailable'; sources: KnowledgeCitation[]; }
export interface KnowledgeAnswer extends KnowledgeEvidence { detailedText: string; warnings: string[]; }
export interface KnowledgeJobClaim {
  jobId: string; documentId: string; versionId: string; workspaceId: string; actorId: string;
  fence: number; leaseUntil: number;
}
export interface KnowledgeJob extends KnowledgeJobClaim { workerId: string | null; done: boolean; }
export function assertKnowledgeScope(ctx: KnowledgeScope, capability: GrowthCapability): void {
  if (!ctx.workspaceId?.trim() || ctx.workspaceId === 'all' || !ctx.actorId?.trim() || ctx.actorId === 'all') {
    throw new GrowthHttpError(400, 'workspace_required');
  }
  if (!ctx.capabilities.includes(capability)) throw new GrowthHttpError(403, 'capability_forbidden');
}
export function documentProjection(record: KnowledgeDocumentRecord): KnowledgeDocument {
  const { id, revision, title, sourceKind, roles, enabled, activeVersionId, latestVersionId, updatedAt } = record;
  return { id, revision, title, sourceKind, roles: [...roles], enabled, activeVersionId, latestVersionId, updatedAt };
}
export function versionProjection(record: KnowledgeVersionRecord): KnowledgeVersion {
  const { id, documentId, revision, jobId, filename, format, bytes, sourceHash, uploadComplete, status, coverage, warnings, failureCode } = record;
  return structuredClone({ id, documentId, revision, jobId, filename, format, bytes, sourceHash, uploadComplete, status, coverage, warnings, failureCode });
}
