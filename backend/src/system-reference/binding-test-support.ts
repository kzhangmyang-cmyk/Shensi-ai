import type { PoolConnection } from 'mysql2/promise';
import type { BindingRecord, BindingRepository } from './binding-repository.js';

// External persistence double only; authorization, proof and state transitions
// run through the production service. No memory fallback in production.
export class TestBindingRepository implements BindingRepository {
  records = new Map<string, BindingRecord>();
  private queue: Promise<unknown> = Promise.resolve();
  async insert(record: BindingRecord) { this.records.set(record.id, structuredClone(record)); }
  async transaction<T>(id: string, operation: (record: BindingRecord | null, connection?: PoolConnection) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const row = structuredClone(this.records.get(id) ?? null);
      const result = await operation(row);
      if (row) this.records.set(id, row);
      return result;
    });
    this.queue = run.catch(() => {}); return run;
  }
  async findToken(hash: string) { return [...this.records.values()].find(row => row.tokenHash === hash)?.id ?? null; }
  async readForReferenceTransaction(id:string,_connection?:PoolConnection){return structuredClone(this.records.get(id)??null);}
}
