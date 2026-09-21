interface RecoveryTimer {
  unref?(): void;
}

export interface AcquisitionDouyinCommentIngestionRecoveryPort {
  recoverPendingIngestionSagas(options: { limit: number }): Promise<number>;
}

export interface AcquisitionDouyinCommentIngestionRecoverySweeperOptions {
  service: AcquisitionDouyinCommentIngestionRecoveryPort;
  intervalMs?: number;
  batchSize?: number;
  setTimer?: (callback: () => void, delayMs: number) => RecoveryTimer;
  clearTimer?: (timer: RecoveryTimer) => void;
  onError?: (error: unknown) => void;
}

function boundedInterval(value: number | undefined) {
  const interval = value ?? 60_000;
  if (!Number.isSafeInteger(interval)
    || interval < 1_000
    || interval > 24 * 60 * 60_000) {
    throw new TypeError("intervalMs must be between 1000 and 86400000");
  }
  return interval;
}

function boundedBatchSize(value: number | undefined) {
  const batchSize = value ?? 100;
  if (!Number.isSafeInteger(batchSize)
    || batchSize < 1
    || batchSize > 100) {
    throw new TypeError("batchSize must be between 1 and 100");
  }
  return batchSize;
}

export class AcquisitionDouyinCommentIngestionRecoverySweeper {
  private readonly service: AcquisitionDouyinCommentIngestionRecoveryPort;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly setTimer:
    NonNullable<AcquisitionDouyinCommentIngestionRecoverySweeperOptions[
      "setTimer"
    ]>;
  private readonly clearTimer:
    NonNullable<AcquisitionDouyinCommentIngestionRecoverySweeperOptions[
      "clearTimer"
    ]>;
  private readonly onError: (error: unknown) => void;
  private timer: RecoveryTimer | null = null;
  private activeSweep: Promise<void> | null = null;
  private started = false;
  private closed = false;

  constructor(options: AcquisitionDouyinCommentIngestionRecoverySweeperOptions) {
    this.service = options.service;
    this.intervalMs = boundedInterval(options.intervalMs);
    this.batchSize = boundedBatchSize(options.batchSize);
    this.setTimer = options.setTimer
      ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer
      ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.onError = options.onError ?? (() => undefined);
  }

  async start() {
    if (this.closed) {
      throw new Error("ACQUISITION_DOUYIN_COMMENT_RECOVERY_SWEEPER_CLOSED");
    }
    if (this.started) return this.whenIdle();
    this.started = true;
    await this.runSweep();
  }

  whenIdle() {
    return this.activeSweep ?? Promise.resolve();
  }

  async close() {
    if (this.closed) return this.whenIdle();
    this.closed = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    await this.whenIdle();
  }

  private runSweep() {
    if (this.closed) return Promise.resolve();
    if (this.activeSweep) return this.activeSweep;
    const sweep = this.service.recoverPendingIngestionSagas({
      limit: this.batchSize
    }).then(() => undefined).catch((error) => {
      this.onError(error);
    }).finally(() => {
      if (this.activeSweep === sweep) this.activeSweep = null;
      this.schedule();
    });
    this.activeSweep = sweep;
    return sweep;
  }

  private schedule() {
    if (this.closed || this.timer) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.runSweep();
    }, this.intervalMs);
    this.timer.unref?.();
  }
}
