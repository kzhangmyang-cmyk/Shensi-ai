import type { ConnectionRecord, ConnectionStore } from './connection-store.js';
/** External durable-store double; service, crypto, wire codec and transport stay real. */
export class TestConnectionStore implements ConnectionStore {
  records = new Map<string, ConnectionRecord>();
  private lock = Promise.resolve();
  async transaction<T>(backendInstanceId: string, actorId: string, operation: (row: ConnectionRecord) => Promise<T>): Promise<T> {
    const key = `${backendInstanceId}:${actorId}`; const prior = this.lock; let unlock!: () => void;
    this.lock = new Promise<void>(resolve => { unlock = resolve; }); await prior;
    try {
      const row = structuredClone(this.records.get(key) ?? { backendInstanceId, actorId, generation: 0, connections: [], tombstones: [] });
      const result = await operation(row); this.records.set(key, structuredClone(row)); return result;
    } finally { unlock(); }
  }
}
