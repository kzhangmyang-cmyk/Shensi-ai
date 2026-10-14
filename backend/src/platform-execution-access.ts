import type mysql from 'mysql2/promise';
import { emptyPlatformState, evaluatePlatformAccess, type PlatformAdminState, type PlatformFeature } from './platform-admin-domain.js';

export type PlatformExecutionAccess = (workspaceId: string, now: string,
  connection?: Pick<mysql.PoolConnection, 'execute'>) => Promise<boolean>;

/** Fresh authority only: failures close execution without changing an action or receipt. */
export function createPlatformExecutionAccess(options: {
  feature?: PlatformFeature;
  readState?: () => Promise<PlatformAdminState>;
  isMutationPending?: () => boolean;
  mysql?: Pick<mysql.Pool, 'execute'>;
}): PlatformExecutionAccess {
  return async (workspaceId, now, connection) => {
    try {
      let state: PlatformAdminState;
      if (options.mysql) {
        const [rows] = await (connection ?? options.mysql).execute<mysql.RowDataPacket[]>(
          `SELECT payload FROM platform_administration_state WHERE id=1${connection ? ' FOR SHARE' : ''}`);
        state = rows.length === 0 ? emptyPlatformState()
          : typeof rows[0]!.payload === 'string' ? JSON.parse(rows[0]!.payload) : rows[0]!.payload;
      } else {
        if (!options.readState) return false;
        state = await options.readState();
      }
      if (!Number.isFinite(Date.parse(now))) return false;
      const access = evaluatePlatformAccess(state, workspaceId, options.feature ?? 'outreach', 'execute', Date.parse(now));
      return access.allowed && !(access.managed && options.isMutationPending?.());
    } catch { return false; }
  };
}
