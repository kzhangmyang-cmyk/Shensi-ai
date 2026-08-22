import type {
  AcquisitionCrmOutcomeReconciliationResult
} from "./acquisition-crm-outcome-reconciliation.js";

interface TenantScope {
  ownerId: string;
  teamId: string;
}

interface WorkerTimer {
  unref?(): void;
}

export interface AcquisitionCrmOutcomeReconciliationWorkerOptions {
  service: {
    runTenant(
      scope: TenantScope,
      options: { limit: number }
    ): Promise<AcquisitionCrmOutcomeReconciliationResult>;
  };
  listTenantScopes(): TenantScope[] | Promise<TenantScope[]>;
  intervalMs?: number;
  batchSize?: number;
  setTimer?: (callback: () => void, delayMs: number) => WorkerTimer;
  clearTimer?: (timer: WorkerTimer) => void;
  onError?: (error: unknown, scope: TenantScope | null) => void;
}

export class AcquisitionCrmOutcomeReconciliationWorker {
  readonly #service: AcquisitionCrmOutcomeReconciliationWorkerOptions["service"];
  readonly #listTenantScopes:
    AcquisitionCrmOutcomeReconciliationWorkerOptions["listTenantScopes"];
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #setTimer: NonNullable<
    AcquisitionCrmOutcomeReconciliationWorkerOptions["setTimer"]
  >;
  readonly #clearTimer: NonNullable<
    AcquisitionCrmOutcomeReconciliationWorkerOptions["clearTimer"]
  >;
  readonly #onError: NonNullable<
    AcquisitionCrmOutcomeReconciliationWorkerOptions["onError"]
  >;
  #timer: WorkerTimer | null = null;
  #active: Promise<void> | null = null;
  #started = false;
  #closed = false;

  constructor(options: AcquisitionCrmOutcomeReconciliationWorkerOptions) {
    this.#service = options.service;
    this.#listTenantScopes = options.listTenantScopes;
    this.#intervalMs = options.intervalMs ?? 60_000;
    this.#batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(this.#intervalMs)
      || this.#intervalMs < 1_000
      || this.#intervalMs > 86_400_000) {
      throw new TypeError("intervalMs must be between 1000 and 86400000");
    }
    if (!Number.isSafeInteger(this.#batchSize)
      || this.#batchSize < 1
      || this.#batchSize > 500) {
      throw new TypeError("batchSize must be between 1 and 500");
    }
    this.#setTimer = options.setTimer
      ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer
      ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.#onError = options.onError ?? (() => undefined);
  }

  start() {
    if (this.#closed) {
      return Promise.reject(new Error(
        "ACQUISITION_OUTCOME_RECONCILIATION_WORKER_CLOSED"
      ));
    }
    if (this.#started) return this.whenIdle();
    this.#started = true;
    return this.#runSweep();
  }

  whenIdle() {
    return this.#active ?? Promise.resolve();
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
    if (this.#active) return this.#active;
    const sweep = (async () => {
      let scopes: TenantScope[];
      try {
        scopes = await this.#listTenantScopes();
      } catch (error) {
        this.#onError(error, null);
        return;
      }
      const uniqueScopes = new Map(scopes.map((scope) => [
        `${scope.ownerId}\u001f${scope.teamId}`,
        scope
      ]));
      for (const scope of uniqueScopes.values()) {
        try {
          await this.#service.runTenant(scope, { limit: this.#batchSize });
        } catch (error) {
          this.#onError(error, scope);
        }
      }
    })().finally(() => {
      if (this.#active === sweep) this.#active = null;
      this.#schedule();
    });
    this.#active = sweep;
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
