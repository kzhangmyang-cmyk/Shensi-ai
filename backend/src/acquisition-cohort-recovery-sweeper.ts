import type {
  AcquisitionCohortCatchUpOperation,
  AcquisitionCohortRepository
} from "./acquisition-cohort-repository.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export interface AcquisitionCohortRecoveryAuthorizer {
  authorize(
    operation: AcquisitionCohortCatchUpOperation
  ): Promise<
    | {
        authorityKind: "roi_close";
        parentClosureOperationId: string;
        context: CommandContext;
      }
    | {
        authorityKind: "performance_read";
        workspace: ActiveWorkspaceContext;
      }
  >;
}

export interface AcquisitionCohortRecoverySweeper {
  start(): void;
  sweepOnce(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export class DefaultAcquisitionCohortRecoverySweeper
implements AcquisitionCohortRecoverySweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: {
    repository: AcquisitionCohortRepository;
    recover(operation: AcquisitionCohortCatchUpOperation): Promise<void>;
    listExpired(now: string, limit: number): Promise<AcquisitionCohortCatchUpOperation[]>;
    workerId: string;
    intervalMs: number;
    now(): string;
    onError(error: unknown, operationId: string | null): void;
  }) {}

  start(): void {
    if (this.closed) throw new Error("cohort_recovery_closed");
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
      const operations = await this.options.listExpired(
        this.options.now(), 10
      );
      for (const operation of operations) {
        try {
          await this.options.recover(operation);
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
