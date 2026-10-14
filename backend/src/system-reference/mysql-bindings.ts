import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { bindingRecordSchema, type BindingRecord, type BindingRepository } from './binding-repository.js';
import { ReferenceAccessError } from './authority.js';

/** Explicit central startup only; never called merely by importing this module. */
export async function initializeReferenceBindings(pool: Pool) {
  await pool.execute(`CREATE TABLE IF NOT EXISTS system_reference_bindings (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL UNIQUE,
    retain_until BIGINT NOT NULL,
    payload JSON NOT NULL,
    INDEX reference_binding_retention (retain_until)
  ) ENGINE=InnoDB`);
}
const retainUntil = (row: BindingRecord) => Math.max(row.expiresAt, row.tokenExpiresAt ?? 0) + 7 * 86400000;
export class MysqlBindingRepository implements BindingRepository {
  constructor(private readonly pool: Pool) {}
  async insert(record: BindingRecord): Promise<void> {
    const row = bindingRecordSchema.parse(record);
    try {
      await this.pool.execute('INSERT INTO system_reference_bindings (id,token_hash,retain_until,payload) VALUES (?,?,?,?)',
        [row.id, row.tokenHash, retainUntil(row), JSON.stringify(row)]);
    } catch { throw new ReferenceAccessError(503, 'reference_persistence_unconfirmed'); }
  }
  async findToken(hash: string): Promise<string | null> {
    if (!/^[a-f0-9]{64}$/u.test(hash)) return null;
    try {
      const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT id FROM system_reference_bindings WHERE token_hash=?', [hash]);
      return rows.length === 1 ? String(rows[0]!.id) : null;
    } catch { throw new ReferenceAccessError(503, 'reference_persistence_unconfirmed'); }
  }
  async transaction<T>(id: string, operation: (record: BindingRecord | null, connection?: PoolConnection) => Promise<T>): Promise<T> {
    let connection: PoolConnection;
    try { connection = await this.pool.getConnection(); }
    catch { throw new ReferenceAccessError(503, 'reference_persistence_unconfirmed'); }
    let commitStarted = false, destroyed = false;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>('SELECT payload FROM system_reference_bindings WHERE id=? FOR UPDATE', [id]);
      const value = rows.length === 1 ? rows[0]!.payload : null;
      const row = value ? bindingRecordSchema.parse(typeof value === 'string' ? JSON.parse(value) : value) : null;
      if (row && row.id !== id) throw new ReferenceAccessError(503, 'reference_persistence_unconfirmed');
      const before = row ? JSON.stringify(row) : null;
      const result = await operation(row, connection);
      if (row && JSON.stringify(row) !== before) {
        bindingRecordSchema.parse(row);
        await connection.execute('UPDATE system_reference_bindings SET token_hash=?,retain_until=?,payload=? WHERE id=?',
          [row.tokenHash, retainUntil(row), JSON.stringify(row), id]);
      }
      commitStarted = true; await connection.commit(); return result;
    } catch (error) {
      try { await connection.rollback(); } catch { destroyed = true; }
      if (commitStarted) destroyed = true;
      if (!commitStarted && error instanceof ReferenceAccessError) throw error;
      throw new ReferenceAccessError(503, 'reference_persistence_unconfirmed');
    } finally {
      if (destroyed) connection.destroy(); else connection.release();
    }
  }
  async readForReferenceTransaction(id:string,connection?:PoolConnection):Promise<BindingRecord|null>{
    if(!connection)throw new ReferenceAccessError(503,'reference_persistence_unconfirmed');
    try{
      const [rows]=await connection.execute<RowDataPacket[]>('SELECT payload FROM system_reference_bindings WHERE id=? FOR SHARE',[id]);
      const value=rows.length===1?rows[0]!.payload:null;
      const row=value?bindingRecordSchema.parse(typeof value==='string'?JSON.parse(value):value):null;
      if(row&&row.id!==id)throw Error('binding identity mismatch');return row;
    }catch{throw new ReferenceAccessError(503,'reference_persistence_unconfirmed');}
  }
}
