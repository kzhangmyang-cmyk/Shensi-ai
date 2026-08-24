import type { AcquisitionSocialAccount, AcquisitionSocialAccountState } from "./acquisition-social-account.js";

export interface AcquisitionSocialAccountPrivateRecord extends AcquisitionSocialAccount {
  accountHandle: string | null;
}

export interface AcquisitionSocialAccountRepository {
  findByWorkspaceAndPlatform(workspaceId: string, platform: "douyin"): Promise<AcquisitionSocialAccountPrivateRecord | null>;
  findById(workspaceId: string, id: string): Promise<AcquisitionSocialAccountPrivateRecord | null>;
  upsert(record: AcquisitionSocialAccountPrivateRecord): Promise<AcquisitionSocialAccountPrivateRecord>;
  disconnect(workspaceId: string, id: string, etag: string, updatedAt: string): Promise<AcquisitionSocialAccountPrivateRecord | null>;
}

function clone(record: AcquisitionSocialAccountPrivateRecord) { return Object.freeze({ ...record }); }
function valid(record: AcquisitionSocialAccountPrivateRecord) {
  const keys = Object.keys(record);
  if (keys.some((key) => /cookie|profile|browser|service.?url|secret/i.test(key))) throw new TypeError("social_account_private_field_forbidden");
}

export class InMemoryAcquisitionSocialAccountRepository implements AcquisitionSocialAccountRepository {
  private readonly records = new Map<string, AcquisitionSocialAccountPrivateRecord>();
  private key(workspaceId: string, platform: "douyin") { return `${workspaceId}\u0000${platform}`; }
  async findByWorkspaceAndPlatform(workspaceId: string, platform: "douyin") { return this.records.get(this.key(workspaceId, platform)) ?? null; }
  async findById(workspaceId: string, id: string) { return [...this.records.values()].find((record) => record.workspaceId === workspaceId && record.id === id) ?? null; }
  async upsert(record: AcquisitionSocialAccountPrivateRecord) { valid(record); const saved = clone(record); this.records.set(this.key(saved.workspaceId, saved.platform), saved); return saved; }
  async disconnect(workspaceId: string, id: string, etag: string, updatedAt: string) {
    const existing = await this.findById(workspaceId, id);
    if (!existing || existing.etag !== etag) return null;
    const saved = clone({ ...existing, state: "disconnected" as AcquisitionSocialAccountState, accountHandle: null, loginStateVersion: null,
      revision: existing.revision + 1, etag: `\"account-v${existing.revision + 1}\"`, updatedAt });
    this.records.set(this.key(saved.workspaceId, saved.platform), saved); return saved;
  }
}
