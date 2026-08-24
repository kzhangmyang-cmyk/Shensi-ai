import type { AcquisitionCrawlerJobRepository } from "./acquisition-crawler-job-repository.js";
import type { DouyinMediaCrawlerGateway } from "./acquisition-mediacrawler-gateway.js";
import type { AcquisitionSocialAccountPrivateRecord } from "./acquisition-social-account-repository.js";

export interface AcquisitionCrawlerWorkerOptions {
  repository: AcquisitionCrawlerJobRepository;
  gateway: Pick<DouyinMediaCrawlerGateway, "startCrawlJob" | "getCrawlJob" | "getCrawlResults" | "cancelCrawlJob">;
  accounts: { findById(workspaceId: string, accountId: string): Promise<Partial<AcquisitionSocialAccountPrivateRecord> | null> };
  workerId: string;
  now?: () => string;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  maxPageCount?: number;
}

function delay(durationMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("crawler_worker_closed")); return; }
    const timer = setTimeout(resolve, durationMs);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("crawler_worker_closed")); }, { once: true });
  });
}

export class AcquisitionCrawlerWorker {
  private readonly repository: AcquisitionCrawlerJobRepository;
  private readonly gateway: AcquisitionCrawlerWorkerOptions["gateway"];
  private readonly accounts: AcquisitionCrawlerWorkerOptions["accounts"];
  private readonly workerId: string;
  private readonly now: () => string;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxPageCount: number;
  private readonly controller = new AbortController();
  private active: Promise<boolean> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: AcquisitionCrawlerWorkerOptions) {
    this.repository = options.repository; this.gateway = options.gateway;
    this.accounts = options.accounts; this.workerId = options.workerId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.maxPageCount = options.maxPageCount ?? 1_000;
  }

  runOnce(): Promise<boolean> {
    if (this.active) return this.active;
    const running = this.execute();
    this.active = running.finally(() => { if (this.active === running) this.active = null; });
    return this.active;
  }

  start(intervalMs = 500) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, intervalMs);
    this.timer.unref();
    void this.runOnce();
  }

  private async execute() {
    const claim = await this.repository.claimNext(this.workerId, this.now(), this.leaseDurationMs);
    if (!claim) return false;
    const { job, fence } = claim;
    try {
      const account = await this.accounts.findById(job.workspaceId, job.accountId);
      if (!account || account.workspaceId !== job.workspaceId || account.id !== job.accountId
        || account.platform !== "douyin" || account.state !== "active" || !account.accountHandle
        || account.loginStateVersion !== job.accountLoginStateVersion) {
        await this.repository.pause(fence, "crawler_account_binding_changed", this.now());
        return true;
      }
      const deadlineAt = new Date(Date.parse(this.now()) + job.limits.maxDurationSeconds * 1_000).toISOString();
      await this.gateway.startCrawlJob({
        jobId: job.id, accountHandle: account.accountHandle,
        loginStateVersion: job.accountLoginStateVersion, keywords: [...job.keywords],
        maxVideos: job.limits.maxVideos,
        maxCommentsPerVideo: job.limits.maxCommentsPerVideo,
        maxPagesPerVideo: job.limits.maxPagesPerVideo,
        deadlineAt,
        collectCreators: job.collectCreators,
        collectDemandComments: job.collectDemandComments
      }, this.controller.signal);
      while (true) {
        const persisted = await this.repository.findByRun(job.workspaceId, job.runId);
        if (persisted?.cancelRequestedAt) {
          await this.gateway.cancelCrawlJob(job.id, this.controller.signal);
          await this.repository.completeCancelled(fence, this.now());
          return true;
        }
        const status = await this.gateway.getCrawlJob(job.id, this.controller.signal);
        if (["succeeded", "partial"].includes(status.state)) break;
        if (["failed", "cancelled"].includes(status.state)) {
          if (status.state === "cancelled") {
            await this.repository.requestCancel(job.workspaceId, job.runId, this.now());
            await this.repository.completeCancelled(fence, this.now());
          } else {
            await this.repository.fail(fence, "mediacrawler_job_failed", this.now(), true);
          }
          return true;
        }
        await this.repository.renew(fence, this.now(), this.leaseDurationMs);
        await delay(this.pollIntervalMs, this.controller.signal);
      }
      let cursor = job.cursor;
      for (let pageNumber = 0; pageNumber < this.maxPageCount; pageNumber += 1) {
        const page = await this.gateway.getCrawlResults(job.id, cursor, this.controller.signal);
        if (page.jobId !== job.id || page.cursor !== cursor) throw new Error("mediacrawler_cursor_mismatch");
        await this.repository.persistPage(fence, {
          expectedCursor: cursor, nextCursor: page.nextCursor,
          records: page.records, done: page.done, now: this.now()
        });
        if (page.done) return true;
        cursor = page.nextCursor;
        await this.repository.renew(fence, this.now(), this.leaseDurationMs);
      }
      await this.repository.pause(fence, "crawler_page_limit_exceeded", this.now());
      return true;
    } catch (error) {
      if (this.controller.signal.aborted) return true;
      await this.repository.fail(fence, error instanceof Error ? error.message.slice(0, 100) : "crawler_worker_failed", this.now(), true)
        .catch(() => undefined);
      return true;
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller.abort();
    await this.active?.catch(() => undefined);
  }
}
