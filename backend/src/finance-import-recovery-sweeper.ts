import type {
  FinanceImportExecutionRepository
} from "./finance-import-repository.js";
import type {
  FinanceImportWorkerLike
} from "./finance-import-worker.js";
import type { FinanceImportRecoveryAuthorizer } from "./finance-import-worker.js";

export interface FinanceImportRecoverySweeper {
  start(): void;
  sweepOnce(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export class DefaultFinanceImportRecoverySweeper
implements FinanceImportRecoverySweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: {
    repository: FinanceImportExecutionRepository;
    worker: FinanceImportWorkerLike;
    authorizer: FinanceImportRecoveryAuthorizer;
    workerId: string;
    intervalMs: number;
    batchSize: number;
    now(): string;
    onError(error: unknown, operationId: string | null): void;
  }) {}

  start(): void {
    if (this.closed) {
      throw new Error("finance_import_recovery_closed");
    }
    if (this.timer !== null) return;
    void this.sweepOnce().catch((error) =>
      this.options.onError(error, null));
    this.timer = setInterval(() => {
      void this.sweepOnce().catch((error) =>
        this.options.onError(error, null));
    }, this.options.intervalMs);
  }

  async sweepOnce(): Promise<void> {
    if (this.closed) return;
    if (this.inFlight !== null) return this.inFlight;
    const run = async () => {
      const operations = await this.options.repository.listRecoverable(
        this.options.now(), this.options.batchSize
      );
      for (const operation of operations) {
        try {
          await this.options.worker.run({
            operationId: operation.id,
            workerId: this.options.workerId,
            authorize: (current) =>
              this.options.authorizer.commandFor(current)
          });
        } catch (error) {
          this.options.onError(error, operation.id);
        }
      }
    };
    this.inFlight = run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  close(): Promise<void> {
    if (this.closePromise === null) {
      this.closed = true;
      this.closePromise = this.stop();
    }
    return this.closePromise;
  }
}
