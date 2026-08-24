import type { AcquisitionSocialAccount, AcquisitionSocialAccountState } from "./acquisition-social-account.js";

export interface AcquisitionSocialAccountPrivateRecord extends AcquisitionSocialAccount {
  accountHandle: string | null;
}
export interface AcquisitionSocialLoginSessionPrivateRecord {
  id: string;
  workspaceId: string;
  upstreamId: string;
  expiresAt: string;
  createdAt: string;
}
export interface AcquisitionSocialAccountReplay {
  requestHash: string;
  response: unknown;
  status: number;
}

export interface AcquisitionSocialAccountRepository {
  findByWorkspaceAndPlatform(workspaceId: string, platform: "douyin"): Promise<AcquisitionSocialAccountPrivateRecord | null>;
  findById(workspaceId: string, id: string): Promise<AcquisitionSocialAccountPrivateRecord | null>;
  upsert(record: AcquisitionSocialAccountPrivateRecord): Promise<AcquisitionSocialAccountPrivateRecord>;
  bindActive(record: AcquisitionSocialAccountPrivateRecord): Promise<AcquisitionSocialAccountPrivateRecord | "active_handle_conflict">;
  disconnect(workspaceId: string, id: string, etag: string, updatedAt: string): Promise<AcquisitionSocialAccountPrivateRecord | null>;
  saveLoginSession(record: AcquisitionSocialLoginSessionPrivateRecord): Promise<void>;
  findLoginSession(workspaceId: string, id: string): Promise<AcquisitionSocialLoginSessionPrivateRecord | null>;
  deleteExpiredLoginSessions(now: string): Promise<void>;
  findReplay(workspaceId: string, operation: string, key: string): Promise<AcquisitionSocialAccountReplay | null>;
  saveReplay(workspaceId: string, operation: string, key: string, replay: AcquisitionSocialAccountReplay): Promise<void>;
}

function clone(record: AcquisitionSocialAccountPrivateRecord) { return Object.freeze({ ...record }); }
const privateRecordKeys = new Set([
  "id", "workspaceId", "platform", "accountHandle", "displayName", "state",
  "loginStateVersion", "revision", "etag", "lastValidatedAt", "createdAt", "updatedAt"
]);
export function assertValidAcquisitionSocialAccountPrivateRecord(record: AcquisitionSocialAccountPrivateRecord) {
  if (Object.keys(record).some((key) => !privateRecordKeys.has(key))) {
    throw new TypeError("social_account_private_field_forbidden");
  }
}

export class InMemoryAcquisitionSocialAccountRepository implements AcquisitionSocialAccountRepository {
  private readonly records = new Map<string, AcquisitionSocialAccountPrivateRecord>();
  private readonly sessions = new Map<string, AcquisitionSocialLoginSessionPrivateRecord>();
  private readonly replays = new Map<string, AcquisitionSocialAccountReplay>();
  private key(workspaceId: string, platform: "douyin") { return `${workspaceId}\u0000${platform}`; }
  async findByWorkspaceAndPlatform(workspaceId: string, platform: "douyin") { return this.records.get(this.key(workspaceId, platform)) ?? null; }
  async findById(workspaceId: string, id: string) { return [...this.records.values()].find((record) => record.workspaceId === workspaceId && record.id === id) ?? null; }
  async upsert(record: AcquisitionSocialAccountPrivateRecord) { assertValidAcquisitionSocialAccountPrivateRecord(record); const saved = clone(record); this.records.set(this.key(saved.workspaceId, saved.platform), saved); return saved; }
  async bindActive(record: AcquisitionSocialAccountPrivateRecord) {
    assertValidAcquisitionSocialAccountPrivateRecord(record);
    const current = this.records.get(this.key(record.workspaceId, record.platform));
    if (current?.state === "active" && current.accountHandle !== record.accountHandle) return "active_handle_conflict";
    if (current?.state === "active" && current.accountHandle === record.accountHandle) return current;
    const saved = clone(record); this.records.set(this.key(saved.workspaceId, saved.platform), saved); return saved;
  }
  async disconnect(workspaceId: string, id: string, etag: string, updatedAt: string) {
    const existing = await this.findById(workspaceId, id);
    if (!existing || existing.etag !== etag) return null;
    const saved = clone({ ...existing, state: "disconnected" as AcquisitionSocialAccountState, accountHandle: null, loginStateVersion: null,
      revision: existing.revision + 1, etag: `\"account-v${existing.revision + 1}\"`, updatedAt });
    this.records.set(this.key(saved.workspaceId, saved.platform), saved); return saved;
  }
  async saveLoginSession(record: AcquisitionSocialLoginSessionPrivateRecord) { this.sessions.set(`${record.workspaceId}\u0000${record.id}`, Object.freeze({ ...record })); }
  async findLoginSession(workspaceId: string, id: string) { return this.sessions.get(`${workspaceId}\u0000${id}`) ?? null; }
  async deleteExpiredLoginSessions(now: string) { for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key); }
  async findReplay(workspaceId: string, operation: string, key: string) { return this.replays.get(`${workspaceId}\u0000${operation}\u0000${key}`) ?? null; }
  async saveReplay(workspaceId: string, operation: string, key: string, replay: AcquisitionSocialAccountReplay) { this.replays.set(`${workspaceId}\u0000${operation}\u0000${key}`, Object.freeze(structuredClone(replay))); }
}
