import type {
  DouyinAutomationApi,
  DouyinDesktopSyncApi,
  DouyinAccount,
  DesktopCrawlerJobResource,
  DesktopRunPreparation,
  DouyinLoginSession,
  DouyinRunIntent
} from "./douyin-automation-api";
import type {
  DouyinCollectionPage,
  DouyinCollectionStatus,
  DouyinLoginStatus,
  ShensiDesktopApi
} from "../desktop/desktop-bridge";

export type AcquisitionBrowserRuntimeKind = "remote" | "desktop";

export interface AcquisitionBrowserRuntime {
  readonly kind: AcquisitionBrowserRuntimeKind;
  readonly interactionSurface: "remote_canvas" | "external_window";
  readonly supportsRemoteCanvas: boolean;
  startLogin(idempotencyKey: string, signal?: AbortSignal): Promise<DouyinLoginSession>;
  getStatus(sessionId: string, signal?: AbortSignal): Promise<DouyinLoginSession>;
  confirmLogin(sessionId: string, signal?: AbortSignal): Promise<DouyinLoginSession>;
  cancelLogin(sessionId: string, signal?: AbortSignal): Promise<void>;
  startCollection(planId: string, idempotencyKey: string,
    signal?: AbortSignal): Promise<DouyinRunIntent>;
}

abstract class ApiBackedBrowserRuntime implements AcquisitionBrowserRuntime {
  abstract readonly kind: AcquisitionBrowserRuntimeKind;
  abstract readonly interactionSurface: "remote_canvas" | "external_window";
  abstract readonly supportsRemoteCanvas: boolean;

  constructor(protected readonly api: DouyinAutomationApi) {}

  startLogin(idempotencyKey: string, signal?: AbortSignal) {
    return this.api.createLoginSession(idempotencyKey, signal);
  }

  getStatus(sessionId: string, signal?: AbortSignal) {
    return this.api.getLoginSession(sessionId, signal);
  }

  confirmLogin(sessionId: string, signal?: AbortSignal) {
    return this.api.getLoginSession(sessionId, signal);
  }

  cancelLogin(sessionId: string, signal?: AbortSignal) {
    return this.api.cancelLoginSession(sessionId, signal);
  }

  startCollection(planId: string, idempotencyKey: string,
    signal?: AbortSignal) {
    return this.api.runNow(planId, idempotencyKey, signal);
  }
}

export class RemoteBrowserRuntime extends ApiBackedBrowserRuntime {
  readonly kind = "remote" as const;
  readonly interactionSurface = "remote_canvas" as const;
  readonly supportsRemoteCanvas = true;
}

function abortError(): DOMException {
  return new DOMException("Desktop operation generation changed", "AbortError");
}

export function isDesktopLoginSessionUnavailable(error: unknown): boolean {
  return error instanceof Error && (error.message === "desktop_login_session_unavailable"
    || /^Error invoking remote method 'shensi:desktop:(?:get-douyin-login-status|confirm-douyin-login)': Error: desktop_login_session_unavailable$/u.test(error.message));
}

const publicLoginFailureCodes = new Set([
  "douyin_login_ui_unsupported", "douyin_verification_required",
  "douyin_login_page_unavailable", "douyin_login_page_not_allowed",
  "douyin_browser_unavailable", "douyin_browser_command_timeout",
  "douyin_login_open_failed"
]);

function desktopLoginSession(status: DouyinLoginStatus,
  account: DouyinAccount | null = null): DouyinLoginSession {
  return {
    id: status.sessionId,
    platform: "douyin",
    state: status.state === "expired" || status.state === "failed"
      ? "login_expired" : status.state,
    interactionSurface: "external_window",
    runtimeState: status.runtimeState,
    authState: status.authState,
    taskState: status.taskState,
    diagnostic: status.diagnostic ? {
      code: status.diagnostic.code,
      message: status.diagnostic.message,
      recoverable: status.diagnostic.recoverable,
      occurredAt: status.diagnostic.occurredAt
    } : null,
    screenshotAvailable: false,
    qrAvailable: false,
    qrImageDataUrl: null,
    qrStatus: null,
    loginPage: null,
    failureCode: status.failureCode && publicLoginFailureCodes.has(status.failureCode)
      ? status.failureCode as DouyinLoginSession["failureCode"]
      : status.failureCode ? "douyin_login_open_failed" : null,
    expiresAt: status.expiresAt,
    account
  };
}

type DesktopCapableApi = DouyinAutomationApi & Partial<DouyinDesktopSyncApi>;

interface DesktopLoginOwnership {
  sessionId: string | null;
  opening: Promise<DouyinLoginStatus> | null;
  revoked: boolean;
  cancellation: Promise<void> | null;
}

interface ActiveDesktopCollection {
  identity: string;
  generation: number;
  controller: AbortController;
  externalSignal?: AbortSignal;
  externalAbort?: () => void;
  prepared: DesktopRunPreparation | null;
  localStatus: DouyinCollectionStatus | null;
  leaseVersion: number;
  cloudCursor: string | null;
  terminalUploaded: boolean;
  localTaskIds: Set<string>;
  cancelled: boolean;
  phase: "starting" | "syncing" | "cloud_durable" | "acknowledged" | "failed";
  startFlight: Promise<DouyinRunIntent>;
  syncFlight: Promise<void> | null;
  cancellationFlight: Promise<void> | null;
}

function isTerminalCollection(status: DouyinCollectionStatus): boolean {
  return ["succeeded", "partial", "paused", "cancelled", "failed"]
    .includes(status.state);
}

function assertCollectionIdentity(value: { jobId: string; runId: string },
  prepared: DesktopRunPreparation): void {
  if (value.jobId !== prepared.task.taskId
    || value.runId !== prepared.run.acquisitionRunId) {
    throw new Error("desktop_collection_cloud_binding_mismatch");
  }
}

async function retryBounded<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await operation(); } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      await Promise.resolve();
    }
  }
  throw lastError;
}

async function pageIdempotencyKey(taskId: string, cursor: string | null): Promise<string> {
  const bytes = new TextEncoder().encode(`${taskId}\u0000${cursor ?? ""}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  return `desktop-page-${hex}`;
}

export class LocalDesktopBrowserRuntime implements AcquisitionBrowserRuntime {
  readonly kind = "desktop" as const;
  readonly interactionSurface = "external_window" as const;
  readonly supportsRemoteCanvas = false;

  private generation = 0;
  private activeSessionId: string | null = null;
  private startFlight: Promise<DouyinLoginSession> | null = null;
  private loginIdempotencyKey: string | null = null;
  private loginOwnership: DesktopLoginOwnership | null = null;
  private pendingLoginCancellations = new Set<DesktopLoginOwnership>();
  private completionFlight: {
    identity: string;
    promise: Promise<DouyinAccount>;
  } | null = null;
  private collectionGeneration = 0;
  private activeCollection: ActiveDesktopCollection | null = null;

  constructor(
    private readonly api: DesktopCapableApi,
    private readonly bridge: ShensiDesktopApi | null,
    private readonly accountId: () => string | null,
    private readonly onLocalAccount?: (account: DouyinAccount, local: DouyinLoginStatus) => Promise<void>
  ) {}

  startLogin(idempotencyKey: string, signal?: AbortSignal): Promise<DouyinLoginSession> {
    if (!this.bridge) return Promise.reject(new Error("desktop_bridge_unavailable"));
    if (this.startFlight) return this.startFlight;
    const accountId = this.accountId();
    if (!accountId) return Promise.reject(new Error("请先登录 Shensi 工作区。"));
    const own = ++this.generation;
    const flight = (async () => {
      for (const ownership of [...this.pendingLoginCancellations]) {
        await this.cancelLoginOwnership(ownership);
      }
      if (signal?.aborted || own !== this.generation) throw abortError();
      if (this.activeSessionId) {
        try {
          const existing = await this.getStatus(this.activeSessionId, signal);
          if (existing.state !== "login_expired") return existing;
        } catch (error) {
          if (!isDesktopLoginSessionUnavailable(error)) throw error;
        }
      }
      if (signal?.aborted || own !== this.generation) throw abortError();
      this.loginIdempotencyKey = idempotencyKey;
      const ownership: DesktopLoginOwnership = { sessionId: null, opening: null, revoked: false, cancellation: null };
      this.loginOwnership = ownership;
      ownership.opening = this.bridge!.startDouyinLogin(accountId).then((status) => {
        ownership.sessionId = status.sessionId;
        return status;
      });
      const status = await ownership.opening;
      if (signal?.aborted || own !== this.generation) {
        await this.cancelLoginOwnership(ownership).catch(() => undefined);
        throw abortError();
      }
      this.activeSessionId = status.sessionId;
      return this.publishActiveLogin(status, own, signal);
    })();
    this.startFlight = flight;
    void flight.then(
      () => { if (this.startFlight === flight) this.startFlight = null; },
      () => { if (this.startFlight === flight) this.startFlight = null; }
    );
    return flight;
  }

  private async publishActiveLogin(status: DouyinLoginStatus, own: number,
    signal?: AbortSignal): Promise<DouyinLoginSession> {
    if (status.state === "expired" || status.state === "failed") {
      this.forgetLoginSession(status.sessionId);
    }
    if (status.state !== "active") return desktopLoginSession(status);
    const workspaceId = this.accountId();
    if (!workspaceId || !status.accountHandle || !status.accountDisplayName
      || !status.loginStateVersion || !this.api.completeDesktopLogin) {
      throw new Error("desktop_login_identity_incomplete");
    }
    const identity = `${status.sessionId}\u0000${status.accountHandle}\u0000${status.loginStateVersion}`;
    let flight = this.completionFlight?.identity === identity
      ? this.completionFlight.promise : null;
    if (!flight) {
      const key = this.loginIdempotencyKey ?? `desktop-login-${status.sessionId}`;
      flight = this.api.completeDesktopLogin({
        accountHandle: status.accountHandle,
        displayName: status.accountDisplayName,
        loginStateVersion: status.loginStateVersion
      }, key, signal);
      const tracked = { identity, promise: flight };
      this.completionFlight = tracked;
      void flight.finally(() => {
        if (this.completionFlight === tracked) this.completionFlight = null;
      }).catch(() => undefined);
    }
    const account = await flight;
    if (signal?.aborted || own !== this.generation
      || this.activeSessionId !== status.sessionId) throw abortError();
    if (account.workspaceId !== workspaceId || account.state !== "active"
      || account.loginStateVersion !== status.loginStateVersion) {
      throw new Error("desktop_login_cloud_binding_mismatch");
    }
    await this.onLocalAccount?.(account, status);
    if (signal?.aborted || own !== this.generation || this.accountId() !== workspaceId) throw abortError();
    return desktopLoginSession(status, account);
  }

  private forgetLoginSession(sessionId: string): void {
    if (this.activeSessionId !== sessionId) return;
    if (this.loginOwnership?.sessionId === sessionId) {
      this.loginOwnership.sessionId = null;
      this.loginOwnership.opening = null;
      this.loginOwnership = null;
    }
    this.activeSessionId = null;
    this.loginIdempotencyKey = null;
    this.completionFlight = null;
  }

  async getStatus(sessionId: string, signal?: AbortSignal): Promise<DouyinLoginSession> {
    if (!this.bridge) throw new Error("desktop_bridge_unavailable");
    const own = this.generation;
    const status = await this.bridge.getDouyinLoginStatus(sessionId).catch((error: unknown) => {
      if (own === this.generation && isDesktopLoginSessionUnavailable(error)) this.forgetLoginSession(sessionId);
      throw error;
    });
    if (signal?.aborted || own !== this.generation || this.activeSessionId !== sessionId) {
      throw abortError();
    }
    if (status.sessionId !== sessionId) {
      await this.bridge.cancelDouyinLogin(status.sessionId).catch(() => undefined);
      throw new Error("desktop_login_session_mismatch");
    }
    return this.publishActiveLogin(status, own, signal);
  }

  async confirmLogin(sessionId: string, signal?: AbortSignal): Promise<DouyinLoginSession> {
    if (!this.bridge) throw new Error("desktop_bridge_unavailable");
    const own = this.generation;
    const status = await this.bridge.confirmDouyinLogin(sessionId).catch((error: unknown) => {
      if (own === this.generation && isDesktopLoginSessionUnavailable(error)) this.forgetLoginSession(sessionId);
      throw error;
    });
    if (signal?.aborted || own !== this.generation || this.activeSessionId !== sessionId) {
      throw abortError();
    }
    if (status.sessionId !== sessionId) {
      await this.bridge.cancelDouyinLogin(status.sessionId).catch(() => undefined);
      throw new Error("desktop_login_session_mismatch");
    }
    return this.publishActiveLogin(status, own, signal);
  }

  cancelLogin(sessionId: string): Promise<void> {
    const ownership = this.loginOwnership?.sessionId === sessionId ? this.loginOwnership
      : [...this.pendingLoginCancellations].find((pending) => pending.sessionId === sessionId)
        ?? { sessionId, opening: null, revoked: false, cancellation: null };
    return this.cancelLoginOwnership(ownership);
  }

  captureLoginCancellation(): () => Promise<void> {
    const ownership = this.loginOwnership;
    return () => this.cancelLoginOwnership(ownership);
  }

  cancelCurrentLogin(): Promise<void> {
    return this.cancelLoginOwnership(this.loginOwnership);
  }

  private cancelLoginOwnership(ownership: DesktopLoginOwnership | null): Promise<void> {
    if (!ownership) return Promise.resolve();
    if (!ownership.revoked) {
      ownership.revoked = true;
      this.pendingLoginCancellations.add(ownership);
      if (this.loginOwnership === ownership) {
        this.generation += 1;
        this.activeSessionId = null;
        this.loginIdempotencyKey = null;
        this.completionFlight = null;
        this.startFlight = null;
      }
    }
    if (ownership.cancellation) return ownership.cancellation;
    const flight = (async () => {
      // A captured start may not have returned its opaque session handle yet.
      await ownership.opening?.catch(() => undefined);
      if (ownership.sessionId) {
        if (!this.bridge) throw new Error("desktop_bridge_unavailable");
        await this.bridge.cancelDouyinLogin(ownership.sessionId);
      }
      ownership.sessionId = null;
      ownership.opening = null;
      this.pendingLoginCancellations.delete(ownership);
      if (this.loginOwnership === ownership) this.loginOwnership = null;
    })();
    ownership.cancellation = flight;
    const settled = () => { if (ownership.cancellation === flight) ownership.cancellation = null; };
    void flight.then(settled, settled);
    return flight;
  }

  startCollection(planId: string, idempotencyKey: string,
    signal?: AbortSignal): Promise<DouyinRunIntent> {
    if (!this.bridge) return Promise.reject(new Error("desktop_bridge_unavailable"));
    const api = this.api;
    if (!api.prepareDesktopRun || !api.claimDesktopJob || !api.renewDesktopJob
      || !api.uploadDesktopPage || !api.completeDesktopJob
      || !api.cancelDesktopJob) {
      return Promise.reject(new Error("desktop_collection_coordinator_unavailable"));
    }
    const accountId = this.accountId();
    if (!accountId) return Promise.reject(new Error("请先登录 Shensi 工作区。"));
    const identity = `${planId}\u0000${idempotencyKey}`;
    const existing = this.activeCollection;
    if (existing?.identity === identity && !existing.cancelled) {
      if (existing.phase === "failed" && existing.prepared && !existing.syncFlight) {
        this.resumeCollection(existing);
      }
      return existing.startFlight;
    }
    const priorCancellation = existing
      ? this.cancelCollection(existing) : Promise.resolve();
    const generation = ++this.collectionGeneration;
    const controller = new AbortController();
    const active: ActiveDesktopCollection = {
      identity, generation, controller, externalSignal: signal,
      prepared: null, localStatus: null, leaseVersion: 0, cloudCursor: null,
      terminalUploaded: false,
      localTaskIds: new Set<string>(), cancelled: false,
      phase: "starting" as const, syncFlight: null, cancellationFlight: null,
      startFlight: Promise.resolve(null as never)
    };
    if (signal) {
      active.externalAbort = () => { void this.cancelCollection(active); };
      if (signal.aborted) active.cancelled = true;
      else signal.addEventListener("abort", active.externalAbort, { once: true });
    }
    const flight = (async () => {
      await priorCancellation;
      this.assertCurrentCollection(active);
      const prepared = await api.prepareDesktopRun!(planId, idempotencyKey,
        controller.signal);
      active.prepared = prepared;
      if (prepared.run.planId !== planId
        || prepared.run.workspaceId !== accountId
        || prepared.task.loginStateVersion !== prepared.run.accountLoginStateVersion) {
        active.phase = "failed";
        await this.cleanupPreparedCollection(active);
        throw new Error("desktop_collection_cloud_binding_mismatch");
      }
      if (!this.currentCollection(active)) {
        await this.cleanupPreparedCollection(active);
        throw abortError();
      }
      const local = await this.bridge!.startDouyinCollection(accountId, prepared.task);
      active.localTaskIds.add(prepared.task.taskId);
      active.localTaskIds.add(local.taskId);
      if (local.taskId !== prepared.task.taskId) {
        active.phase = "failed";
        await this.cleanupPreparedCollection(active);
        throw new Error("desktop_collection_task_mismatch");
      }
      if (!this.currentCollection(active)) {
        await this.cleanupPreparedCollection(active);
        throw abortError();
      }
      const claimed = await api.claimDesktopJob!(prepared.task.taskId,
        prepared.taskToken, controller.signal);
      await this.assertCloudCollectionIdentity(active, claimed);
      active.leaseVersion = claimed.leaseVersion;
      active.cloudCursor = claimed.cursor;
      this.assertCurrentCollection(active);
      this.resumeCollection(active);
      return prepared.run;
    })();
    active.startFlight = flight;
    this.activeCollection = active;
    void flight.catch(async () => {
      if (active.prepared && active.phase === "starting" && !active.cancelled) {
        await this.cleanupPreparedCollection(active);
      }
      if (this.activeCollection === active) this.activeCollection = null;
    });
    return flight;
  }

  getCollectionStatusForRun(runId: string): DouyinCollectionStatus | null {
    const active = this.activeCollection;
    if (!active || !this.currentCollection(active)
      || active.phase === "failed"
      || active.prepared?.run.acquisitionRunId !== runId
      || active.prepared.run.workspaceId !== this.accountId()
      || !active.localStatus) return null;
    return { ...active.localStatus, activity: { ...active.localStatus.activity } };
  }

  async controlCollectionForRun(runId: string, action: "pause" | "resume" | "stop"): Promise<void> {
    const active = this.activeCollection;
    if (!active || !this.currentCollection(active)
      || active.prepared?.run.acquisitionRunId !== runId
      || active.prepared.run.workspaceId !== this.accountId()
      || !this.bridge?.controlDouyinCollection) throw new Error("当前任务不支持本机采集控制");
    const status = await this.bridge.controlDouyinCollection(active.prepared.task.taskId, action);
    this.assertCurrentCollection(active);
    if (status.taskId !== active.prepared.task.taskId) throw new Error("desktop_collection_task_mismatch");
    active.localStatus = status;
  }

  private currentCollection(active: ActiveDesktopCollection): boolean {
    return this.activeCollection === active
      && this.collectionGeneration === active.generation
      && !active.cancelled && !active.controller.signal.aborted
      && !active.externalSignal?.aborted;
  }

  private assertCurrentCollection(active: ActiveDesktopCollection): void {
    if (!this.currentCollection(active)) throw abortError();
  }

  private async assertCloudCollectionIdentity(
    active: ActiveDesktopCollection,
    value: { jobId: string; runId: string }
  ): Promise<void> {
    try {
      assertCollectionIdentity(value, active.prepared!);
    } catch (error) {
      await this.cancelCollection(active);
      throw error;
    }
  }

  private async cleanupPreparedCollection(active: ActiveDesktopCollection,
    cancelCloud = true): Promise<void> {
    const prepared = active.prepared;
    const localIds = [...active.localTaskIds];
    if (prepared) localIds.push(prepared.task.taskId);
    const local = [...new Set(localIds)].map((taskId) =>
      this.bridge?.cancelDouyinCollection(taskId).catch(() => undefined));
    const cloud = cancelCloud && prepared && this.api.cancelDesktopJob
      ? this.api.cancelDesktopJob(prepared.task.taskId, prepared.taskToken,
        active.leaseVersion).catch(() => undefined)
      : Promise.resolve();
    await Promise.all([...local, cloud]);
  }

  private cancelCollection(active: ActiveDesktopCollection): Promise<void> {
    if (active.cancellationFlight) return active.cancellationFlight;
    active.cancelled = true;
    active.controller.abort();
    if (this.activeCollection === active) {
      this.collectionGeneration += 1;
    }
    const flight = this.cleanupPreparedCollection(active).then(() => undefined);
    active.cancellationFlight = flight;
    void flight.finally(() => {
      if (active.externalSignal && active.externalAbort) {
        active.externalSignal.removeEventListener("abort", active.externalAbort);
      }
      if (this.activeCollection === active) this.activeCollection = null;
    }).catch(() => undefined);
    return flight;
  }

  private resumeCollection(active: ActiveDesktopCollection): void {
    if (active.syncFlight || !active.prepared || active.cancelled) return;
    active.phase = "syncing";
    const flight = this.synchronizeCollection(active);
    active.syncFlight = flight;
    void flight.then(() => {
      active.phase = "acknowledged";
      active.syncFlight = null;
      if (active.externalSignal && active.externalAbort) {
        active.externalSignal.removeEventListener("abort", active.externalAbort);
      }
    }, (error) => {
      active.syncFlight = null;
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        active.phase = "failed";
      }
    });
  }

  private async synchronizeCollection(active: ActiveDesktopCollection): Promise<void> {
    const prepared = active.prepared!;
    const api = this.api as DouyinAutomationApi & DouyinDesktopSyncApi;
    let status: DouyinCollectionStatus;
    while (true) {
      this.assertCurrentCollection(active);
      status = await this.bridge!.getDouyinCollectionStatus(prepared.task.taskId);
      this.assertCurrentCollection(active);
      if (status.taskId !== prepared.task.taskId) {
        active.localTaskIds.add(status.taskId);
        await this.cancelCollection(active);
        throw new Error("desktop_collection_task_mismatch");
      }
      active.localStatus = status;
      if (isTerminalCollection(status)) break;
      const renewed = await api.renewDesktopJob(prepared.task.taskId,
        prepared.taskToken, active.leaseVersion, active.controller.signal);
      await this.assertCloudCollectionIdentity(active, renewed);
      active.leaseVersion = renewed.leaseVersion;
      active.cloudCursor = renewed.cursor;
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
    if (status.state !== "succeeded" && status.state !== "partial") {
      await this.cancelCollection(active);
      throw new Error(`desktop_collection_${status.state}`);
    }
    if (status.activity.phase !== "completed"
      || status.activity.currentKeyword !== null
      || status.activity.browserMode !== "visible"
      || (status.state === "succeeded" && status.failureCode !== null)
      || (status.state === "partial"
        && status.failureCode !== "crawl_interrupted_after_partial_results")) {
      await this.cancelCollection(active);
      throw new Error("desktop_collection_terminal_mismatch");
    }
    if (!active.terminalUploaded) {
      const renewed = await api.renewDesktopJob(prepared.task.taskId,
        prepared.taskToken, active.leaseVersion, active.controller.signal);
      await this.assertCloudCollectionIdentity(active, renewed);
      active.leaseVersion = renewed.leaseVersion;
      active.cloudCursor = renewed.cursor;
      let cursor = active.cloudCursor;
      const seenCursors = new Set<string | null>();
      while (true) {
        if (seenCursors.has(cursor)) throw new Error("desktop_collection_cursor_mismatch");
        seenCursors.add(cursor);
        this.assertCurrentCollection(active);
        const page: DouyinCollectionPage = await this.bridge!.getDouyinCollectionResults(
          prepared.task.taskId, cursor ?? undefined
        );
        if (page.taskId !== prepared.task.taskId || page.cursor !== cursor
          || page.done !== (page.nextCursor === null)) {
          active.localTaskIds.add(page.taskId);
          await this.cancelCollection(active);
          throw new Error("desktop_collection_page_mismatch");
        }
        const terminal = page.done ? {
          state: status.state,
          failureCode: status.state === "partial"
            ? "crawl_interrupted_after_partial_results" as const : null,
          activity: status.activity
        } : undefined;
        const idempotencyKey = await pageIdempotencyKey(prepared.task.taskId, cursor);
        const uploaded = await retryBounded(() => api.uploadDesktopPage(
          prepared.task.taskId, prepared.taskToken, idempotencyKey, {
            leaseVersion: active.leaseVersion,
            cursor: page.cursor,
            nextCursor: page.nextCursor,
            done: page.done,
            records: page.records,
            ...(terminal ? { terminal } : {})
          }, active.controller.signal
        ));
        await this.assertCloudCollectionIdentity(active, uploaded);
        active.leaseVersion = uploaded.leaseVersion;
        active.cloudCursor = uploaded.cursor;
        this.assertCurrentCollection(active);
        if (page.done) {
          active.terminalUploaded = true;
          break;
        }
        if (!page.nextCursor || page.nextCursor === cursor) {
          await this.cancelCollection(active);
          throw new Error("desktop_collection_cursor_mismatch");
        }
        cursor = page.nextCursor;
      }
    }
    const durable: DesktopCrawlerJobResource = await retryBounded(() =>
      api.completeDesktopJob(prepared.task.taskId, prepared.taskToken,
        active.controller.signal));
    await this.assertCloudCollectionIdentity(active, durable);
    if (!durable.cloudDurable || durable.ingestionState !== "succeeded"
      || durable.activity.phase !== "completed"
      || durable.activity.currentKeyword !== null
      || durable.activity.browserMode !== "visible") {
      throw new Error("desktop_collection_cloud_not_durable");
    }
    active.phase = "cloud_durable";
    this.assertCurrentCollection(active);
    await retryBounded(() => this.bridge!.acknowledgeDouyinCollection(
      prepared.task.taskId));
    this.assertCurrentCollection(active);
  }
}

export interface AcquisitionBrowserRuntimeSet {
  readonly remote: RemoteBrowserRuntime;
  readonly desktop: LocalDesktopBrowserRuntime;
  forSession(session: Pick<DouyinLoginSession, "interactionSurface"> | null):
    AcquisitionBrowserRuntime;
}

export function createAcquisitionBrowserRuntimes(
  api: DesktopCapableApi,
  options: {
    desktopBridge?: ShensiDesktopApi | null;
    accountId?: string | null | (() => string | null);
    onLocalAccount?: (account: DouyinAccount, local: DouyinLoginStatus) => Promise<void>;
  } = {}
): AcquisitionBrowserRuntimeSet {
  const remote = new RemoteBrowserRuntime(api);
  const configuredAccountId = options.accountId;
  const accountId: () => string | null = typeof configuredAccountId === "function"
    ? configuredAccountId : () => configuredAccountId ?? null;
  const desktop = options.desktopBridge
    ? new LocalDesktopBrowserRuntime(api, options.desktopBridge, accountId, options.onLocalAccount)
    : new LocalDesktopBrowserRuntime(api, null, accountId);
  return Object.freeze({
    remote,
    desktop,
    forSession(session: Pick<DouyinLoginSession, "interactionSurface"> | null) {
      return options.desktopBridge && (session?.interactionSurface === "external_window"
        || session === null) ? desktop : remote;
    }
  });
}
