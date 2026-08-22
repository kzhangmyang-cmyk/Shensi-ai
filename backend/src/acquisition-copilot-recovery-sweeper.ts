export interface AcquisitionRecoveryScope {
  ownerId: string;
  teamId: string;
  actorId: string;
}

export interface AcquisitionRecoverableTask
extends AcquisitionRecoveryScope {
  id: string;
}

export interface AcquisitionCopilotRecoveryPort {
  recoverInterruptedTasks(input: {
    staleRunningBefore: string;
  }): Promise<AcquisitionRecoverableTask[]>;
  claimTaskDispatch(
    scope: AcquisitionRecoveryScope,
    taskId: string
  ): Promise<boolean>;
  markDispatchFailed(
    scope: AcquisitionRecoveryScope,
    taskId: string,
    errorCode: string
  ): Promise<unknown>;
}

interface RecoveryTimer {
  unref?(): void;
}

export interface AcquisitionCopilotRecoverySweeperOptions {
  service: AcquisitionCopilotRecoveryPort;
  dispatchTask(
    scope: AcquisitionRecoveryScope,
    taskId: string
  ): Promise<unknown>;
  intervalMs?: number;
  staleRunningMs?: number;
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
    || resolved > 24 * 60 * 60 * 1_000) {
    throw new TypeError(`${label} must be between 1000 and 86400000`);
  }
  return resolved;
}

export class AcquisitionCopilotRecoverySweeper {
  private readonly service: AcquisitionCopilotRecoveryPort;
  private readonly dispatchTask:
    AcquisitionCopilotRecoverySweeperOptions["dispatchTask"];
  private readonly intervalMs: number;
  private readonly staleRunningMs: number;
  private readonly nowMs: () => number;
  private readonly setTimer:
    NonNullable<AcquisitionCopilotRecoverySweeperOptions["setTimer"]>;
  private readonly clearTimer:
    NonNullable<AcquisitionCopilotRecoverySweeperOptions["clearTimer"]>;
  private readonly onError: (error: unknown) => void;
  private timer: RecoveryTimer | null = null;
  private activeSweep: Promise<void> | null = null;
  private started = false;
  private closed = false;

  constructor(options: AcquisitionCopilotRecoverySweeperOptions) {
    this.service = options.service;
    this.dispatchTask = options.dispatchTask;
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
    this.nowMs = options.nowMs ?? Date.now;
    this.setTimer = options.setTimer
      ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer
      ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.onError = options.onError ?? (() => undefined);
  }

  async start() {
    if (this.closed) {
      throw new Error("ACQUISITION_RECOVERY_SWEEPER_CLOSED");
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
    const tasks = await this.service.recoverInterruptedTasks({
      staleRunningBefore: new Date(
        this.nowMs() - this.staleRunningMs
      ).toISOString()
    });
    for (const task of tasks) {
      if (this.closed) return;
      const scope = {
        ownerId: task.ownerId,
        teamId: task.teamId,
        actorId: task.actorId
      };
      if (!await this.service.claimTaskDispatch(scope, task.id)) {
        continue;
      }
      void Promise.resolve()
        .then(() => this.dispatchTask(scope, task.id))
        .catch(async () => {
        try {
          await this.service.markDispatchFailed(
            scope,
            task.id,
            "COPILOT_DISPATCH_FAILED"
          );
        } catch (error) {
          this.onError(error);
        }
        });
    }
  }
}
