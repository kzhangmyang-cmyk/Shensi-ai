import type mysql from 'mysql2/promise';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';
import { GrowthHttpError } from './growth-command-context.js';
import { encryptAgentJobPayload, decryptAgentJobPayload } from './agent-job-security.js';
import { xhsStorageIdentity, type XhsMessagingRepository, type XhsMessagingState } from './xiaohongshu-messaging.js';

export const XHS_MESSAGING_SCHEMA = `CREATE TABLE IF NOT EXISTS xiaohongshu_messaging (
  workspace_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  payload_encrypted MEDIUMTEXT NOT NULL,
  PRIMARY KEY (workspace_id, actor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;

export class MysqlXhsMessagingRepository implements XhsMessagingRepository {
  constructor(private pool:Pick<mysql.Pool,'execute'>) {}
  async read(context:ActiveWorkspaceContext):Promise<XhsMessagingState> {
    const identity = xhsStorageIdentity(context);
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      'SELECT revision, payload_encrypted FROM xiaohongshu_messaging WHERE workspace_id = ? AND actor_id = ?',
      [context.workspaceId,context.actorId]);
    if (!rows[0]) return {revision:0,drafts:[]};
    const state = decryptAgentJobPayload(identity,'output',String(rows[0].payload_encrypted)) as unknown as XhsMessagingState;
    if (state.revision !== Number(rows[0].revision) || !Array.isArray(state.drafts)) throw new Error('xhs_storage_invalid');
    return state;
  }
  async save(context:ActiveWorkspaceContext,state:XhsMessagingState,expected:number) {
    const identity=xhsStorageIdentity(context);
    const conflict = () => new GrowthHttpError(409,'xhs_revision_conflict');
    if (!Number.isSafeInteger(expected) || expected < 0 || state.revision !== expected+1) throw conflict();
    const encrypted=encryptAgentJobPayload(identity,'output',{...state});
    if (expected === 0) {
      try {
        await this.pool.execute('INSERT INTO xiaohongshu_messaging (workspace_id, actor_id, revision, payload_encrypted) VALUES (?, ?, ?, ?)',
          [context.workspaceId,context.actorId,state.revision,encrypted]);
      } catch(error) {
        if ((error as {code?:string}).code === 'ER_DUP_ENTRY') throw conflict();
        throw error;
      }
    } else {
      const [result]=await this.pool.execute<mysql.ResultSetHeader>(
        'UPDATE xiaohongshu_messaging SET revision = ?, payload_encrypted = ? WHERE workspace_id = ? AND actor_id = ? AND revision = ?',
        [state.revision,encrypted,context.workspaceId,context.actorId,expected]);
      if (result.affectedRows !== 1) throw conflict();
    }
  }
}
