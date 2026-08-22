export interface AcquisitionPlanExecutionRecoveryPort {
  recoverExecutionIntents(actorId: string): Promise<number>;
}

interface RecoveryTimer {
  unref?(): void;
}

export interface AcquisitionPlanExecutionRecoverySweeperOptions {
  service: AcquisitionPlanExecutionRecoveryPort;
  intervalMs?: number;
  actorId?: string;
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

function recoveryActorId(value: string | undefined) {
  const resolved = value?.trim()
    || "acquisition-plan-execution-recovery";
  if (resolved.length > 255) {
    throw new TypeError("actorId must contain between 1 and 255 characters");
  }
  return resolved;
}

export class AcquisitionPlanExecutionRecoverySweeper {
  readonly #service: AcquisitionPlanExecutionRecoveryPort;
  readonly #intervalMs: number;
  readonly #actorId: string;
  readonly #setTimer: NonNullable<
    AcquisitionPlanExecutionRecoverySweeperOptions["setTimer"]
  >;
  readonly #clearTimer: NonNullable<
    AcquisitionPlanExecutionRecoverySweeperOptions["clearTimer"]
  >;
  readonly #onError: (error: unknown) => void;
  #timer: RecoveryTimer | null = null;
  #activeSweep: Promise<void> | null = null;
  #started = false;
  #closed = false;

  constructor(options: AcquisitionPlanExecutionRecoverySweeperOptions) {
    this.#service = options.service;
    this.#intervalMs = boundedInterval(options.intervalMs);
    this.#actorId = recoveryActorId(options.actorId);
    this.#setTimer = options.setTimer
      ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer
      ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.#onError = options.onError ?? (() => undefined);
  }

  async start() {
    if (this.#closed) {
      throw new Error("ACQUISITION_PLAN_EXECUTION_RECOVERY_SWEEPER_CLOSED");
    }
    if (this.#started) return this.whenIdle();
    this.#started = true;
    await this.#runSweep(true);
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

  #runSweep(propagateFailure = false) {
    if (this.#closed) return Promise.resolve();
    if (this.#activeSweep) return this.#activeSweep;
    const sweep = this.#service.recoverExecutionIntents(this.#actorId)
      .then(() => undefined)
      .catch((error) => {
        this.#onError(error);
        if (propagateFailure) throw error;
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
