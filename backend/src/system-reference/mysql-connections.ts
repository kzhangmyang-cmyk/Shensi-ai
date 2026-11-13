import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { ReferenceAccessError } from './authority.js';
import { connectionRecordSchema, type ConnectionRecord, type ConnectionStore } from './connection-store.js';

/** Called only by explicit trusted module assembly; no import-time database writes. */
export async function initializeReferenceConnections(pool:Pool) {
  await pool.execute(`CREATE TABLE IF NOT EXISTS system_reference_connections (
    id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    payload JSON NOT NULL
  ) ENGINE=InnoDB`);
}
export class MysqlConnectionStore implements ConnectionStore {
  constructor(private readonly pool:Pool) {}
  async transaction<T>(backendInstanceId:string,actorId:string,operation:(row:ConnectionRecord)=>Promise<T>):Promise<T> {
    const initial=connectionRecordSchema.parse({backendInstanceId,actorId,generation:0,connections:[],tombstones:[]});
    const id=createHash('sha256').update(JSON.stringify([backendInstanceId,actorId])).digest('hex');
    let connection:PoolConnection;
    try {connection=await this.pool.getConnection();}catch{throw new ReferenceAccessError(503,'reference_persistence_unconfirmed');}
    let committing=false,destroyed=false;
    try {
      await connection.beginTransaction();
      await connection.execute('INSERT INTO system_reference_connections (id,payload) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id',[id,JSON.stringify(initial)]);
      const [rows]=await connection.execute<RowDataPacket[]>('SELECT payload FROM system_reference_connections WHERE id=? FOR UPDATE',[id]);
      if(rows.length!==1)throw Error();
      const row=connectionRecordSchema.parse(typeof rows[0]!.payload==='string'?JSON.parse(rows[0]!.payload):rows[0]!.payload);
      if(row.actorId!==actorId||row.backendInstanceId!==backendInstanceId)throw Error();
      const before=JSON.stringify(row),result=await operation(row);connectionRecordSchema.parse(row);
      if(JSON.stringify(row)!==before)await connection.execute('UPDATE system_reference_connections SET payload=? WHERE id=?',[JSON.stringify(row),id]);
      committing=true;await connection.commit();return result;
    } catch(error) {
      try {await connection.rollback();}catch{destroyed=true;}
      if(committing)destroyed=true;
      if(!committing&&error instanceof ReferenceAccessError)throw error;
      throw new ReferenceAccessError(503,'reference_persistence_unconfirmed');
    } finally {if(destroyed)connection.destroy();else connection.release();}
  }
}
