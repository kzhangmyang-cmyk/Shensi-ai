import type { AcquisitionCrawlerJobRepository } from "./acquisition-crawler-job-repository.js";

export class AcquisitionCrawlerRecoverySweeper {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  constructor(private readonly options: {
    repository: AcquisitionCrawlerJobRepository;
    now?: () => string;
    intervalMs?: number;
  }) {}
  sweep() {
    if (this.running) return this.running;
    const current = this.options.repository.sweepExpired(
      (this.options.now ?? (() => new Date().toISOString()))()
    );
    this.running = current.finally(() => { if (this.running === current) this.running = null; });
    return this.running;
  }
  start() {
    if (this.timer) return;
    const interval = this.options.intervalMs ?? 10_000;
    this.timer = setInterval(() => { void this.sweep(); }, interval);
    this.timer.unref();
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
