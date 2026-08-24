import type { DouyinMediaCrawlerGateway } from "./acquisition-mediacrawler-gateway.js";
import type { AcquisitionSocialAccount, AcquisitionSocialAccountLoginSession } from "./acquisition-social-account.js";
import { publicSocialAccount } from "./acquisition-social-account.js";
import type { AcquisitionSocialAccountPrivateRecord, AcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";

export interface AcquisitionSocialAccountScope { workspaceId: string; }
export interface AcquisitionSocialAccountServiceOptions {
  repository: AcquisitionSocialAccountRepository;
  gateway: Pick<DouyinMediaCrawlerGateway, "createLoginSession" | "getLoginSession"> & Partial<Pick<DouyinMediaCrawlerGateway, "disconnectLoginSession">>;
  idFactory?: () => string;
  now?: () => string;
}
class SocialAccountError extends Error { constructor(readonly code: string) { super(code); this.name = "SocialAccountError"; } }
export class AcquisitionSocialAccountService {
  private readonly repository: AcquisitionSocialAccountRepository;
  private readonly gateway: AcquisitionSocialAccountServiceOptions["gateway"];
  private readonly idFactory: () => string;
  private readonly now: () => string;
  private readonly inFlight = new Map<string, Promise<{ view: AcquisitionSocialAccountLoginSession; status: number }>>();
  private readonly disconnectInFlight = new Map<string, Promise<{ view: AcquisitionSocialAccount; status: number }>>();
  constructor(options: AcquisitionSocialAccountServiceOptions) { this.repository = options.repository; this.gateway = options.gateway; this.idFactory = options.idFactory ?? (() => crypto.randomUUID()); this.now = options.now ?? (() => new Date().toISOString()); }
  async createLoginSession(scope: AcquisitionSocialAccountScope, input: { platform: "douyin" }): Promise<AcquisitionSocialAccountLoginSession> {
    if (input.platform !== "douyin") throw new SocialAccountError("unsupported_social_platform");
    const upstream = await this.gateway.createLoginSession(); const id = this.idFactory();
    await this.repository.deleteExpiredLoginSessions(this.now());
    await this.repository.saveLoginSession({ id, workspaceId: scope.workspaceId, upstreamId: upstream.sessionId, expiresAt: upstream.expiresAt, createdAt: this.now() });
    return Object.freeze({ id, platform: "douyin", state: upstream.state === "active" ? "active" : upstream.state === "awaiting_scan" ? "awaiting_scan" : "login_expired", qrImageDataUrl: upstream.qrImageDataUrl, expiresAt: upstream.expiresAt, account: null });
  }
  async createLoginSessionIdempotently(scope: AcquisitionSocialAccountScope, input: { platform: "douyin" }, key: string, requestHash: string) {
    const operation = "create_douyin_login_session";
    const replayKey = `${scope.workspaceId}\u0000${operation}\u0000${key}`;
    const claim = await this.repository.claimReplay(scope.workspaceId, operation, key, requestHash, new Date(Date.parse(this.now()) + 24 * 60 * 60 * 1000).toISOString());
    if (claim.kind === "conflict") throw new SocialAccountError("idempotency_key_conflict");
    if (claim.kind === "completed") return { view: claim.replay.response as AcquisitionSocialAccountLoginSession, status: claim.replay.status, replayed: true };
    if (claim.kind === "pending") {
      const pending = this.inFlight.get(replayKey);
      if (!pending) throw new SocialAccountError("idempotency_operation_pending");
      const completed = await pending;
      return { ...completed, replayed: true };
    }
    const pending = (async () => {
      const view = await this.createLoginSession(scope, input);
      const completed = { view, status: 201 };
      await this.repository.saveReplay(scope.workspaceId, operation, key, { requestHash, response: view, status: 201 });
      return completed;
    })();
    this.inFlight.set(replayKey, pending);
    try { return { ...(await pending), replayed: false }; }
    finally { this.inFlight.delete(replayKey); }
  }
  private async session(scope: AcquisitionSocialAccountScope, id: string) { const session = await this.repository.findLoginSession(scope.workspaceId, id); if (!session) throw new SocialAccountError("douyin_login_session_not_found"); return session; }
  async getLoginSession(scope: AcquisitionSocialAccountScope, id: string): Promise<AcquisitionSocialAccountLoginSession> {
    const session = await this.session(scope, id); const upstream = await this.gateway.getLoginSession(session.upstreamId);
    if (upstream.state === "active") return { id, platform: "douyin", state: "active", qrImageDataUrl: null, expiresAt: upstream.expiresAt, account: await this.bindUpstreamActive(scope, upstream) };
    return { id, platform: "douyin", state: upstream.state === "expired" ? "login_expired" : "awaiting_scan", qrImageDataUrl: upstream.qrImageDataUrl, expiresAt: upstream.expiresAt, account: null };
  }
  async bindActiveSession(scope: AcquisitionSocialAccountScope, id: string): Promise<AcquisitionSocialAccount> { const session = await this.session(scope, id); const upstream = await this.gateway.getLoginSession(session.upstreamId); if (upstream.state !== "active" || !upstream.accountHandle) throw new SocialAccountError("douyin_login_session_not_active"); return this.bindUpstreamActive(scope, upstream); }
  private async bindUpstreamActive(scope: AcquisitionSocialAccountScope, upstream: Awaited<ReturnType<DouyinMediaCrawlerGateway["getLoginSession"]>>) {
    if (!upstream.accountHandle) throw new SocialAccountError("douyin_login_session_not_active");
    const current = await this.repository.findByWorkspaceAndPlatform(scope.workspaceId, "douyin");
    if (current?.accountHandle === upstream.accountHandle && current.state === "active") return publicSocialAccount(current);
    const now = this.now(); const revision = (current?.revision ?? 0) + 1;
    const account: AcquisitionSocialAccountPrivateRecord = { id: current?.id ?? this.idFactory(), workspaceId: scope.workspaceId, platform: "douyin", displayName: upstream.accountDisplayName, state: "active", loginStateVersion: upstream.loginStateVersion, accountHandle: upstream.accountHandle, upstreamSessionId: upstream.sessionId, revision, etag: `\"account-v${revision}\"`, lastValidatedAt: now, createdAt: current?.createdAt ?? now, updatedAt: now };
    const bound = await this.repository.bindActive(account);
    if (bound === "active_handle_conflict") throw new SocialAccountError("douyin_active_account_conflict");
    return publicSocialAccount(bound);
  }
  async list(scope: AcquisitionSocialAccountScope): Promise<{ items: AcquisitionSocialAccount[] }> { const account = await this.repository.findByWorkspaceAndPlatform(scope.workspaceId, "douyin"); return { items: account ? [publicSocialAccount(account)] : [] }; }
  async disconnect(scope: AcquisitionSocialAccountScope, id: string, etag: string): Promise<AcquisitionSocialAccount> { const current = await this.repository.findById(scope.workspaceId, id); if (!current) throw new SocialAccountError("social_account_not_found"); const account = await this.repository.disconnect(scope.workspaceId, id, etag, this.now()); if (!account) throw new SocialAccountError("social_account_precondition_failed"); if (current.upstreamSessionId && this.gateway.disconnectLoginSession) await this.gateway.disconnectLoginSession(current.upstreamSessionId); return publicSocialAccount(account); }
  async disconnectIdempotently(scope: AcquisitionSocialAccountScope, id: string, etag: string, key: string, requestHash: string) {
    const operation = "disconnect_douyin_social_account";
    const replayKey = `${scope.workspaceId}\u0000${operation}\u0000${key}`;
    const claim = await this.repository.claimReplay(scope.workspaceId, operation, key, requestHash, new Date(Date.parse(this.now()) + 24 * 60 * 60 * 1000).toISOString());
    if (claim.kind === "conflict") throw new SocialAccountError("idempotency_key_conflict");
    if (claim.kind === "completed") return { view: claim.replay.response as AcquisitionSocialAccount, status: claim.replay.status, replayed: true };
    if (claim.kind === "pending") {
      const pending = this.disconnectInFlight.get(replayKey);
      if (!pending) throw new SocialAccountError("idempotency_operation_pending");
      return { ...(await pending), replayed: true };
    }
    const pending = (async () => { const view = await this.disconnect(scope, id, etag); const completed = { view, status: 200 }; await this.repository.saveReplay(scope.workspaceId, operation, key, { requestHash, response: view, status: 200 }); return completed; })();
    this.disconnectInFlight.set(replayKey, pending);
    try { return { ...(await pending), replayed: false }; }
    finally { this.disconnectInFlight.delete(replayKey); }
  }
}
export { SocialAccountError };
