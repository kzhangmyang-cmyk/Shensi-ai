import type {Pool,PoolConnection,RowDataPacket} from 'mysql2/promise';
import type {z} from 'zod';
import {z as schema} from 'zod';
import {ReferenceAccessError} from './authority.js';
import {referenceHash,referenceKindSchema,type ReferenceCrypto,type ReferenceKind} from './crypto.js';
import type {ReferenceRepository,ReferenceAuthorize,ReferenceTransaction} from './repository.js';
const tables:Record<ReferenceKind,string>={release:'system_reference_releases',source:'system_reference_sources',chunk:'system_reference_chunks',command:'system_reference_commands',grant:'system_reference_grants',budget:'system_reference_budgets',audit:'system_reference_audits'};
const uuid=schema.string().uuid(),keys=schema.array(schema.string().min(1).max(191)).min(1).max(6);
export async function initializeReferenceSchema(pool:Pool){
  for(const [kind,table] of Object.entries(tables))await pool.execute(`CREATE TABLE IF NOT EXISTS ${table} (
    corpus_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    record_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    release_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    payload MEDIUMTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY(corpus_id,record_id), ${kind==='release'?'UNIQUE KEY':'KEY'} reference_release_lookup(release_id)
  ) ENGINE=InnoDB`);
}
/** Independent encrypted corpus tables, never a private KnowledgeRepository scope. */
export class MysqlReferenceRepository implements ReferenceRepository {
  constructor(private readonly pool:Pool,private readonly crypto:ReferenceCrypto){}
  async corpusForRelease(id:string):Promise<string|null>{
    uuid.parse(id);try{const [rows]=await this.pool.execute<RowDataPacket[]>('SELECT corpus_id FROM system_reference_releases WHERE release_id=?',[id]);
      return rows.length===1?uuid.parse(rows[0]!.corpus_id):null;
    }catch{throw new ReferenceAccessError(503,'reference_persistence_unconfirmed');}
  }
  async transaction<T>(corpusId:string,authorize:ReferenceAuthorize,operation:(tx:ReferenceTransaction)=>Promise<T>):Promise<T>{
    uuid.parse(corpusId);let connection:PoolConnection;
    try{connection=await this.pool.getConnection();}catch{throw new ReferenceAccessError(503,'reference_persistence_unconfirmed');}
    let commitStarted=false,destroyed=false;
    try{
      await connection.beginTransaction();await authorize(connection);
      const pointer=['active'],pointerId=referenceHash(pointer);
      await connection.execute('INSERT INTO system_reference_releases (corpus_id,record_id,release_id,payload) VALUES (?,?,NULL,?) ON DUPLICATE KEY UPDATE record_id=record_id',
        [corpusId,pointerId,this.crypto.seal({corpusId,kind:'release',key:pointer},{id:null,revision:0})]);
      await connection.execute('SELECT payload FROM system_reference_releases WHERE corpus_id=? AND record_id=? FOR UPDATE',[corpusId,pointerId]);
      const tx:ReferenceTransaction={connection,
        releaseIds:async(after,limit)=>{
          if(after!==null)uuid.parse(after);schema.number().int().min(1).max(51).parse(limit);
          const [rows]=await connection.query<RowDataPacket[]>('SELECT release_id FROM system_reference_releases WHERE corpus_id=? AND release_id IS NOT NULL AND release_id>? ORDER BY release_id ASC LIMIT ?',[corpusId,after??'',limit]);
          return rows.map(row=>uuid.parse(row.release_id));
        },
        get:async<V>(kind:ReferenceKind,key:readonly string[],shape:z.ZodType<V>)=>{
          referenceKindSchema.parse(kind);keys.parse(key);const [rows]=await connection.execute<RowDataPacket[]>(`SELECT payload FROM ${tables[kind]} WHERE corpus_id=? AND record_id=?`,[corpusId,referenceHash(key)]);
          return rows.length===1?shape.parse(this.crypto.open({corpusId,kind,key},rows[0]!.payload)):null;
        },
        set:async(kind,key,value)=>{
          referenceKindSchema.parse(kind);keys.parse(key);const releaseId=kind==='release'&&key[0]==='release'?uuid.parse(key[1]):null;
          await connection.execute(`INSERT INTO ${tables[kind]} (corpus_id,record_id,release_id,payload) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)`,
            [corpusId,referenceHash(key),releaseId,this.crypto.seal({corpusId,kind,key},value)]);
        }
      };
      const result=await operation(tx);await authorize(connection);commitStarted=true;await connection.commit();return result;
    }catch(error){try{await connection.rollback();}catch{destroyed=true;}if(commitStarted)destroyed=true;
      if(!commitStarted&&!destroyed&&error instanceof ReferenceAccessError)throw error;throw new ReferenceAccessError(503,'reference_persistence_unconfirmed');
    }finally{if(destroyed)connection.destroy();else connection.release();}
  }
}
