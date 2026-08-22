import type { QuoteRepository } from "./quote-repository.js";
import type { QuotePublicationWorker } from "./quote-publication-worker.js";

export class QuotePublicationRecoverySweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private closed = false;
  private scanPromise: Promise<void> | null = null;
  private readonly activeJobs = new Set<Promise<unknown>>();
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: {
    repository: Pick<QuoteRepository, "listRecoverablePublications">;
    worker: Pick<QuotePublicationWorker, "runOne">;
    intervalMs?: number;
    onError?: (error: unknown) => void;
  }) {
    const intervalMs = options.intervalMs ?? 5_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) {
      throw new Error("invalid_quote_publication_sweeper_interval");
    }
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.scan();
    this.timer = setInterval(() => { void this.scan(); },
      this.options.intervalMs ?? 5_000);
    this.timer.unref?.();
  }

  private async scan() {
    if (this.closed || this.scanPromise) return this.scanPromise;
    this.scanPromise = (async () => {
      const operations = await this.options.repository
        .listRecoverablePublications(new Date().toISOString());
      for (const operation of operations) {
        if (this.closed) break;
        const job = this.options.worker.runOne(operation.id);
        this.activeJobs.add(job);
        void job.catch((error) => this.options.onError?.(error)).finally(() => {
          this.activeJobs.delete(job);
        });
      }
    })().catch((error) => this.options.onError?.(error)).finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closed = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      await this.scanPromise;
      await Promise.allSettled([...this.activeJobs]);
    })();
    return this.closePromise;
  }
}
