export interface AcquisitionLeadConversionRecoveryPort {
  runOnce(options?: { limit?: number }): Promise<{
    inspected: number;
    completed: number;
    failed: number;
  }>;
}

interface RecoveryTimer {
  unref?(): void;
}

export interface AcquisitionLeadConversionRecoverySweeperOptions {
  service: AcquisitionLeadConversionRecoveryPort;
  intervalMs?: number;
  batchSize?: number;
  setTimer?: (
    callback: () => void,
    delayMs: number
  ) => RecoveryTimer;
  clearTimer?: (timer: RecoveryTimer) => void;
  onError?: (error: unknown) => void;
}

function boundedInterval(value: number | undefined) {
  const resolved = value ?? 60_000;
  if (!Number.isSafeInteger(resolved)
    || resolved < 1_000
    || resolved > 24 * 60 * 60_000) {
    throw new TypeError("intervalMs must be between 1000 and 86400000");
  }
  return resolved;
}

function boundedBatchSize(value: number | undefined) {
  const resolved = value ?? 100;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 500) {
    throw new TypeError("batchSize must be between 1 and 500");
  }
  return resolved;
}

export class AcquisitionLeadConversionRecoverySweeper {
  readonly #service: AcquisitionLeadConversionRecoveryPort;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #setTimer: NonNullable<
    AcquisitionLeadConversionRecoverySweeperOptions["setTimer"]
  >;
  readonly #clearTimer: NonNullable<
    AcquisitionLeadConversionRecoverySweeperOptions["clearTimer"]
  >;
  readonly #onError: (error: unknown) => void;
  #timer: RecoveryTimer | null = null;
  #activeSweep: Promise<void> | null = null;
  #started = false;
  #closed = false;

  constructor(options: AcquisitionLeadConversionRecoverySweeperOptions) {
    this.#service = options.service;
    this.#intervalMs = boundedInterval(options.intervalMs);
    this.#batchSize = boundedBatchSize(options.batchSize);
    this.#setTimer = options.setTimer
      ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer
      ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.#onError = options.onError ?? (() => undefined);
  }

  async start() {
    if (this.#closed) {
      throw new Error("ACQUISITION_CONVERSION_RECOVERY_SWEEPER_CLOSED");
    }
    if (this.#started) return this.whenIdle();
    this.#started = true;
    await this.#runSweep();
  }

  whenIdle() {
    return this.#activeSweep ?? Promise.resolve();
  }

  async close() {
    if (this.#closed) return this.whenIdle();
    this.#closed = true;
    if (this.#timer) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    await this.whenIdle();
  }

  #runSweep() {
    if (this.#closed) return Promise.resolve();
    if (this.#activeSweep) return this.#activeSweep;
    const sweep = this.#service.runOnce({ limit: this.#batchSize })
      .then(() => undefined)
      .catch((error) => {
        this.#onError(error);
      })
      .finally(() => {
        if (this.#activeSweep === sweep) this.#activeSweep = null;
        this.#schedule();
      });
    this.#activeSweep = sweep;
    return sweep;
  }

  #schedule() {
    if (this.#closed || this.#timer) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.#runSweep();
    }, this.#intervalMs);
    this.#timer.unref?.();
  }
}
