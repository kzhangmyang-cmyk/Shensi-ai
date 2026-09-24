import { z } from 'zod';
import { conversationResearchSchema } from './agent-conversation-research.js';
import type mysql from 'mysql2/promise';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';
import { requireGrowthCapabilities } from './growth-capabilities.js';
import { GrowthHttpError } from './growth-command-context.js';
import { encryptAgentJobPayload, decryptAgentJobPayload } from './agent-job-security.js';

// A separate conversation record; never an executable AgentJob or verified fact.
export const cfoSessionSchema = z.object({
  sessionId: z.string().uuid(), revision: z.number().int().min(1),
  title: z.string().min(1).max(120),
  documentId: z.string().min(1).max(191).nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  turns: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(4000),
    model: z.string().max(191).optional(), sourceLabel: z.string().max(1000).optional(), research:conversationResearchSchema.optional()
  }).strict()).max(100)
}).strict();
export type CfoConversationSession = z.infer<typeof cfoSessionSchema>;
export interface CfoConversationSessionRepository {
  list(context: ActiveWorkspaceContext): Promise<CfoConversationSession[]>;
  get(context: ActiveWorkspaceContext, sessionId: string): Promise<CfoConversationSession | null>;
  save(context: ActiveWorkspaceContext, value: CfoConversationSession, expectedRevision: number): Promise<void>;
}
function identity(context: ActiveWorkspaceContext, sessionId: string) {
  requireGrowthCapabilities(context, ['finance.council.run']);
  if (!context.actorId || !context.workspaceId || context.workspaceId === 'all')
    throw new GrowthHttpError(403, 'workspace_required');
  if (!z.string().uuid().safeParse(sessionId).success) throw new GrowthHttpError(422, 'cfo_session_input_invalid');
  return { id: sessionId, teamId: context.workspaceId,
    ownerId: context.actorId, jobType: 'cfo-conversation-session.v1' };
}
function scope(context: ActiveWorkspaceContext) {
  identity(context, '00000000-0000-4000-8000-000000000000');
  return JSON.stringify([context.workspaceId, context.actorId]);
}
function encode(context: ActiveWorkspaceContext, raw: CfoConversationSession, expected: number) {
  const value = cfoSessionSchema.parse(raw);
  if (!Number.isSafeInteger(expected) || expected < 0 || value.revision !== expected + 1)
    throw new GrowthHttpError(409, 'cfo_session_revision_conflict');
  return encryptAgentJobPayload(identity(context, value.sessionId), 'output', value);
}
function decode(context: ActiveWorkspaceContext, id: string, encrypted: string) {
  const value = cfoSessionSchema.parse(decryptAgentJobPayload(identity(context, id), 'output', encrypted));
  if (value.sessionId !== id) throw new Error('cfo_session_payload_invalid');
  return value;
}

export class InMemoryCfoConversationSessionRepository implements CfoConversationSessionRepository {
  private readonly rows = new Map<string, Map<string, { revision: number; updatedAt: string; payload: string }>>();
  async list(context: ActiveWorkspaceContext) {
    return [...(this.rows.get(scope(context)) ?? [])]
      .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt) || a[0].localeCompare(b[0]))
      .slice(0, 50).map(([id, row]) => decode(context, id, row.payload));
  }
  async get(context: ActiveWorkspaceContext, id: string) {
    identity(context, id);
    const row = this.rows.get(scope(context))?.get(id);
    return row ? decode(context, id, row.payload) : null;
  }
  async save(context: ActiveWorkspaceContext, value: CfoConversationSession, expected: number) {
    const payload = encode(context, value, expected); const key = scope(context);
    const rows = this.rows.get(key) ?? new Map();
    if ((rows.get(value.sessionId)?.revision ?? 0) !== expected)
      throw new GrowthHttpError(409, 'cfo_session_revision_conflict');
    rows.set(value.sessionId, { revision: value.revision, updatedAt: value.updatedAt, payload });
    this.rows.set(key, rows);
  }
}

export const CFO_CONVERSATION_SESSION_MYSQL_SCHEMA = `CREATE TABLE IF NOT EXISTS cfo_conversation_sessions (
  workspace_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  updated_at VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_encrypted MEDIUMTEXT NOT NULL,
  PRIMARY KEY (workspace_id, actor_id, session_id),
  KEY idx_cfo_sessions_recent (workspace_id, actor_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;

export class MysqlCfoConversationSessionRepository implements CfoConversationSessionRepository {
  constructor(private readonly pool: Pick<mysql.Pool, 'execute'>) {}
  async list(context: ActiveWorkspaceContext) {
    scope(context);
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      'SELECT session_id, payload_encrypted FROM cfo_conversation_sessions WHERE workspace_id = ? AND actor_id = ? ORDER BY updated_at DESC, session_id ASC LIMIT 50',
      [context.workspaceId, context.actorId]);
    return rows.map(row => decode(context, String(row.session_id), String(row.payload_encrypted)));
  }
  async get(context: ActiveWorkspaceContext, id: string) {
    identity(context, id);
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      'SELECT payload_encrypted FROM cfo_conversation_sessions WHERE workspace_id = ? AND actor_id = ? AND session_id = ?',
      [context.workspaceId, context.actorId, id]);
    return rows[0] ? decode(context, id, String(rows[0].payload_encrypted)) : null;
  }
  async save(context: ActiveWorkspaceContext, value: CfoConversationSession, expected: number) {
    const encrypted = encode(context, value, expected);
    if (expected === 0) {
      try {
        await this.pool.execute('INSERT INTO cfo_conversation_sessions (workspace_id, actor_id, session_id, revision, updated_at, payload_encrypted) VALUES (?, ?, ?, ?, ?, ?)',
          [context.workspaceId, context.actorId, value.sessionId, value.revision, value.updatedAt, encrypted]);
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new GrowthHttpError(409, 'cfo_session_revision_conflict');
        throw error;
      }
    } else {
      const [result] = await this.pool.execute<mysql.ResultSetHeader>(
        'UPDATE cfo_conversation_sessions SET revision = ?, updated_at = ?, payload_encrypted = ? WHERE workspace_id = ? AND actor_id = ? AND session_id = ? AND revision = ?',
        [value.revision, value.updatedAt, encrypted, context.workspaceId, context.actorId, value.sessionId, expected]);
      if (result.affectedRows !== 1) throw new GrowthHttpError(409, 'cfo_session_revision_conflict');
    }
  }
}
