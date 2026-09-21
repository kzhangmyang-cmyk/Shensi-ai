import type mysql from 'mysql2/promise';
import {encryptAgentJobPayload,decryptAgentJobPayload} from './agent-job-security.js';
import {GrowthHttpError} from './growth-command-context.js';
import {assertDecisionScope,type DecisionSimulationScope} from './decision-simulation-service.js';
import type {DecisionMemory} from './decision-memory.js';

export interface DecisionMemoryRepository {
  get(scope:DecisionSimulationScope):Promise<DecisionMemory|null>;
  save(scope:DecisionSimulationScope,value:DecisionMemory,expectedRevision:number):Promise<void>;
}
const key=(scope:DecisionSimulationScope)=>{assertDecisionScope(scope);return JSON.stringify([scope.workspaceId,scope.actorId]);};
const identity=(scope:DecisionSimulationScope)=>({id:'personal',teamId:scope.workspaceId,ownerId:scope.actorId,jobType:'decision-memory.v1'});
function check(value:DecisionMemory,expected:number){if(!Number.isSafeInteger(expected)||expected<0||value.revision!==expected+1)throw new GrowthHttpError(409,'decision_memory_revision_conflict');}
export class MemoryDecisionMemoryRepository implements DecisionMemoryRepository {
  private readonly rows=new Map<string,DecisionMemory>();
  async get(scope:DecisionSimulationScope){return structuredClone(this.rows.get(key(scope))??null);}
  async save(scope:DecisionSimulationScope,value:DecisionMemory,expected:number){
    const id=key(scope);check(value,expected);
    if((this.rows.get(id)?.revision??0)!==expected)throw new GrowthHttpError(409,'decision_memory_revision_conflict');
    this.rows.set(id,structuredClone(value));
  }
}
export const DECISION_MEMORY_SCHEMA=`CREATE TABLE IF NOT EXISTS decision_personal_memory (
 workspace_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 actor_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 revision BIGINT UNSIGNED NOT NULL,
 payload_encrypted MEDIUMTEXT NOT NULL,
 PRIMARY KEY (workspace_id,actor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;
export class MysqlDecisionMemoryRepository implements DecisionMemoryRepository {
  constructor(private readonly pool:Pick<mysql.Pool,'execute'>){}
  async get(scope:DecisionSimulationScope){
    key(scope);
    const [rows]=await this.pool.execute<mysql.RowDataPacket[]>('SELECT revision,payload_encrypted FROM decision_personal_memory WHERE workspace_id=? AND actor_id=?',[scope.workspaceId,scope.actorId]);
    if(!rows[0])return null;
    const decoded=decryptAgentJobPayload(identity(scope),'output',String(rows[0].payload_encrypted));
    if(decoded.revision!==Number(rows[0].revision)||!Array.isArray(decoded.reviews)||!('profile' in decoded))throw new Error('decision_memory_payload_invalid');
    return decoded as unknown as DecisionMemory;
  }
  async save(scope:DecisionSimulationScope,value:DecisionMemory,expected:number){
    key(scope);check(value,expected);
    const payload=encryptAgentJobPayload(identity(scope),'output',{...value});
    if(expected===0){
      try{await this.pool.execute('INSERT INTO decision_personal_memory (workspace_id,actor_id,revision,payload_encrypted) VALUES (?,?,?,?)',[scope.workspaceId,scope.actorId,value.revision,payload]);}
      catch(error){if((error as {code?:string}).code==='ER_DUP_ENTRY')throw new GrowthHttpError(409,'decision_memory_revision_conflict');throw error;}
    }else{
      const [result]=await this.pool.execute<mysql.ResultSetHeader>('UPDATE decision_personal_memory SET revision=?,payload_encrypted=? WHERE workspace_id=? AND actor_id=? AND revision=?',[value.revision,payload,scope.workspaceId,scope.actorId,expected]);
      if(result.affectedRows!==1)throw new GrowthHttpError(409,'decision_memory_revision_conflict');
    }
  }
}
