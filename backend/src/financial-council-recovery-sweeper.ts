import type { FinancialCouncilRepository } from
  "./financial-council-repository.js";
import type { FinancialCouncilAnalysisWorkerLike } from
  "./financial-council-analysis-worker.js";

export class FinancialCouncilRecoverySweeper {
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;
  #closed = false;

  constructor(private readonly options: {
    readonly repository: Pick<FinancialCouncilRepository,
      "listRecoverableAnalysisRuns">;
    readonly worker: FinancialCouncilAnalysisWorkerLike;
    readonly now: () => string;
    readonly intervalMs: number;
    readonly batchSize: number;
    readonly onError: (error: unknown, runId: string | null) => void;
  }) {}

  start(): void {
    if (this.#closed || this.#timer) return;
    void this.sweepOnce().catch((error) => this.options.onError(error, null));
    this.#timer = setInterval(() => {
      void this.sweepOnce().catch((error) => this.options.onError(error, null));
    }, this.options.intervalMs);
    this.#timer.unref?.();
  }

  sweepOnce(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#sweep().finally(() => { this.#inFlight = null; });
    return this.#inFlight;
  }

  async #sweep(): Promise<void> {
    const runs = await this.options.repository.listRecoverableAnalysisRuns(
      this.options.now(), this.options.batchSize
    );
    for (const run of runs) {
      try {
        await this.options.worker.wake(run);
      } catch (error) {
        this.options.onError(error, run.runId);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#inFlight;
  }

  async close(): Promise<void> {
    if (this.#closed) return this.#inFlight ?? Promise.resolve();
    this.#closed = true;
    await this.stop();
  }
}
