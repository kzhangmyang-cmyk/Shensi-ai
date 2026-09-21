import type {
  AcquisitionDiscoveryScope,
  AcquisitionRecoverableDiscoveryOperation
} from "./acquisition-discovery-operations.js";

interface RecoveryTimer {
  unref?(): void;
}

export interface AcquisitionDiscoveryRecoveryPort {
  recoverInterruptedOperations(input: {
    staleRunningBefore: string;
    limit?: number;
  }): Promise<AcquisitionRecoverableDiscoveryOperation[]>;
}

export interface AcquisitionDiscoveryRecoverySweeperOptions {
  service: AcquisitionDiscoveryRecoveryPort;
  dispatchContentFetchOperation(
    scope: AcquisitionDiscoveryScope,
    operationId: string,
    executionId?: string
  ): Promise<unknown>;
  dispatchImportOperation(
    scope: AcquisitionDiscoveryScope,
    operationId: string
  ): Promise<unknown>;
  intervalMs?: number;
  staleRunningMs?: number;
  batchSize?: number;
  nowMs?: () => number;
  setTimer?: (
    callback: () => void,
    delayMs: number
  ) => RecoveryTimer;
  clearTimer?: (timer: RecoveryTimer) => void;
  onError?: (error: unknown) => void;
}

function boundedMilliseconds(
  value: number | undefined,
  fallback: number,
  label: string
) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved)
    || resolved < 1_000
    || resolved > 24 * 60 * 60_000) {
    throw new TypeError(`${label} must be between 1000 and 86400000`);
  }
  return resolved;
}

function boundedBatchSize(value: number | undefined) {
  const resolved = value ?? 100;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 100) {
    throw new TypeError("batchSize must be between 1 and 100");
  }
  return resolved;
}

export class AcquisitionDiscoveryRecoverySweeper {
  private readonly service: AcquisitionDiscoveryRecoveryPort;
  private readonly dispatchContentFetchOperation:
    AcquisitionDiscoveryRecoverySweeperOptions[
      "dispatchContentFetchOperation"
    ];
  private readonly dispatchImportOperation:
    AcquisitionDiscoveryRecoverySweeperOptions[
      "dispatchImportOperation"
    ];
  private readonly intervalMs: number;
  private readonly staleRunningMs: number;
  private readonly batchSize: number;
  private readonly nowMs: () => number;
  private readonly setTimer:
    NonNullable<AcquisitionDiscoveryRecoverySweeperOptions["setTimer"]>;
  private readonly clearTimer:
    NonNullable<AcquisitionDiscoveryRecoverySweeperOptions["clearTimer"]>;
  private readonly onError: (error: unknown) => void;
  private timer: RecoveryTimer | null = null;
  private activeSweep: Promise<void> | null = null;
  private started = false;
  private closed = false;

  constructor(options: AcquisitionDiscoveryRecoverySweeperOptions) {
    this.service = options.service;
    this.dispatchContentFetchOperation =
      options.dispatchContentFetchOperation;
    this.dispatchImportOperation = options.dispatchImportOperation;
    this.intervalMs = boundedMilliseconds(
      options.intervalMs,
      60_000,
      "intervalMs"
    );
    this.staleRunningMs = boundedMilliseconds(
      options.staleRunningMs,
      10 * 60_000,
      "staleRunningMs"
    );
    this.batchSize = boundedBatchSize(options.batchSize);
    this.nowMs = options.nowMs ?? Date.now;
    this.setTimer = options.setTimer
      ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer
      ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.onError = options.onError ?? (() => undefined);
  }

  async start() {
    if (this.closed) {
      throw new Error("ACQUISITION_DISCOVERY_RECOVERY_SWEEPER_CLOSED");
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
    const sweep = this.sweepOnce()
      .catch((error) => {
        this.onError(error);
      })
      .finally(() => {
        if (this.activeSweep === sweep) {
          this.activeSweep = null;
        }
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

  private async sweepOnce() {
    const operations = await this.service.recoverInterruptedOperations({
      staleRunningBefore: new Date(
        this.nowMs() - this.staleRunningMs
      ).toISOString(),
      limit: this.batchSize
    });
    for (const operation of operations) {
      if (this.closed) return;
      const scope = {
        ownerId: operation.ownerId,
        teamId: operation.teamId,
        actorId: operation.actorId
      };
      try {
        if (operation.kind === "content_fetch"
          || operation.kind === "content_fetch_comment_enrichment") {
          await this.dispatchContentFetchOperation(
            scope,
            operation.id,
            operation.executionId
          );
        } else {
          await this.dispatchImportOperation(scope, operation.id);
        }
      } catch (error) {
        this.onError(error);
      }
    }
  }
}
