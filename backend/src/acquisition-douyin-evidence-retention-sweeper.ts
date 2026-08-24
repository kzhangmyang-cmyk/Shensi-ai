import type {
  AcquisitionDouyinEvidenceRetentionRepository
} from "./acquisition-douyin-crawler-ingestion-repository.js";

export class AcquisitionDouyinEvidenceRetentionSweeper {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<number> | null = null;

  constructor(private readonly options: {
    repository: AcquisitionDouyinEvidenceRetentionRepository;
    now?: () => string;
    intervalMs?: number;
    batchSize?: number;
  }) {}

  runOnce() {
    if (this.active) return this.active;
    const running = this.options.repository.cleanupAllExpiredUnlinked(
      this.options.now?.() ?? new Date().toISOString(),
      this.options.batchSize ?? 100
    );
    const tracked = running.finally(() => {
      if (this.active === tracked) this.active = null;
    });
    this.active = tracked;
    return tracked;
  }

  start() {
    if (this.timer) return;
    const intervalMs = this.options.intervalMs ?? 60 * 60 * 1_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10) {
      throw new TypeError("invalid_douyin_evidence_retention_interval");
    }
    this.timer = setInterval(() => { void this.runOnce().catch(() => undefined); }, intervalMs);
    this.timer.unref();
    void this.runOnce().catch(() => undefined);
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active?.catch(() => undefined);
  }
}
