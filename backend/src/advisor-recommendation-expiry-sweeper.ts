import type {
  AdvisorRecommendationRepository
} from "./advisor-recommendation-repository.js";

export interface AdvisorRecommendationExpirySweeper {
  start(): void;
  sweep(): Promise<void>;
  close(): Promise<void>;
}

export class DefaultAdvisorRecommendationExpirySweeper
implements AdvisorRecommendationExpirySweeper {
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: {
    repository: AdvisorRecommendationRepository;
    command(context: {
      workspaceId: string;
      actorId: string;
      idempotencyKey: string;
      requestHash: string;
    }): import("./growth-command-context.js").CommandContext;
    now(): number;
    onError(error: unknown, recommendationId: string | null): void;
  }) {}

  start(): void {
    if (this.timer !== null || this.closed) return;
    this.timer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, 5_000);
    this.timer.unref?.();
  }

  async sweep(): Promise<void> {
    if (this.closed) return;
    if (this.inFlight !== null) return this.inFlight;
    const run = async () => {
      const due = await this.options.repository.listExpirable(
        new Date(this.options.now()).toISOString(),
        100
      );
      for (const aggregate of due) {
        try {
          const context = this.options.command({
            workspaceId: aggregate.workspaceId,
            actorId: "advisor-expiry-sweeper",
            idempotencyKey: `advisor-expire:${aggregate.id}:${aggregate.revision}`,
            requestHash: `sha256:${aggregate.id}`
          });
          await this.options.repository.transition(context, {
            recommendationId: aggregate.id,
            kind: "expire",
            reason: "expired by sweeper"
          });
        } catch (error) {
          this.options.onError(error, aggregate.id);
        }
      }
    };
    this.inFlight = run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.closePromise === null) {
      this.closePromise = this.inFlight ?? Promise.resolve();
    }
    return this.closePromise;
  }
}
