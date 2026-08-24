import type { DouyinMediaCrawlerGateway } from "./acquisition-mediacrawler-gateway.js";
import type { AcquisitionSocialAccount, AcquisitionSocialAccountLoginSession } from "./acquisition-social-account.js";
import { publicSocialAccount } from "./acquisition-social-account.js";
import type { AcquisitionSocialAccountPrivateRecord, AcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";

export interface AcquisitionSocialAccountScope { workspaceId: string; }
export interface AcquisitionSocialAccountServiceOptions {
  repository: AcquisitionSocialAccountRepository;
  gateway: Pick<DouyinMediaCrawlerGateway, "createLoginSession" | "getLoginSession">;
  idFactory?: () => string;
  now?: () => string;
}
class SocialAccountError extends Error { constructor(readonly code: string) { super(code); this.name = "SocialAccountError"; } }
interface Session { workspaceId: string; upstreamId: string; }
export class AcquisitionSocialAccountService {
  private readonly sessions = new Map<string, Session>();
  private readonly repository: AcquisitionSocialAccountRepository;
  private readonly gateway: AcquisitionSocialAccountServiceOptions["gateway"];
  private readonly idFactory: () => string;
  private readonly now: () => string;
  constructor(options: AcquisitionSocialAccountServiceOptions) { this.repository = options.repository; this.gateway = options.gateway; this.idFactory = options.idFactory ?? (() => crypto.randomUUID()); this.now = options.now ?? (() => new Date().toISOString()); }
  async createLoginSession(scope: AcquisitionSocialAccountScope, input: { platform: "douyin" }): Promise<AcquisitionSocialAccountLoginSession> {
    if (input.platform !== "douyin") throw new SocialAccountError("unsupported_social_platform");
    const upstream = await this.gateway.createLoginSession(); const id = this.idFactory();
    this.sessions.set(id, { workspaceId: scope.workspaceId, upstreamId: upstream.sessionId });
    return Object.freeze({ id, platform: "douyin", state: upstream.state === "active" ? "active" : upstream.state === "awaiting_scan" ? "awaiting_scan" : "login_expired", qrImageDataUrl: upstream.qrImageDataUrl, expiresAt: upstream.expiresAt, account: null });
  }
  private session(scope: AcquisitionSocialAccountScope, id: string): Session { const session = this.sessions.get(id); if (!session || session.workspaceId !== scope.workspaceId) throw new SocialAccountError("douyin_login_session_not_found"); return session; }
  async getLoginSession(scope: AcquisitionSocialAccountScope, id: string): Promise<AcquisitionSocialAccountLoginSession> {
    const session = this.session(scope, id); const upstream = await this.gateway.getLoginSession(session.upstreamId);
    if (upstream.state === "active") return { id, platform: "douyin", state: "active", qrImageDataUrl: null, expiresAt: upstream.expiresAt, account: await this.bindUpstreamActive(scope, upstream) };
    return { id, platform: "douyin", state: upstream.state === "expired" ? "login_expired" : "awaiting_scan", qrImageDataUrl: upstream.qrImageDataUrl, expiresAt: upstream.expiresAt, account: null };
  }
  async bindActiveSession(scope: AcquisitionSocialAccountScope, id: string): Promise<AcquisitionSocialAccount> { const session = this.session(scope, id); const upstream = await this.gateway.getLoginSession(session.upstreamId); if (upstream.state !== "active" || !upstream.accountHandle) throw new SocialAccountError("douyin_login_session_not_active"); return this.bindUpstreamActive(scope, upstream); }
  private async bindUpstreamActive(scope: AcquisitionSocialAccountScope, upstream: Awaited<ReturnType<DouyinMediaCrawlerGateway["getLoginSession"]>>) {
    if (!upstream.accountHandle) throw new SocialAccountError("douyin_login_session_not_active");
    const current = await this.repository.findByWorkspaceAndPlatform(scope.workspaceId, "douyin");
    if (current?.accountHandle === upstream.accountHandle && current.state === "active") return publicSocialAccount(current);
    const now = this.now(); const revision = (current?.revision ?? 0) + 1;
    const account: AcquisitionSocialAccountPrivateRecord = { id: current?.id ?? this.idFactory(), workspaceId: scope.workspaceId, platform: "douyin", displayName: upstream.accountDisplayName, state: "active", loginStateVersion: upstream.loginStateVersion, accountHandle: upstream.accountHandle, revision, etag: `\"account-v${revision}\"`, lastValidatedAt: now, createdAt: current?.createdAt ?? now, updatedAt: now };
    return publicSocialAccount(await this.repository.upsert(account));
  }
  async list(scope: AcquisitionSocialAccountScope): Promise<{ items: AcquisitionSocialAccount[] }> { const account = await this.repository.findByWorkspaceAndPlatform(scope.workspaceId, "douyin"); return { items: account ? [publicSocialAccount(account)] : [] }; }
  async disconnect(scope: AcquisitionSocialAccountScope, id: string, etag: string): Promise<AcquisitionSocialAccount> { const account = await this.repository.disconnect(scope.workspaceId, id, etag, this.now()); if (!account) throw new SocialAccountError("social_account_precondition_failed"); return publicSocialAccount(account); }
}
export { SocialAccountError };
