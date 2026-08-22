import type { CommandContext } from "./growth-command-context.js";
import type { RoiClosureOperation } from "./acquisition-roi-closure.js";

export interface RoiClosureRecoveryAuthorizer {
  authorize(operation: RoiClosureOperation): Promise<CommandContext>;
}

export interface RoiClosureRecoverySweeper {
  start(): void;
  sweepOnce(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export class DefaultRoiClosureRecoverySweeper
implements RoiClosureRecoverySweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: {
    listExpired(now: string, limit: number): Promise<RoiClosureOperation[]>;
    recover(operation: RoiClosureOperation): Promise<void>;
    intervalMs: number;
    now(): string;
    onError(error: unknown, operationId: string | null): void;
  }) {}

  start(): void {
    if (this.closed) throw new Error("roi_closure_recovery_closed");
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
