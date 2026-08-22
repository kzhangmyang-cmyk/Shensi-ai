import type {
  AcquisitionVisualReaderRepository
} from "./acquisition-visual-reader-sessions.js";

interface ExpiryTimer {
  unref?(): void;
}

export interface AcquisitionVisualArtifactExpiryFailureReport {
  code: "ACQUISITION_VISUAL_ARTIFACT_EXPIRY_SWEEP_FAILED";
  attemptedLimit: number;
}

export interface AcquisitionVisualArtifactExpirySweeperOptions {
  repository: Pick<
    AcquisitionVisualReaderRepository,
    "deleteExpiredArtifacts"
  >;
  now?: () => string;
  intervalMs?: number;
  batchSize?: number;
  closeTimeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ExpiryTimer;
  clearTimer?: (timer: ExpiryTimer) => void;
  onError?: (report: AcquisitionVisualArtifactExpiryFailureReport) => void;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected)
    || selected < minimum
    || selected > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return selected;
}

export class AcquisitionVisualArtifactExpirySweeper {
  private readonly repository:
    AcquisitionVisualArtifactExpirySweeperOptions["repository"];
  private readonly now: () => string;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly closeTimeoutMs: number;
  private readonly setTimer: NonNullable<
    AcquisitionVisualArtifactExpirySweeperOptions["setTimer"]
  >;
  private readonly clearTimer: NonNullable<
    AcquisitionVisualArtifactExpirySweeperOptions["clearTimer"]
  >;
  private readonly onError: NonNullable<
    AcquisitionVisualArtifactExpirySweeperOptions["onError"]
  >;
  private timer: ExpiryTimer | null = null;
  private activeSweep: Promise<void> | null = null;
  private started = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: AcquisitionVisualArtifactExpirySweeperOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date().toISOString());
    this.intervalMs = boundedInteger(
      options.intervalMs,
      60 * 60_000,
      1_000,
      24 * 60 * 60_000,
      "intervalMs"
    );
    this.batchSize = boundedInteger(
      options.batchSize,
      100,
      1,
      100,
      "batchSize"
    );
    this.closeTimeoutMs = boundedInteger(
      options.closeTimeoutMs,
      5_000,
      1,
      60_000,
      "closeTimeoutMs"
    );
    this.setTimer = options.setTimer
      ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer
      ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.onError = options.onError ?? (() => undefined);
  }

  async start() {
    if (this.closed) {
      throw new Error("ACQUISITION_VISUAL_ARTIFACT_EXPIRY_SWEEPER_CLOSED");
    }
    if (this.started) return this.whenIdle();
    this.started = true;
    await this.runSweep();
  }

  whenIdle() {
    return this.activeSweep ?? Promise.resolve();
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.closePromise = this.waitForActiveSweep();
    return this.closePromise;
  }

  private waitForActiveSweep() {
    const active = this.whenIdle();
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      active,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          "ACQUISITION_VISUAL_ARTIFACT_EXPIRY_SWEEPER_CLOSE_TIMEOUT"
        )), this.closeTimeoutMs);
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private runSweep() {
    if (this.closed) return Promise.resolve();
    if (this.activeSweep) return this.activeSweep;
    const sweep = Promise.resolve().then(() =>
      this.repository.deleteExpiredArtifacts({
        before: this.now(),
        limit: this.batchSize
      })).then(() => undefined).catch(() => {
      try {
        this.onError({
          code: "ACQUISITION_VISUAL_ARTIFACT_EXPIRY_SWEEP_FAILED",
          attemptedLimit: this.batchSize
        });
      } catch {
        // Reporting is best effort and must not reject the periodic void path.
      }
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
