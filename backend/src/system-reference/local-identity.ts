import type {Pool,PoolConnection,RowDataPacket} from 'mysql2/promise';
import {isAccountMutationPending} from '../account-mutation-state.js';
import {capabilitiesForHumanRole} from '../growth-capabilities.js';
import {emptyPlatformState,evaluatePlatformAccess,type PlatformAdminState} from '../platform-admin-domain.js';
import {assertKnowledgeScope,type KnowledgeScope} from '../knowledge/domain.js';
import {ReferenceAccessError} from './authority.js';
import type {LocalReferenceIdentity} from './connection-service.js';

/** Read the current durable local identity; local role never confers central rights. */
export function createMysqlLocalReferenceIdentity(pool:Pool,isMutationPending:(actorId:string)=>boolean=isAccountMutationPending){
  return async(ctx:KnowledgeScope,connection?:PoolConnection):Promise<LocalReferenceIdentity>=>{
    assertKnowledgeScope(ctx,'knowledge.read');
    const denied=()=>new ReferenceAccessError(401,'reference_connection_changed');
    if(isMutationPending(ctx.actorId))throw denied();
    const sql=connection??pool;
    const [users]=await sql.execute<RowDataPacket[]>('SELECT id,team_id,role,status,auth_version FROM users WHERE id=?',[ctx.actorId]);
    const user=users.length===1?users[0]:undefined;
    if(!user||user.id!==ctx.actorId||user.status!=='active'||user.team_id!==ctx.teamId||user.role!==ctx.role
      ||!Number.isSafeInteger(Number(user.auth_version))||Number(user.auth_version)<1
      ||!capabilitiesForHumanRole(user.role).includes('knowledge.read'))throw denied();
    const personal=`personal:${user.id}`;
    if(ctx.workspaceId!==personal&&ctx.workspaceId!==user.team_id){
      if(user.role!=='super_admin'||ctx.workspaceId==='all'||ctx.workspaceId.startsWith('personal:'))throw denied();
      const [members]=await sql.execute<RowDataPacket[]>('SELECT id FROM users WHERE team_id=? AND status=? LIMIT 1',[ctx.workspaceId,'active']);
      if(members.length!==1)throw denied();
    }
    const [rows]=await sql.execute<RowDataPacket[]>('SELECT payload FROM platform_administration_state WHERE id=1');
    if(rows.length>1)throw denied();
    const platform:PlatformAdminState=rows.length===0?emptyPlatformState()
      :typeof rows[0]!.payload==='string'?JSON.parse(rows[0]!.payload):rows[0]!.payload;
    if(!evaluatePlatformAccess(platform,user.team_id,'agents','execute',Date.now()).allowed||isMutationPending(ctx.actorId))throw denied();
    return {actorId:user.id,workspaceId:ctx.workspaceId,authVersion:Number(user.auth_version)};
  };
}
