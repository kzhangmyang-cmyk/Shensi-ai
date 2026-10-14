import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { evaluatePlatformAccess, type PlatformAdminState } from '../platform-admin-domain.js';
import { centralOwnerSchema, centralReaderSchema, type CentralOwner, type CentralReader } from './domain.js';

export class ReferenceAccessError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503, readonly code: string) { super(code); }
}
export interface ReferenceAuthorityReader {
  current(subjectId: string, workspaceId: string, connection?: PoolConnection): Promise<CentralReader>;
  assertOwner(userId: string, connection?: PoolConnection): Promise<CentralOwner>;
}
export interface ReferenceIdentitySnapshot {
  user: { id: string; teamId: string; status: string; authVersion: number } | null;
  platform: PlatformAdminState | null;
}
export function createReferenceAuthorityReader(options: {
  readSnapshot(subjectId: string, connection?: PoolConnection): Promise<ReferenceIdentitySnapshot>;
  isMutationPending?(subjectId: string): boolean;
  now?: () => number;
}): ReferenceAuthorityReader {
  async function snapshot(subjectId: string, connection?: PoolConnection) {
    if (!subjectId || subjectId.length > 191 || options.isMutationPending?.(subjectId)) throw new ReferenceAccessError(403, 'reference_forbidden');
    const value = await options.readSnapshot(subjectId, connection);
    if (options.isMutationPending?.(subjectId) || !value.user || value.user.id !== subjectId || value.user.status !== 'active'
      || !Number.isSafeInteger(value.user.authVersion) || value.user.authVersion < 1 || !value.platform) throw new ReferenceAccessError(403, 'reference_forbidden');
    return { user: value.user, platform: value.platform };
  }
  return {
    async current(subjectId, workspaceId, connection) {
      const { user, platform } = await snapshot(subjectId, connection);
      if (!workspaceId || workspaceId === 'all' || workspaceId.startsWith('personal:') || user.teamId !== workspaceId
        || platform.workspaces.filter(row => row.id === workspaceId).length !== 1) throw new ReferenceAccessError(403, 'reference_forbidden');
      const access = evaluatePlatformAccess(platform, workspaceId, 'agents', 'execute', (options.now ?? Date.now)());
      if (!access.managed || !access.allowed) throw new ReferenceAccessError(403, 'reference_forbidden');
      return centralReaderSchema.parse({ subjectId, workspaceId, authVersion: user.authVersion, authorityRevision: platform.revision });
    },
    async assertOwner(userId, connection) {
      const { user, platform } = await snapshot(userId, connection);
      const matches = platform.memberships.filter(member => member.userId === userId);
      const member = matches[0];
      if (matches.length !== 1 || !member || member.status !== 'active' || member.role !== 'owner') throw new ReferenceAccessError(403, 'reference_owner_required');
      return centralOwnerSchema.parse({ userId, authVersion: user.authVersion, platformRevision: platform.revision, sessionVersion: member.sessionVersion });
    }
  };
}

/** Same transaction and users→platform lock order as the existing account writer. */
export function createMysqlReferenceAuthority(pool: Pool, isMutationPending?: (id: string) => boolean): ReferenceAuthorityReader {
  return createReferenceAuthorityReader({ isMutationPending, async readSnapshot(subjectId, connection) {
    const db = connection ?? pool, lock = connection ? ' FOR SHARE' : '';
    const [users] = await db.execute<RowDataPacket[]>(`SELECT id,team_id,status,auth_version FROM users WHERE id=?${lock}`, [subjectId]);
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT payload FROM platform_administration_state WHERE id=1${lock}`);
    const row = users.length === 1 ? users[0]! : null;
    return { user: row ? { id: row.id, teamId: row.team_id, status: row.status, authVersion: Number(row.auth_version) } : null,
      platform: rows.length === 1 ? (typeof rows[0]!.payload === 'string' ? JSON.parse(rows[0]!.payload) : rows[0]!.payload) : null };
  } });
}
