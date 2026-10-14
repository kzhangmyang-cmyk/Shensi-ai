import type mysql from 'mysql2/promise';
import { encryptAgentJobPayload, decryptAgentJobPayload } from './agent-job-security.js';
import { assertDecisionScope, type DecisionSimulationRepository, type DecisionSimulationScope, type DecisionSimulationRecord, type DecisionSimulationListItem } from './decision-simulation-service.js';

export const DECISION_SIMULATION_SCHEMA = `CREATE TABLE IF NOT EXISTS decision_simulation_runs (
 workspace_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 actor_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 title VARCHAR(100) NOT NULL, data_kind VARCHAR(20) NOT NULL,
 created_at VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload_encrypted MEDIUMTEXT NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,run_id), KEY idx_decision_recent(workspace_id,actor_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;
const identity = (scope: DecisionSimulationScope, id: string) => ({ id, teamId: scope.workspaceId, ownerId: scope.actorId, jobType: 'decision-simulation.v1' });
export class MysqlDecisionSimulationRepository implements DecisionSimulationRepository {
  constructor(private readonly pool: Pick<mysql.Pool, 'execute'>) {}
  async get(scope: DecisionSimulationScope, id: string) {
    assertDecisionScope(scope);
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>('SELECT payload_encrypted FROM decision_simulation_runs WHERE workspace_id=? AND actor_id=? AND run_id=?', [scope.workspaceId, scope.actorId, id]);
    if (!rows[0]) return null;
    const record = decryptAgentJobPayload(identity(scope, id), 'output', String(rows[0].payload_encrypted));
    if (record.recordVersion !== 'decision-simulation.v1' || record.runId !== id) throw new Error('decision_simulation_record_invalid');
    return record as unknown as DecisionSimulationRecord;
  }
  async list(scope: DecisionSimulationScope): Promise<DecisionSimulationListItem[]> {
    assertDecisionScope(scope);
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>('SELECT run_id,title,data_kind,created_at FROM decision_simulation_runs WHERE workspace_id=? AND actor_id=? ORDER BY created_at DESC,run_id ASC LIMIT 50', [scope.workspaceId, scope.actorId]);
    return rows.map(row => ({ runId: String(row.run_id), title: String(row.title), dataKind: row.data_kind, createdAt: String(row.created_at) }));
  }
  async insert(scope: DecisionSimulationScope, record: DecisionSimulationRecord) {
    assertDecisionScope(scope);
    const encrypted = encryptAgentJobPayload(identity(scope, record.runId), 'output', { ...record });
    try {
      await this.pool.execute('INSERT INTO decision_simulation_runs (workspace_id,actor_id,run_id,title,data_kind,created_at,payload_encrypted) VALUES (?,?,?,?,?,?,?)', [scope.workspaceId, scope.actorId, record.runId, record.input.title, record.input.dataKind, record.createdAt, encrypted]);
      return true;
    } catch (error) { if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return false; throw error; }
  }
}
