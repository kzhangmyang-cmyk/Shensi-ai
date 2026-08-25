import type { AcquisitionOutreachBatchRepository } from "./acquisition-outreach-batch-repository.js";

export class AcquisitionOutreachActionRecoverySweeper {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly options: { repository: AcquisitionOutreachBatchRepository;
    now(): string; intervalMs?: number }) {}
  async runOnce() { return this.options.repository.recoverExpiredActionClaims(this.options.now()); }
  start() {
    if (this.timer || this.closed) return;
    const tick = () => { this.running = this.running.then(() => this.runOnce()).catch(() => undefined); };
    tick(); this.timer = setInterval(tick, this.options.intervalMs ?? 5_000); this.timer.unref();
  }
  async close() {
    if (this.closed) return; this.closed = true;
    if (this.timer) clearInterval(this.timer); this.timer = null; await this.running;
  }
}
