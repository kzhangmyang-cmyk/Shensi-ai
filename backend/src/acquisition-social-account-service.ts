import type { DouyinMediaCrawlerGateway, DouyinLoginSession } from "./acquisition-mediacrawler-gateway.js";
import type { AcquisitionSocialAccount, AcquisitionSocialAccountLoginSession } from "./acquisition-social-account.js";
import { publicSocialAccount } from "./acquisition-social-account.js";
import type {
  AcquisitionSocialAccountPrivateRecord,
  AcquisitionSocialAccountReplayClaim,
  AcquisitionSocialAccountReplayCompletion,
  AcquisitionSocialAccountReplayFence,
  AcquisitionSocialAccountRepository,
  AcquisitionSocialLoginSessionPrivateRecord
} from "./acquisition-social-account-repository.js";

export interface AcquisitionSocialAccountScope { workspaceId: string; }

export interface AcquisitionSocialAccountServiceOptions {
  repository: AcquisitionSocialAccountRepository;
  gateway: Pick<DouyinMediaCrawlerGateway, "createLoginSession" | "getLoginSession"> & Partial<Pick<DouyinMediaCrawlerGateway, "disconnectLoginSession">>;
  idFactory?: () => string;
  now?: () => string;
  leaseOwnerFactory?: () => string;
  replayLeaseMs?: number;
  replayTtlMs?: number;
  pendingWaitMs?: number;
  pendingPollMs?: number;
}

class SocialAccountError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SocialAccountError";
  }
}

interface IdempotentResult<T> {
  view: T;
  status: number;
  headers: Readonly<Record<string, string>>;
  replayed: boolean;
}

function boundedMilliseconds(value: number | undefined, fallback: number, name: string, minimum = 1) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > 24 * 60 * 60 * 1_000) {
    throw new TypeError(`${name} is invalid`);
  }
  return selected;
}

function later(instant: string, milliseconds: number) {
  const value = Date.parse(instant);
  if (!Number.isFinite(value)) throw new TypeError("invalid_social_account_clock");
  return new Date(value + milliseconds).toISOString();
}

function replayHeaders() {
  return Object.freeze({ "Idempotency-Replayed": "true" });
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function isBoundDouyinAccountHandle(value: unknown): value is string {
  return typeof value === "string"
    && /^dyacct_[0-9a-f]{64}$/u.test(value);
}

function boundActiveLogin(upstream: DouyinLoginSession) {
  return upstream.state === "active"
    && isBoundDouyinAccountHandle(upstream.accountHandle)
    && typeof upstream.accountDisplayName === "string"
    && upstream.accountDisplayName.trim().length > 0
    && upstream.accountDisplayName.trim().length <= 100
    && Number.isSafeInteger(upstream.loginStateVersion)
    && (upstream.loginStateVersion ?? 0) > 0;
}

export class AcquisitionSocialAccountService {
  private readonly repository: AcquisitionSocialAccountRepository;
  private readonly gateway: AcquisitionSocialAccountServiceOptions["gateway"];
  private readonly idFactory: () => string;
  private readonly now: () => string;
  private readonly leaseOwnerFactory: () => string;
  private readonly replayLeaseMs: number;
  private readonly replayTtlMs: number;
  private readonly pendingWaitMs: number;
  private readonly pendingPollMs: number;

  constructor(options: AcquisitionSocialAccountServiceOptions) {
    this.repository = options.repository;
    this.gateway = options.gateway;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.leaseOwnerFactory = options.leaseOwnerFactory ?? (() => crypto.randomUUID());
    this.replayLeaseMs = boundedMilliseconds(options.replayLeaseMs, 30_000, "replayLeaseMs");
    this.replayTtlMs = boundedMilliseconds(options.replayTtlMs, 24 * 60 * 60 * 1_000, "replayTtlMs");
    this.pendingWaitMs = boundedMilliseconds(options.pendingWaitMs, 5_000, "pendingWaitMs");
    this.pendingPollMs = boundedMilliseconds(options.pendingPollMs, 10, "pendingPollMs");
  }

  private loginView(id: string, upstream: DouyinLoginSession): AcquisitionSocialAccountLoginSession {
    return Object.freeze({
      id,
      platform: "douyin",
      state: upstream.state === "active" ? "active" : upstream.state === "awaiting_scan" ? "awaiting_scan" : "login_expired",
      qrImageDataUrl: upstream.qrImageDataUrl,
      expiresAt: upstream.expiresAt,
      account: null
    });
  }

  async createLoginSession(scope: AcquisitionSocialAccountScope, input: { platform: "douyin" }): Promise<AcquisitionSocialAccountLoginSession> {
    if (input.platform !== "douyin") throw new SocialAccountError("unsupported_social_platform");
    await this.repository.deleteExpiredLoginSessions(this.now());
    const upstream = await this.gateway.createLoginSession();
    const id = this.idFactory();
    try {
      await this.repository.saveLoginSession({ id, workspaceId: scope.workspaceId, upstreamId: upstream.sessionId, expiresAt: upstream.expiresAt, createdAt: this.now() });
    } catch (error) {
      await this.gateway.disconnectLoginSession?.(upstream.sessionId).catch(() => undefined);
      throw error;
    }
    return this.loginView(id, upstream);
  }

  private async claim(scope: AcquisitionSocialAccountScope, operation: string, key: string, requestHash: string): Promise<AcquisitionSocialAccountReplayClaim> {
    const leaseOwner = this.leaseOwnerFactory();
    const waitStarted = Date.now();
    while (true) {
      const attemptedAt = this.now();
      const claim = await this.repository.claimReplay({
        workspaceId: scope.workspaceId,
        operation,
        key,
        requestHash,
        attemptedAt,
        leaseOwner,
        leaseDurationMs: this.replayLeaseMs,
        replayExpiresAt: later(attemptedAt, this.replayTtlMs)
      });
      if (claim.kind !== "pending") return claim;
      const elapsed = Date.now() - waitStarted;
      if (elapsed >= this.pendingWaitMs) throw new SocialAccountError("idempotency_operation_pending");
      await sleep(Math.min(this.pendingPollMs, this.pendingWaitMs - elapsed));
    }
  }

  private completion(requestHash: string, response: unknown, status: number): AcquisitionSocialAccountReplayCompletion {
    return { requestHash, response, status, headers: replayHeaders(), completedAt: this.now() };
  }

  async createLoginSessionIdempotently(scope: AcquisitionSocialAccountScope, input: { platform: "douyin" }, key: string, requestHash: string): Promise<IdempotentResult<AcquisitionSocialAccountLoginSession>> {
    const operation = "create_douyin_login_session";
    const claim = await this.claim(scope, operation, key, requestHash);
    if (claim.kind === "conflict") throw new SocialAccountError("idempotency_key_conflict");
    if (claim.kind === "completed") {
      return { view: claim.replay.response as AcquisitionSocialAccountLoginSession, status: claim.replay.status, headers: claim.replay.headers, replayed: true };
    }
    if (claim.kind !== "claimed") throw new SocialAccountError("idempotency_operation_pending");
    let upstream: DouyinLoginSession | null = null;
    try {
      if (input.platform !== "douyin") throw new SocialAccountError("unsupported_social_platform");
      await this.repository.deleteExpiredLoginSessions(this.now());
      upstream = await this.gateway.createLoginSession();
      const id = this.idFactory();
      const session: AcquisitionSocialLoginSessionPrivateRecord = {
        id, workspaceId: scope.workspaceId, upstreamId: upstream.sessionId,
        expiresAt: upstream.expiresAt, createdAt: this.now()
      };
      const view = this.loginView(id, upstream);
      await this.repository.saveLoginSessionAndCompleteReplay(
        session, claim, this.completion(requestHash, view, 200)
      );
      return { view, status: 201, headers: Object.freeze({}), replayed: false };
    } catch (error) {
      if (upstream) {
        await this.gateway.disconnectLoginSession?.(upstream.sessionId).catch(() => undefined);
      }
      await this.repository.releaseReplay(claim).catch(() => undefined);
      throw error;
    }
  }

  private async session(scope: AcquisitionSocialAccountScope, id: string) {
    const session = await this.repository.findLoginSession(scope.workspaceId, id);
    if (!session) throw new SocialAccountError("douyin_login_session_not_found");
    return session;
  }

  async getLoginSession(scope: AcquisitionSocialAccountScope, id: string): Promise<AcquisitionSocialAccountLoginSession> {
    const session = await this.session(scope, id);
    const upstream = await this.gateway.getLoginSession(session.upstreamId);
    if (upstream.state === "active" && boundActiveLogin(upstream)) return { id, platform: "douyin", state: "active", qrImageDataUrl: null, expiresAt: upstream.expiresAt, account: await this.bindUpstreamActive(scope, upstream) };
    if (upstream.state === "active" || upstream.state === "failed") return {
      id, platform: "douyin", state: "login_expired", qrImageDataUrl: null,
      expiresAt: upstream.expiresAt, account: null
    };
    return { id, platform: "douyin", state: upstream.state === "expired" ? "login_expired" : "awaiting_scan", qrImageDataUrl: upstream.qrImageDataUrl, expiresAt: upstream.expiresAt, account: null };
  }

  async bindActiveSession(scope: AcquisitionSocialAccountScope, id: string): Promise<AcquisitionSocialAccount> {
    const session = await this.session(scope, id);
    const upstream = await this.gateway.getLoginSession(session.upstreamId);
    if (!boundActiveLogin(upstream)) throw new SocialAccountError("douyin_login_session_not_active");
    return this.bindUpstreamActive(scope, upstream);
  }

  private async bindUpstreamActive(scope: AcquisitionSocialAccountScope, upstream: DouyinLoginSession) {
    if (!boundActiveLogin(upstream) || !upstream.accountHandle
      || !upstream.accountDisplayName || !upstream.loginStateVersion) {
      throw new SocialAccountError("douyin_login_session_not_active");
    }
    const current = await this.repository.findByWorkspaceAndPlatform(scope.workspaceId, "douyin");
    if (current?.accountHandle === upstream.accountHandle && current.state === "active") {
      if (current.loginStateVersion === upstream.loginStateVersion
        && current.upstreamSessionId === upstream.sessionId
        && current.displayName === upstream.accountDisplayName.trim()) {
        return publicSocialAccount(current);
      }
      if ((current.loginStateVersion ?? 0) >= upstream.loginStateVersion) {
        throw new SocialAccountError("douyin_login_session_not_active");
      }
    }
    const now = this.now();
    const revision = (current?.revision ?? 0) + 1;
    const account: AcquisitionSocialAccountPrivateRecord = {
      id: current?.id ?? this.idFactory(), workspaceId: scope.workspaceId, platform: "douyin",
      displayName: upstream.accountDisplayName.trim(), state: "active", loginStateVersion: upstream.loginStateVersion,
      loginStateVersionHighWater: Math.max(current?.loginStateVersionHighWater ?? 0,
        upstream.loginStateVersion),
      accountHandle: upstream.accountHandle, upstreamSessionId: upstream.sessionId, revision,
      etag: `\"account-v${revision}\"`, lastValidatedAt: now, createdAt: current?.createdAt ?? now, updatedAt: now
    };
    const bound = await this.repository.bindActive(account);
    if (bound === "active_handle_conflict") throw new SocialAccountError("douyin_active_account_conflict");
    if (bound.state !== "active"
      || bound.accountHandle !== upstream.accountHandle
      || bound.upstreamSessionId !== upstream.sessionId
      || bound.loginStateVersion !== upstream.loginStateVersion) {
      throw new SocialAccountError("douyin_login_session_not_active");
    }
    return publicSocialAccount(bound);
  }

  async list(scope: AcquisitionSocialAccountScope): Promise<{ items: AcquisitionSocialAccount[] }> {
    const account = await this.repository.findByWorkspaceAndPlatform(scope.workspaceId, "douyin");
    if (!account) return { items: [] };
    const safe = account.state === "active"
      && (!isBoundDouyinAccountHandle(account.accountHandle)
        || !account.displayName?.trim()
        || !Number.isSafeInteger(account.loginStateVersion)
        || (account.loginStateVersion ?? 0) < 1)
      ? { ...account, state: "login_expired" as const }
      : account;
    return { items: [publicSocialAccount(safe)] };
  }

  private disconnected(current: AcquisitionSocialAccountPrivateRecord, updatedAt: string) {
    return { ...current, state: "disconnected" as const, accountHandle: null, upstreamSessionId: null, loginStateVersion: null,
      revision: current.revision + 1, etag: `\"account-v${current.revision + 1}\"`, updatedAt };
  }

  async disconnect(scope: AcquisitionSocialAccountScope, id: string, etag: string): Promise<AcquisitionSocialAccount> {
    const current = await this.repository.findById(scope.workspaceId, id);
    if (!current) throw new SocialAccountError("social_account_not_found");
    if (current.etag !== etag) throw new SocialAccountError("social_account_precondition_failed");
    if (current.upstreamSessionId && this.gateway.disconnectLoginSession) {
      await this.gateway.disconnectLoginSession(current.upstreamSessionId);
    }
    const account = await this.repository.disconnect(scope.workspaceId, id, etag, this.now());
    if (!account) throw new SocialAccountError("social_account_precondition_failed");
    return publicSocialAccount(account);
  }

  async disconnectIdempotently(scope: AcquisitionSocialAccountScope, id: string, etag: string, key: string, requestHash: string): Promise<IdempotentResult<AcquisitionSocialAccount>> {
    const operation = "disconnect_douyin_social_account";
    const claim = await this.claim(scope, operation, key, requestHash);
    if (claim.kind === "conflict") throw new SocialAccountError("idempotency_key_conflict");
    if (claim.kind === "completed") {
      return { view: claim.replay.response as AcquisitionSocialAccount, status: claim.replay.status, headers: claim.replay.headers, replayed: true };
    }
    if (claim.kind !== "claimed") throw new SocialAccountError("idempotency_operation_pending");
    try {
      const current = await this.repository.findById(scope.workspaceId, id);
      if (!current) throw new SocialAccountError("social_account_not_found");
      if (current.etag !== etag) throw new SocialAccountError("social_account_precondition_failed");
      const updatedAt = this.now();
      const expected = this.disconnected(current, updatedAt);
      const view = publicSocialAccount(expected);
      if (current.upstreamSessionId && this.gateway.disconnectLoginSession) {
        await this.gateway.disconnectLoginSession(current.upstreamSessionId);
      }
      const account = await this.repository.disconnectAndCompleteReplay(
        scope.workspaceId, id, etag, updatedAt, claim,
        this.completion(requestHash, view, 200)
      );
      if (!account) throw new SocialAccountError("social_account_precondition_failed");
      return { view: publicSocialAccount(account), status: 200, headers: Object.freeze({}), replayed: false };
    } catch (error) {
      await this.repository.releaseReplay(claim).catch(() => undefined);
      throw error;
    }
  }
}

export { SocialAccountError };
