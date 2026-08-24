import type { AcquisitionSocialAccount, AcquisitionSocialAccountState } from "./acquisition-social-account.js";

export interface AcquisitionSocialAccountPrivateRecord extends AcquisitionSocialAccount {
  accountHandle: string | null;
  upstreamSessionId?: string | null;
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
  headers: Readonly<Record<string, string>>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt: string;
}

export interface AcquisitionSocialAccountReplayReservationInput {
  workspaceId: string;
  operation: string;
  key: string;
  requestHash: string;
  attemptedAt: string;
  leaseOwner: string;
  leaseDurationMs: number;
  replayExpiresAt: string;
}

export interface AcquisitionSocialAccountReplayFence {
  workspaceId: string;
  operation: string;
  key: string;
  leaseOwner: string;
  fencingToken: number;
}

export interface AcquisitionSocialAccountReplayCompletion {
  requestHash: string;
  response: unknown;
  status: number;
  headers: Readonly<Record<string, string>>;
  completedAt: string;
}

export type AcquisitionSocialAccountReplayClaim =
  | ({ kind: "claimed"; leaseExpiresAt: string } & AcquisitionSocialAccountReplayFence)
  | { kind: "pending"; retryAfterMs: number }
  | { kind: "completed"; replay: AcquisitionSocialAccountReplay }
  | { kind: "conflict" };

export interface AcquisitionSocialAccountRepository {
  findByWorkspaceAndPlatform(workspaceId: string, platform: "douyin"): Promise<AcquisitionSocialAccountPrivateRecord | null>;
  findById(workspaceId: string, id: string): Promise<AcquisitionSocialAccountPrivateRecord | null>;
  upsert(record: AcquisitionSocialAccountPrivateRecord): Promise<AcquisitionSocialAccountPrivateRecord>;
  bindActive(record: AcquisitionSocialAccountPrivateRecord): Promise<AcquisitionSocialAccountPrivateRecord | "active_handle_conflict">;
  disconnect(workspaceId: string, id: string, etag: string, updatedAt: string): Promise<AcquisitionSocialAccountPrivateRecord | null>;
  saveLoginSession(record: AcquisitionSocialLoginSessionPrivateRecord): Promise<void>;
  findLoginSession(workspaceId: string, id: string): Promise<AcquisitionSocialLoginSessionPrivateRecord | null>;
  deleteExpiredLoginSessions(now: string): Promise<void>;
  claimReplay(input: AcquisitionSocialAccountReplayReservationInput): Promise<AcquisitionSocialAccountReplayClaim>;
  completeReplay(fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion): Promise<void>;
  releaseReplay(fence: AcquisitionSocialAccountReplayFence): Promise<void>;
  saveLoginSessionAndCompleteReplay(record: AcquisitionSocialLoginSessionPrivateRecord, fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion): Promise<void>;
  disconnectAndCompleteReplay(workspaceId: string, id: string, etag: string, updatedAt: string, fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion): Promise<AcquisitionSocialAccountPrivateRecord | null>;
}

function cloneRecord(record: AcquisitionSocialAccountPrivateRecord) {
  return Object.freeze({ ...record });
}

const privateRecordKeys = new Set([
  "id", "workspaceId", "platform", "accountHandle", "upstreamSessionId", "displayName", "state",
  "loginStateVersion", "revision", "etag", "lastValidatedAt", "createdAt", "updatedAt"
]);

export function assertValidAcquisitionSocialAccountPrivateRecord(record: AcquisitionSocialAccountPrivateRecord) {
  if (Object.keys(record).some((key) => !privateRecordKeys.has(key))) {
    throw new TypeError("social_account_private_field_forbidden");
  }
}

interface MemoryReplayRecord {
  workspaceId: string;
  operation: string;
  key: string;
  requestHash: string;
  state: "pending" | "completed";
  response: unknown;
  status: number;
  headers: Readonly<Record<string, string>>;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt: string | null;
}

function instant(value: string, code: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(code);
  return milliseconds;
}

function replayKey(workspaceId: string, operation: string, key: string) {
  return `${workspaceId}\u0000${operation}\u0000${key}`;
}

function replayView(record: MemoryReplayRecord): AcquisitionSocialAccountReplay {
  if (record.state !== "completed" || !record.completedAt) {
    throw new Error("social_account_replay_not_completed");
  }
  return Object.freeze({
    requestHash: record.requestHash,
    response: structuredClone(record.response),
    status: record.status,
    headers: Object.freeze({ ...record.headers }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    completedAt: record.completedAt
  });
}

export class InMemoryAcquisitionSocialAccountRepository implements AcquisitionSocialAccountRepository {
  private readonly records = new Map<string, AcquisitionSocialAccountPrivateRecord>();
  private readonly sessions = new Map<string, AcquisitionSocialLoginSessionPrivateRecord>();
  private readonly replays = new Map<string, MemoryReplayRecord>();

  private accountKey(workspaceId: string, platform: "douyin") { return `${workspaceId}\u0000${platform}`; }

  async findByWorkspaceAndPlatform(workspaceId: string, platform: "douyin") {
    return this.records.get(this.accountKey(workspaceId, platform)) ?? null;
  }

  async findById(workspaceId: string, id: string) {
    return [...this.records.values()].find((record) => record.workspaceId === workspaceId && record.id === id) ?? null;
  }

  async upsert(record: AcquisitionSocialAccountPrivateRecord) {
    assertValidAcquisitionSocialAccountPrivateRecord(record);
    const saved = cloneRecord(record);
    this.records.set(this.accountKey(saved.workspaceId, saved.platform), saved);
    return saved;
  }

  async bindActive(record: AcquisitionSocialAccountPrivateRecord) {
    assertValidAcquisitionSocialAccountPrivateRecord(record);
    const current = this.records.get(this.accountKey(record.workspaceId, record.platform));
    if (current?.state === "active" && current.accountHandle !== record.accountHandle) return "active_handle_conflict" as const;
    if (current?.state === "active" && current.accountHandle === record.accountHandle) return current;
    const saved = cloneRecord(record);
    this.records.set(this.accountKey(saved.workspaceId, saved.platform), saved);
    return saved;
  }

  private disconnected(existing: AcquisitionSocialAccountPrivateRecord, updatedAt: string) {
    return cloneRecord({ ...existing, state: "disconnected" as AcquisitionSocialAccountState, accountHandle: null, upstreamSessionId: null, loginStateVersion: null,
      revision: existing.revision + 1, etag: `\"account-v${existing.revision + 1}\"`, updatedAt });
  }

  async disconnect(workspaceId: string, id: string, etag: string, updatedAt: string) {
    const existing = [...this.records.values()].find((record) => record.workspaceId === workspaceId && record.id === id);
    if (!existing || existing.etag !== etag) return null;
    const saved = this.disconnected(existing, updatedAt);
    this.records.set(this.accountKey(saved.workspaceId, saved.platform), saved);
    return saved;
  }

  async saveLoginSession(record: AcquisitionSocialLoginSessionPrivateRecord) {
    this.sessions.set(`${record.workspaceId}\u0000${record.id}`, Object.freeze({ ...record }));
  }

  async findLoginSession(workspaceId: string, id: string) {
    return this.sessions.get(`${workspaceId}\u0000${id}`) ?? null;
  }

  async deleteExpiredLoginSessions(now: string) {
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
  }

  async claimReplay(input: AcquisitionSocialAccountReplayReservationInput): Promise<AcquisitionSocialAccountReplayClaim> {
    const attemptedAt = instant(input.attemptedAt, "invalid_replay_attempted_at");
    const replayExpiry = instant(input.replayExpiresAt, "invalid_replay_expires_at");
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1 || replayExpiry <= attemptedAt) {
      throw new TypeError("invalid_replay_reservation");
    }
    const key = replayKey(input.workspaceId, input.operation, input.key);
    const existing = this.replays.get(key);
    if (!existing || instant(existing.expiresAt, "invalid_replay_expires_at") <= attemptedAt) {
      const fencingToken = (existing?.fencingToken ?? 0) + 1;
      const leaseExpiresAt = new Date(attemptedAt + input.leaseDurationMs).toISOString();
      this.replays.set(key, {
        workspaceId: input.workspaceId, operation: input.operation, key: input.key,
        requestHash: input.requestHash, state: "pending", response: null, status: 0,
        headers: Object.freeze({}), leaseOwner: input.leaseOwner, leaseExpiresAt,
        fencingToken, createdAt: input.attemptedAt, updatedAt: input.attemptedAt,
        expiresAt: input.replayExpiresAt, completedAt: null
      });
      return { kind: "claimed", workspaceId: input.workspaceId, operation: input.operation, key: input.key,
        leaseOwner: input.leaseOwner, leaseExpiresAt, fencingToken };
    }
    if (existing.requestHash !== input.requestHash) return { kind: "conflict" };
    if (existing.state === "completed") return { kind: "completed", replay: replayView(existing) };
    const leaseExpiry = instant(existing.leaseExpiresAt ?? "", "invalid_replay_lease_expiry");
    if (attemptedAt < leaseExpiry) return { kind: "pending", retryAfterMs: leaseExpiry - attemptedAt };
    existing.leaseOwner = input.leaseOwner;
    existing.leaseExpiresAt = new Date(attemptedAt + input.leaseDurationMs).toISOString();
    existing.fencingToken += 1;
    existing.updatedAt = input.attemptedAt;
    return { kind: "claimed", workspaceId: input.workspaceId, operation: input.operation, key: input.key,
      leaseOwner: input.leaseOwner, leaseExpiresAt: existing.leaseExpiresAt, fencingToken: existing.fencingToken };
  }

  private pending(fence: AcquisitionSocialAccountReplayFence) {
    const record = this.replays.get(replayKey(fence.workspaceId, fence.operation, fence.key));
    if (!record || record.state !== "pending" || record.leaseOwner !== fence.leaseOwner || record.fencingToken !== fence.fencingToken) {
      throw new Error("stale_social_account_replay_fence");
    }
    return record;
  }

  private complete(record: MemoryReplayRecord, completion: AcquisitionSocialAccountReplayCompletion) {
    if (record.requestHash !== completion.requestHash) throw new Error("replay_request_hash_mismatch");
    record.state = "completed";
    record.response = structuredClone(completion.response);
    record.status = completion.status;
    record.headers = Object.freeze({ ...completion.headers });
    record.leaseOwner = null;
    record.leaseExpiresAt = null;
    record.updatedAt = completion.completedAt;
    record.completedAt = completion.completedAt;
  }

  async completeReplay(fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion) {
    this.complete(this.pending(fence), completion);
  }

  async releaseReplay(fence: AcquisitionSocialAccountReplayFence) {
    this.pending(fence);
    this.replays.delete(replayKey(fence.workspaceId, fence.operation, fence.key));
  }

  async saveLoginSessionAndCompleteReplay(record: AcquisitionSocialLoginSessionPrivateRecord, fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion) {
    const pending = this.pending(fence);
    if (pending.requestHash !== completion.requestHash) throw new Error("replay_request_hash_mismatch");
    this.sessions.set(`${record.workspaceId}\u0000${record.id}`, Object.freeze({ ...record }));
    this.complete(pending, completion);
  }

  async disconnectAndCompleteReplay(workspaceId: string, id: string, etag: string, updatedAt: string, fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion) {
    const pending = this.pending(fence);
    if (pending.requestHash !== completion.requestHash) throw new Error("replay_request_hash_mismatch");
    const existing = [...this.records.values()].find((record) => record.workspaceId === workspaceId && record.id === id);
    if (!existing || existing.etag !== etag) return null;
    const saved = this.disconnected(existing, updatedAt);
    this.records.set(this.accountKey(saved.workspaceId, saved.platform), saved);
    this.complete(pending, completion);
    return saved;
  }
}
