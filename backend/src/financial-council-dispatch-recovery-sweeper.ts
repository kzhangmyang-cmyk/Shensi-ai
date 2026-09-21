export class FinancialCouncilDispatchRecoverySweeper {
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;
  #closed = false;
  constructor(private readonly options: {
    repository: { listRecoverableDispatches(now: string, limit: number): Promise<readonly { workspaceId: string; dispatchId: string }[]> };
    worker: { wake(input: { workspaceId: string; dispatchId: string }): Promise<void>; close(): Promise<void> };
    now: () => string; intervalMs: number; batchSize: number;
    onError: (error: unknown, dispatchId: string | null) => void;
  }) {}
  start(): void { if (this.#closed || this.#timer) return; void this.sweepOnce().catch((e) => this.options.onError(e, null)); this.#timer = setInterval(() => void this.sweepOnce().catch((e) => this.options.onError(e, null)), this.options.intervalMs); this.#timer.unref?.(); }
  sweepOnce(): Promise<void> { if (this.#closed) return Promise.resolve(); if (this.#inFlight) return this.#inFlight; this.#inFlight = this.sweep().finally(() => { this.#inFlight = null; }); return this.#inFlight; }
  private async sweep(): Promise<void> { for (const row of await this.options.repository.listRecoverableDispatches(this.options.now(), this.options.batchSize)) { try { await this.options.worker.wake(row); } catch (error) { this.options.onError(error, row.dispatchId); } } }
  async close(): Promise<void> { this.#closed = true; if (this.#timer) clearInterval(this.#timer); this.#timer = null; await this.#inFlight; await this.options.worker.close(); }
}
