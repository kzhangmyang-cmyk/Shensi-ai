import type { AcquisitionCrawlerJobRepository } from "./acquisition-crawler-job-repository.js";
import type { AcquisitionCrawlerJob } from "./acquisition-crawler-job.js";
import type { DouyinMediaCrawlerGateway } from "./acquisition-mediacrawler-gateway.js";
import type { AcquisitionSocialAccountPrivateRecord } from "./acquisition-social-account-repository.js";

export interface AcquisitionCrawlerWorkerOptions {
  repository: AcquisitionCrawlerJobRepository;
  gateway: Pick<DouyinMediaCrawlerGateway, "startCrawlJob" | "getCrawlJob" | "getCrawlResults" | "cancelCrawlJob">
    & Partial<Pick<DouyinMediaCrawlerGateway, "acknowledgeCrawlJob">>;
  accounts: { findById(workspaceId: string, accountId: string): Promise<Partial<AcquisitionSocialAccountPrivateRecord> | null> };
  workerId: string;
  now?: () => string;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  maxPageCount?: number;
  ingestAvailableJob?: (job: AcquisitionCrawlerJob) => Promise<void>;
  ingestTerminalJob?: (job: AcquisitionCrawlerJob) => Promise<void>;
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
  private readonly ingestAvailableJob: AcquisitionCrawlerWorkerOptions["ingestAvailableJob"];
  private readonly ingestTerminalJob: AcquisitionCrawlerWorkerOptions["ingestTerminalJob"];
  private readonly controller = new AbortController();
  private active: Promise<boolean> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nextLane: "crawl" | "ingestion" = "crawl";
  private lastWorkspaceId: string | undefined;

  constructor(options: AcquisitionCrawlerWorkerOptions) {
    this.repository = options.repository; this.gateway = options.gateway;
    this.accounts = options.accounts; this.workerId = options.workerId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.maxPageCount = options.maxPageCount ?? 1_000;
    this.ingestAvailableJob = options.ingestAvailableJob;
    this.ingestTerminalJob = options.ingestTerminalJob;
    if (this.ingestTerminalJob && !this.gateway.acknowledgeCrawlJob) {
      throw new TypeError("crawler_acknowledgement_gateway_required");
    }
  }

  runOnce(): Promise<boolean> {
    if (this.active) return this.active;
    const running = this.execute();
    const tracked = running.finally(() => {
      if (this.active === tracked) this.active = null;
    });
    this.active = tracked;
    return tracked;
  }

  start(intervalMs = 500) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, intervalMs);
    this.timer.unref();
    void this.runOnce();
  }

  private async execute() {
    if (this.nextLane === "ingestion" && await this.executeIngestion()) {
      return true;
    }
    const claim = await this.repository.claimNext(
      this.workerId,
      this.now(),
      this.leaseDurationMs,
      this.lastWorkspaceId
    );
    if (!claim) return this.executeIngestion();
    const { job, fence } = claim;
    this.lastWorkspaceId = job.workspaceId;
    this.nextLane = "ingestion";
    try {
      const account = await this.accounts.findById(job.workspaceId, job.accountId);
      if (!account || account.workspaceId !== job.workspaceId || account.id !== job.accountId
        || account.platform !== "douyin" || account.state !== "active" || !account.accountHandle
        || account.loginStateVersion !== job.accountLoginStateVersion) {
        await this.repository.pause(fence, "crawler_account_binding_changed", this.now());
        return true;
      }
      const deadlineAt = new Date(Date.parse(this.now()) + job.limits.maxDurationSeconds * 1_000).toISOString();
      const started = await this.gateway.startCrawlJob({
        jobId: job.id, accountHandle: account.accountHandle,
        loginStateVersion: job.accountLoginStateVersion, keywords: [...job.keywords],
        maxVideos: job.limits.maxVideos,
        maxCommentsPerVideo: job.limits.maxCommentsPerVideo,
        maxPagesPerVideo: job.limits.maxPagesPerVideo,
        deadlineAt,
        collectCreators: job.collectCreators,
        collectDemandComments: job.collectDemandComments
      }, this.controller.signal);
      if (started.jobId !== job.id) throw new Error("mediacrawler_job_mismatch");
      await this.repository.updateActivity(fence, {
        activity: started.activity, now: this.now()
      });
      while (true) {
        const persisted = await this.repository.findByRun(job.workspaceId, job.runId);
        if (persisted?.cancelRequestedAt) {
          await this.gateway.cancelCrawlJob(job.id, this.controller.signal);
          await this.repository.completeCancelled(fence, this.now());
          return true;
        }
        const status = await this.gateway.getCrawlJob(job.id, this.controller.signal);
        if (status.jobId !== job.id) throw new Error("mediacrawler_job_mismatch");
        await this.repository.updateActivity(fence, {
          activity: status.activity, now: this.now()
        });
        if (["failed", "cancelled"].includes(status.state)) {
          if (status.state === "cancelled") {
            await this.repository.requestCancel(job.workspaceId, job.runId, this.now());
            await this.repository.completeCancelled(fence, this.now());
          } else {
            await this.repository.fail(fence, "mediacrawler_job_failed", this.now(), true);
          }
          return true;
        }
        if (status.pageCount > this.maxPageCount) {
          await this.repository.pause(
            fence, "crawler_page_limit_exceeded", this.now()
          );
          return true;
        }
        const current = await this.repository.findByRun(job.workspaceId, job.runId);
        if (!current || current.id !== job.id || current.state !== "running") {
          throw new Error("crawler_job_binding_changed");
        }
        const persistedPageCount = current.cursorHistory.length;
        const availablePageCount = status.pageCount - persistedPageCount;
        if (availablePageCount < 0) {
          throw new Error("mediacrawler_page_count_regressed");
        }
        const terminal = status.state === "succeeded" || status.state === "partial";
        let cursor = current.cursor;
        let terminalPagePersisted = false;
        for (let pageOffset = 0; pageOffset < availablePageCount; pageOffset += 1) {
          const page = await this.gateway.getCrawlResults(
            job.id, cursor, this.controller.signal
          );
          if (page.jobId !== job.id || page.cursor !== cursor) {
            throw new Error("mediacrawler_cursor_mismatch");
          }
          const lastAdvertisedPage = pageOffset === availablePageCount - 1;
          if (page.done !== (terminal && lastAdvertisedPage)) {
            throw new Error("mediacrawler_page_count_mismatch");
          }
          const stored = await this.repository.persistPage(fence, {
            expectedCursor: cursor,
            nextCursor: page.nextCursor,
            records: page.records,
            done: page.done,
            ...(page.done ? {
              terminalState: status.state as "succeeded" | "partial",
              terminalErrorCode: status.failureCode
            } : {}),
            now: this.now()
          });
          if (page.done) {
            terminalPagePersisted = true;
            break;
          }
          cursor = page.nextCursor;
          await this.repository.renew(
            fence, this.now(), this.leaseDurationMs
          );
          await this.ingestAvailableJob?.(stored).catch(() => undefined);
        }
        if (terminal) {
          if (!terminalPagePersisted) {
            throw new Error("mediacrawler_terminal_page_missing");
          }
          return true;
        }
        await this.repository.renew(fence, this.now(), this.leaseDurationMs);
        await delay(this.pollIntervalMs, this.controller.signal);
      }
    } catch (error) {
      if (this.controller.signal.aborted) return true;
      await this.repository.fail(fence, error instanceof Error ? error.message.slice(0, 100) : "crawler_worker_failed", this.now(), true)
        .catch(() => undefined);
      return true;
    }
  }

  private async executeIngestion() {
    if (!this.ingestTerminalJob || !this.gateway.acknowledgeCrawlJob) return false;
    const claim = await this.repository.claimNextIngestion(
      this.workerId,
      this.now(),
      this.leaseDurationMs,
      this.lastWorkspaceId
    );
    if (!claim) return false;
    this.lastWorkspaceId = claim.job.workspaceId;
    this.nextLane = "crawl";
    const ingestedAt = this.now();
    try {
      await this.ingestTerminalJob(claim.job);
      const acknowledgement = await this.gateway.acknowledgeCrawlJob(
        claim.job.id,
        this.controller.signal
      );
      await this.repository.completeIngestion(
        claim.fence,
        ingestedAt,
        acknowledgement.acknowledgedAt,
        this.now()
      );
    } catch (error) {
      if (!this.controller.signal.aborted) {
        await this.repository.failIngestion(
          claim.fence,
          error instanceof Error
            ? error.message.slice(0, 100) : "crawler_ingestion_failed",
          this.now()
        ).catch(() => undefined);
      }
    }
    return true;
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller.abort();
    await this.active?.catch(() => undefined);
  }
}
