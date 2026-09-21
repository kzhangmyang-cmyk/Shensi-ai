import type {
  AcquisitionDouyinIdentityResolutionOperation,
  AcquisitionDouyinIdentityResolutionScope
} from "./acquisition-douyin-identity-resolution-operations.js";

interface RecoveryTimer {
  unref?(): void;
}

export interface AcquisitionDouyinIdentityResolutionRecoveryPort {
  listRecoverableOperations(options: {
    limit: number;
  }): Promise<AcquisitionDouyinIdentityResolutionOperation[]>;
}

export interface AcquisitionDouyinIdentityResolutionRecoverySweeperOptions {
  service: AcquisitionDouyinIdentityResolutionRecoveryPort;
  dispatch(
    scope: AcquisitionDouyinIdentityResolutionScope,
    operationId: string
  ): Promise<unknown>;
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

export class AcquisitionDouyinIdentityResolutionRecoverySweeper {
  private readonly service: AcquisitionDouyinIdentityResolutionRecoveryPort;
  private readonly dispatch:
    AcquisitionDouyinIdentityResolutionRecoverySweeperOptions["dispatch"];
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly setTimer: NonNullable<
    AcquisitionDouyinIdentityResolutionRecoverySweeperOptions["setTimer"]
  >;
  private readonly clearTimer: NonNullable<
    AcquisitionDouyinIdentityResolutionRecoverySweeperOptions["clearTimer"]
  >;
  private readonly onError: (error: unknown) => void;
  private timer: RecoveryTimer | null = null;
  private activeSweep: Promise<void> | null = null;
  private started = false;
  private stopped = false;

  constructor(
    options: AcquisitionDouyinIdentityResolutionRecoverySweeperOptions
  ) {
    this.service = options.service;
    this.dispatch = options.dispatch;
    this.intervalMs = boundedInterval(options.intervalMs);
    this.batchSize = boundedBatchSize(options.batchSize);
    this.setTimer = options.setTimer
      ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer
      ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.onError = options.onError ?? (() => undefined);
  }

  async start() {
    if (this.stopped) {
      throw new Error(
        "ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_RECOVERY_SWEEPER_STOPPED"
      );
    }
    if (this.started) return this.whenIdle();
    this.started = true;
    await this.runSweep();
  }

  whenIdle() {
    return this.activeSweep ?? Promise.resolve();
  }

  async stop() {
    if (this.stopped) return this.whenIdle();
    this.stopped = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    await this.whenIdle();
  }

  private runSweep() {
    if (this.stopped) return Promise.resolve();
    if (this.activeSweep) return this.activeSweep;
    const sweep = this.sweepOnce()
      .catch((error) => {
        this.onError(error);
      })
      .finally(() => {
        if (this.activeSweep === sweep) this.activeSweep = null;
        this.schedule();
      });
    this.activeSweep = sweep;
    return sweep;
  }

  private schedule() {
    if (this.stopped || this.timer) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.runSweep();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async sweepOnce() {
    const operations = await this.service.listRecoverableOperations({
      limit: this.batchSize
    });
    for (const operation of operations) {
      if (this.stopped) return;
      try {
        await this.dispatch({
          ownerId: operation.ownerId,
          teamId: operation.teamId,
          actorId: operation.actorId
        }, operation.id);
      } catch (error) {
        this.onError(error);
      }
    }
  }
}
