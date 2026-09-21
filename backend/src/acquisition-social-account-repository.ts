import type {
  AcquisitionSocialAccount,
  AcquisitionSocialAccountExecutorMode,
  AcquisitionSocialAccountInteractionSurface,
  AcquisitionSocialAccountState
} from "./acquisition-social-account.js";
import {
  AcquisitionMemoryTransactionCoordinator,
  type AcquisitionMemoryTransactionToken
} from "./acquisition-memory-transaction-coordinator.js";

export interface AcquisitionSocialAccountPrivateRecord extends AcquisitionSocialAccount {
  accountHandle: string | null;
  upstreamSessionId?: string | null;
  loginStateVersionHighWater: number;
  executorMode: AcquisitionSocialAccountExecutorMode;
  executorDeviceIdHash: string | null;
  executorBindingGeneration: number;
  executorBindingGenerationHighWater?: number;
  executorLeaseExpiresAt: string | null;
}

export interface AcquisitionSocialAccountIdentityFence {
  accountHandle: string;
  loginStateVersion: number;
  revision: number;
  etag: string;
}

export interface AcquisitionSocialLoginSessionPrivateRecord {
  id: string;
  workspaceId: string;
  upstreamId: string;
  interactionSurface?: AcquisitionSocialAccountInteractionSurface;
  expiresAt: string;
  createdAt: string;
}

export interface AcquisitionSocialLoginOpeningReservationInput {
  workspaceId: string;
  attemptedAt: string;
  leaseOwner: string;
  leaseDurationMs: number;
}

export interface AcquisitionSocialLoginOpeningFence {
  workspaceId: string;
  leaseOwner: string;
  fencingToken: number;
}

export type AcquisitionSocialLoginOpeningClaim =
  | ({ kind: "claimed"; leaseExpiresAt: string } & AcquisitionSocialLoginOpeningFence)
  | { kind: "pending"; retryAfterMs: number }
  | { kind: "existing"; session: AcquisitionSocialLoginSessionPrivateRecord };

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
  bindActiveFromLoginSession(workspaceId: string, sessionId: string, upstreamId: string,
    record: AcquisitionSocialAccountPrivateRecord): Promise<AcquisitionSocialAccountPrivateRecord | "active_handle_conflict" | "login_session_stale">;
  pauseActiveAccount(workspaceId: string, id: string, identity: AcquisitionSocialAccountIdentityFence,
    updatedAt: string): Promise<AcquisitionSocialAccountPrivateRecord | null>;
  disconnect(workspaceId: string, id: string, etag: string, updatedAt: string): Promise<AcquisitionSocialAccountPrivateRecord | null>;
  saveLoginSession(record: AcquisitionSocialLoginSessionPrivateRecord): Promise<void>;
  findLoginSession(workspaceId: string, id: string): Promise<AcquisitionSocialLoginSessionPrivateRecord | null>;
  deleteExpiredLoginSessions(now: string): Promise<void>;
  claimLoginOpening(input: AcquisitionSocialLoginOpeningReservationInput): Promise<AcquisitionSocialLoginOpeningClaim>;
  releaseLoginOpening(fence: AcquisitionSocialLoginOpeningFence): Promise<void>;
  discardLoginOpening(workspaceId: string, sessionId: string): Promise<void>;
  removeLoginSessionAndOpening(workspaceId: string, sessionId: string): Promise<boolean>;
  restoreLoginSessionAndOpening(record: AcquisitionSocialLoginSessionPrivateRecord,
    restoredAt: string): Promise<boolean>;
  beginLoginSessionCancellation(workspaceId: string, sessionId: string, leaseOwner: string,
    leaseExpiresAt: string, updatedAt: string): Promise<AcquisitionSocialLoginOpeningFence | "login_session_stale">;
  completeLoginSessionCancellation(fence: AcquisitionSocialLoginOpeningFence,
    sessionId: string): Promise<boolean>;
  restoreLoginSessionCancellation(fence: AcquisitionSocialLoginOpeningFence,
    sessionId: string, restoredAt: string): Promise<boolean>;
  claimReplay(input: AcquisitionSocialAccountReplayReservationInput): Promise<AcquisitionSocialAccountReplayClaim>;
  completeReplay(fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion): Promise<void>;
  completeExistingLoginSessionAndReplay(workspaceId: string, sessionId: string,
    checkedAt: string, fence: AcquisitionSocialAccountReplayFence,
    completion: AcquisitionSocialAccountReplayCompletion): Promise<boolean>;
  releaseReplay(fence: AcquisitionSocialAccountReplayFence): Promise<void>;
  saveLoginSessionAndCompleteReplay(record: AcquisitionSocialLoginSessionPrivateRecord, fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion, opening: AcquisitionSocialLoginOpeningFence): Promise<void>;
  disconnectAndCompleteReplay(workspaceId: string, id: string, etag: string, updatedAt: string, fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion): Promise<AcquisitionSocialAccountPrivateRecord | null>;
}

function cloneRecord(record: AcquisitionSocialAccountPrivateRecord) {
  const raw = record as Partial<AcquisitionSocialAccountPrivateRecord>;
  return Object.freeze({ executorMode: null, executorDeviceIdHash: null,
    executorBindingGeneration: 0, executorLeaseExpiresAt: null, ...raw }) as
    AcquisitionSocialAccountPrivateRecord;
}

function executorForLockedActiveBind(current: AcquisitionSocialAccountPrivateRecord | null,
  candidate: AcquisitionSocialAccountPrivateRecord) {
  const latest = current ?? candidate;
  const executorBindingGenerationHighWater = Math.max(latest.executorBindingGenerationHighWater ?? 0, latest.executorBindingGeneration);
  if (latest.executorMode !== "desktop") return {
    executorBindingGenerationHighWater,
    executorMode: latest.executorMode,
    executorDeviceIdHash: null,
    executorBindingGeneration: 0,
    executorLeaseExpiresAt: null
  };
  return {
    executorBindingGenerationHighWater,
    executorMode: "desktop" as const,
    executorDeviceIdHash: latest.executorDeviceIdHash,
    executorBindingGeneration: latest.executorBindingGeneration
      + (current && current.loginStateVersion !== candidate.loginStateVersion ? 1 : 0),
    executorLeaseExpiresAt: latest.executorLeaseExpiresAt
  };
}

const privateRecordKeys = new Set([
  "id", "workspaceId", "platform", "accountHandle", "upstreamSessionId", "displayName", "state",
  "loginStateVersion", "loginStateVersionHighWater", "executorMode", "executorDeviceIdHash",
  "executorBindingGeneration", "executorBindingGenerationHighWater", "executorLeaseExpiresAt", "revision", "etag", "lastValidatedAt",
  "createdAt", "updatedAt"
]);

export function assertValidAcquisitionSocialAccountPrivateRecord(record: AcquisitionSocialAccountPrivateRecord) {
  if (record.executorBindingGenerationHighWater !== undefined && (!Number.isSafeInteger(record.executorBindingGenerationHighWater) || record.executorBindingGenerationHighWater < 0)) throw new TypeError("social_account_binding_high_water_invalid");
  if (Object.keys(record).some((key) => !privateRecordKeys.has(key))) {
    throw new TypeError("social_account_private_field_forbidden");
  }
  if (!Number.isSafeInteger(record.loginStateVersionHighWater)
    || record.loginStateVersionHighWater < 0
    || (record.loginStateVersion !== null
      && record.loginStateVersionHighWater < record.loginStateVersion)) {
    throw new TypeError("social_account_login_version_high_water_invalid");
  }
  const raw = record as unknown as Record<string, unknown>;
  const executorKeys = ["executorMode", "executorDeviceIdHash",
    "executorBindingGeneration", "executorLeaseExpiresAt"];
  const legacyCompleteAbsence = executorKeys.every((key) => !(key in raw));
  const unbound = (record.executorMode === null || record.executorMode === "server")
    && record.executorDeviceIdHash === null
    && record.executorBindingGeneration === 0
    && record.executorLeaseExpiresAt === null;
  const desktop = record.executorMode === "desktop"
    && typeof record.executorDeviceIdHash === "string"
    && /^sha256:[0-9a-f]{64}$/u.test(record.executorDeviceIdHash)
    && Number.isSafeInteger(record.executorBindingGeneration)
    && record.executorBindingGeneration > 0
    && typeof record.executorLeaseExpiresAt === "string"
    && Number.isFinite(Date.parse(record.executorLeaseExpiresAt));
  if (!legacyCompleteAbsence && !unbound && !desktop) {
    throw new TypeError("social_account_executor_binding_invalid");
  }
}

export function hasValidBoundActiveIdentity(record: AcquisitionSocialAccountPrivateRecord) {
  return record.state === "active"
    && typeof record.accountHandle === "string"
    && /^dyacct_[0-9a-f]{64}$/u.test(record.accountHandle)
    && typeof record.displayName === "string"
    && record.displayName.trim().length > 0
    && Number.isSafeInteger(record.loginStateVersion)
    && (record.loginStateVersion ?? 0) > 0;
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

interface MemoryLoginOpeningRecord {
  workspaceId: string;
  sessionId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  updatedAt: string;
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
  private readonly loginOpenings = new Map<string, MemoryLoginOpeningRecord>();
  private readonly replays = new Map<string, MemoryReplayRecord>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly memoryTransactions = new AcquisitionMemoryTransactionCoordinator()
  ) {}

  private transaction<T>(work: () => T | Promise<T>) {
    const current = this.memoryTransactions.transaction(() => work());
    this.tail = current.then(() => undefined, () => undefined);
    return current;
  }

  private accountKey(workspaceId: string, platform: "douyin") { return `${workspaceId}\u0000${platform}`; }

  async findByWorkspaceAndPlatform(workspaceId: string, platform: "douyin") {
    await this.tail;
    return this.records.get(this.accountKey(workspaceId, platform)) ?? null;
  }

  async findById(workspaceId: string, id: string) {
    await this.tail;
    return [...this.records.values()].find((record) => record.workspaceId === workspaceId && record.id === id) ?? null;
  }

  getDesktopExecutorBindingRecord(token: AcquisitionMemoryTransactionToken,
    workspaceId: string, id: string) {
    this.memoryTransactions.assertOwns(token);
    const record = [...this.records.values()].find((candidate) =>
      candidate.workspaceId === workspaceId && candidate.id === id);
    return record ? cloneRecord(record) : null;
  }

  getDesktopExecutorBindingByDevice(token: AcquisitionMemoryTransactionToken,
    workspaceId: string, deviceIdHash: string) {
    this.memoryTransactions.assertOwns(token);
    const record = [...this.records.values()].find((candidate) =>
      candidate.workspaceId === workspaceId
      && candidate.executorMode === "desktop"
      && candidate.executorDeviceIdHash === deviceIdHash);
    return record ? cloneRecord(record) : null;
  }

  setDesktopExecutorBindingRecord(token: AcquisitionMemoryTransactionToken,
    record: AcquisitionSocialAccountPrivateRecord) {
    this.memoryTransactions.assertOwns(token);
    assertValidAcquisitionSocialAccountPrivateRecord(record);
    const saved = cloneRecord(record);
    this.records.set(this.accountKey(saved.workspaceId, saved.platform), saved);
    return saved;
  }

  getDouyinAutomationAuthorityAccount(
    token: AcquisitionMemoryTransactionToken,
    workspaceId: string,
    platform: "douyin"
  ) {
    this.memoryTransactions.assertOwns(token);
    return this.records.get(this.accountKey(workspaceId, platform)) ?? null;
  }

  async upsert(record: AcquisitionSocialAccountPrivateRecord) {
    assertValidAcquisitionSocialAccountPrivateRecord(record);
    const saved = cloneRecord(record);
    return this.transaction(() => {
      const current = this.records.get(this.accountKey(saved.workspaceId, saved.platform));
      if (current) return current;
      this.records.set(this.accountKey(saved.workspaceId, saved.platform), saved);
      return saved;
    });
  }

  async bindActive(record: AcquisitionSocialAccountPrivateRecord) {
    assertValidAcquisitionSocialAccountPrivateRecord(record);
    const candidate = cloneRecord(record);
    return this.transaction(() => {
      const current = this.records.get(this.accountKey(candidate.workspaceId, candidate.platform));
      if (current && hasValidBoundActiveIdentity(current)
        && current.accountHandle !== candidate.accountHandle) return "active_handle_conflict" as const;
      if (current && (candidate.loginStateVersion ?? 0)
        <= current.loginStateVersionHighWater) return current;
      const revision = current ? current.revision + 1 : 1;
      const saved = cloneRecord({ ...candidate,
        ...executorForLockedActiveBind(current ?? null, candidate),
        id: current?.id ?? candidate.id,
        createdAt: current?.createdAt ?? candidate.createdAt,
        loginStateVersionHighWater: Math.max(current?.loginStateVersionHighWater ?? 0,
          candidate.loginStateVersionHighWater, candidate.loginStateVersion ?? 0),
        revision, etag: `"account-v${revision}"`
      });
      this.records.set(this.accountKey(saved.workspaceId, saved.platform), saved);
      return saved;
    });
  }

  async bindActiveFromLoginSession(workspaceId: string, sessionId: string, upstreamId: string,
    record: AcquisitionSocialAccountPrivateRecord) {
    assertValidAcquisitionSocialAccountPrivateRecord(record);
    const candidate = cloneRecord(record);
    return this.transaction(() => {
      const session = this.sessions.get(`${workspaceId}\u0000${sessionId}`);
      const opening = this.loginOpenings.get(workspaceId);
      if (!session || session.upstreamId !== upstreamId
        || opening && opening.sessionId !== sessionId) return "login_session_stale" as const;
      const current = this.records.get(this.accountKey(candidate.workspaceId, candidate.platform));
      if (current && hasValidBoundActiveIdentity(current)
        && current.accountHandle !== candidate.accountHandle) return "active_handle_conflict" as const;
      if (current && (candidate.loginStateVersion ?? 0) <= current.loginStateVersionHighWater) return current;
      const revision = current ? current.revision + 1 : 1;
      const saved = cloneRecord({ ...candidate,
        ...executorForLockedActiveBind(current ?? null, candidate),
        id: current?.id ?? candidate.id,
        createdAt: current?.createdAt ?? candidate.createdAt,
        loginStateVersionHighWater: Math.max(current?.loginStateVersionHighWater ?? 0,
          candidate.loginStateVersionHighWater, candidate.loginStateVersion ?? 0),
        revision, etag: `"account-v${revision}"` });
      this.records.set(this.accountKey(saved.workspaceId, saved.platform), saved);
      return saved;
    });
  }

  restoreLoginSessionAndOpening(record: AcquisitionSocialLoginSessionPrivateRecord,
    restoredAt: string) {
    return this.transaction(() => {
      if (this.loginOpenings.has(record.workspaceId)) return false;
      this.sessions.set(`${record.workspaceId}\u0000${record.id}`, Object.freeze({ ...record }));
      this.loginOpenings.set(record.workspaceId, { workspaceId: record.workspaceId,
        sessionId: record.id, leaseOwner: null, leaseExpiresAt: null,
        fencingToken: 1, updatedAt: restoredAt });
      return true;
    });
  }

  beginLoginSessionCancellation(workspaceId: string, sessionId: string, leaseOwner: string,
    leaseExpiresAt: string, updatedAt: string) {
    return this.transaction(() => {
      const opening = this.loginOpenings.get(workspaceId);
      if (!this.sessions.has(`${workspaceId}\u0000${sessionId}`)
        || opening && opening.sessionId !== sessionId) return "login_session_stale" as const;
      if (!opening) {
        this.loginOpenings.set(workspaceId, { workspaceId, sessionId: null, leaseOwner,
          leaseExpiresAt, fencingToken: 1, updatedAt });
        return { workspaceId, leaseOwner, fencingToken: 1 };
      }
      opening.sessionId = null; opening.leaseOwner = leaseOwner;
      opening.leaseExpiresAt = leaseExpiresAt; opening.fencingToken += 1; opening.updatedAt = updatedAt;
      return { workspaceId, leaseOwner, fencingToken: opening.fencingToken };
    });
  }

  completeLoginSessionCancellation(fence: AcquisitionSocialLoginOpeningFence, sessionId: string) {
    return this.transaction(() => {
      const opening = this.loginOpenings.get(fence.workspaceId);
      if (!opening || opening.sessionId !== null || opening.leaseOwner !== fence.leaseOwner
        || opening.fencingToken !== fence.fencingToken) return false;
      this.loginOpenings.delete(fence.workspaceId);
      return this.sessions.delete(`${fence.workspaceId}\u0000${sessionId}`);
    });
  }

  restoreLoginSessionCancellation(fence: AcquisitionSocialLoginOpeningFence,
    sessionId: string, restoredAt: string) {
    return this.transaction(() => {
      const opening = this.loginOpenings.get(fence.workspaceId);
      if (!opening || opening.sessionId !== null || opening.leaseOwner !== fence.leaseOwner
        || opening.fencingToken !== fence.fencingToken
        || !this.sessions.has(`${fence.workspaceId}\u0000${sessionId}`)) return false;
      opening.sessionId = sessionId; opening.leaseOwner = null; opening.leaseExpiresAt = null;
      opening.updatedAt = restoredAt; return true;
    });
  }

  pauseActiveAccount(workspaceId: string, id: string,
    identity: AcquisitionSocialAccountIdentityFence, updatedAt: string) {
    return this.transaction(() => {
      const existing = [...this.records.values()].find((record) =>
        record.workspaceId === workspaceId && record.id === id);
      if (!existing || existing.state !== "active"
        || existing.accountHandle !== identity.accountHandle
        || existing.loginStateVersion !== identity.loginStateVersion
        || existing.revision !== identity.revision
        || existing.etag !== identity.etag) return null;
      const revision = existing.revision + 1;
      const saved = cloneRecord({ ...existing, state: "risk_paused" as const,
        revision, etag: `"account-v${revision}"`, updatedAt });
      this.records.set(this.accountKey(saved.workspaceId, saved.platform), saved);
      return saved;
    });
  }

  private disconnected(existing: AcquisitionSocialAccountPrivateRecord, updatedAt: string) {
    return cloneRecord({ ...existing, state: "disconnected" as AcquisitionSocialAccountState, accountHandle: null, upstreamSessionId: null, loginStateVersion: null,
      executorBindingGenerationHighWater: Math.max(existing.executorBindingGenerationHighWater ?? 0, existing.executorBindingGeneration),
      executorMode: null, executorDeviceIdHash: null, executorBindingGeneration: 0,
      executorLeaseExpiresAt: null,
      revision: existing.revision + 1, etag: `\"account-v${existing.revision + 1}\"`, updatedAt });
  }

  disconnect(workspaceId: string, id: string, etag: string, updatedAt: string) {
    return this.transaction(() => {
      const existing = [...this.records.values()].find((record) => record.workspaceId === workspaceId && record.id === id);
      if (!existing || existing.etag !== etag) return null;
      const saved = this.disconnected(existing, updatedAt);
      this.records.set(this.accountKey(saved.workspaceId, saved.platform), saved);
      return saved;
    });
  }

  async saveLoginSession(record: AcquisitionSocialLoginSessionPrivateRecord) {
    this.sessions.set(`${record.workspaceId}\u0000${record.id}`, Object.freeze({ ...record }));
  }

  async findLoginSession(workspaceId: string, id: string) {
    return this.sessions.get(`${workspaceId}\u0000${id}`) ?? null;
  }

  async deleteExpiredLoginSessions(now: string) {
    await this.transaction(() => {
      for (const [key, session] of this.sessions) {
        if (session.expiresAt > now) continue;
        this.sessions.delete(key);
        const opening = this.loginOpenings.get(session.workspaceId);
        if (opening?.sessionId === session.id) this.loginOpenings.delete(session.workspaceId);
      }
    });
  }

  claimLoginOpening(input: AcquisitionSocialLoginOpeningReservationInput): Promise<AcquisitionSocialLoginOpeningClaim> {
    return this.transaction(() => {
      const attemptedAt = instant(input.attemptedAt, "invalid_login_opening_attempted_at");
      if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
        throw new TypeError("invalid_login_opening_reservation");
      }
      const existing = this.loginOpenings.get(input.workspaceId);
      if (existing?.sessionId) {
        const session = this.sessions.get(`${input.workspaceId}\u0000${existing.sessionId}`);
        if (session && instant(session.expiresAt, "invalid_login_session_expiry") > attemptedAt) {
          return { kind: "existing" as const, session };
        }
      }
      const leaseExpiry = existing?.leaseExpiresAt
        ? instant(existing.leaseExpiresAt, "invalid_login_opening_lease_expiry")
        : 0;
      if (existing && !existing.sessionId && attemptedAt < leaseExpiry) {
        return { kind: "pending" as const, retryAfterMs: leaseExpiry - attemptedAt };
      }
      const fencingToken = (existing?.fencingToken ?? 0) + 1;
      const leaseExpiresAt = new Date(attemptedAt + input.leaseDurationMs).toISOString();
      this.loginOpenings.set(input.workspaceId, {
        workspaceId: input.workspaceId,
        sessionId: null,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt,
        fencingToken,
        updatedAt: input.attemptedAt
      });
      return {
        kind: "claimed" as const,
        workspaceId: input.workspaceId,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt,
        fencingToken
      };
    });
  }

  releaseLoginOpening(fence: AcquisitionSocialLoginOpeningFence) {
    return this.transaction(() => {
      const opening = this.loginOpenings.get(fence.workspaceId);
      if (!opening || opening.sessionId !== null || opening.leaseOwner !== fence.leaseOwner
        || opening.fencingToken !== fence.fencingToken) {
        throw new Error("stale_social_login_opening_fence");
      }
      this.loginOpenings.delete(fence.workspaceId);
    });
  }

  discardLoginOpening(workspaceId: string, sessionId: string) {
    return this.transaction(() => {
      const opening = this.loginOpenings.get(workspaceId);
      if (opening?.sessionId === sessionId) this.loginOpenings.delete(workspaceId);
    });
  }

  removeLoginSessionAndOpening(workspaceId: string, sessionId: string) {
    return this.transaction(() => {
      const opening = this.loginOpenings.get(workspaceId);
      if (opening?.sessionId === sessionId) this.loginOpenings.delete(workspaceId);
      return this.sessions.delete(`${workspaceId}\u0000${sessionId}`);
    });
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

  completeExistingLoginSessionAndReplay(workspaceId: string, sessionId: string,
    checkedAt: string, fence: AcquisitionSocialAccountReplayFence,
    completion: AcquisitionSocialAccountReplayCompletion) {
    return this.transaction(() => {
      const pending = this.pending(fence);
      if (pending.requestHash !== completion.requestHash) {
        throw new Error("replay_request_hash_mismatch");
      }
      const opening = this.loginOpenings.get(workspaceId);
      const session = this.sessions.get(`${workspaceId}\u0000${sessionId}`);
      if (opening?.sessionId !== sessionId || !session
        || instant(session.expiresAt, "invalid_login_session_expiry")
          <= instant(checkedAt, "invalid_login_session_checked_at")) {
        return false;
      }
      this.complete(pending, completion);
      return true;
    });
  }

  async releaseReplay(fence: AcquisitionSocialAccountReplayFence) {
    this.pending(fence);
    this.replays.delete(replayKey(fence.workspaceId, fence.operation, fence.key));
  }

  saveLoginSessionAndCompleteReplay(record: AcquisitionSocialLoginSessionPrivateRecord, fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion, openingFence: AcquisitionSocialLoginOpeningFence) {
    return this.transaction(() => {
      const pending = this.pending(fence);
      if (pending.requestHash !== completion.requestHash) throw new Error("replay_request_hash_mismatch");
      const opening = this.loginOpenings.get(openingFence.workspaceId);
      if (!opening || opening.sessionId !== null
        || opening.leaseOwner !== openingFence.leaseOwner
        || opening.fencingToken !== openingFence.fencingToken
        || record.workspaceId !== openingFence.workspaceId) {
        throw new Error("stale_social_login_opening_fence");
      }
      this.sessions.set(`${record.workspaceId}\u0000${record.id}`, Object.freeze({ ...record }));
      opening.sessionId = record.id;
      opening.leaseOwner = null;
      opening.leaseExpiresAt = null;
      opening.updatedAt = completion.completedAt;
      this.complete(pending, completion);
    });
  }

  disconnectAndCompleteReplay(workspaceId: string, id: string, etag: string, updatedAt: string, fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion) {
    return this.transaction(() => {
      const pending = this.pending(fence);
      if (pending.requestHash !== completion.requestHash) throw new Error("replay_request_hash_mismatch");
      const existing = [...this.records.values()].find((record) => record.workspaceId === workspaceId && record.id === id);
      if (!existing || existing.etag !== etag) return null;
      const saved = this.disconnected(existing, updatedAt);
      this.records.set(this.accountKey(saved.workspaceId, saved.platform), saved);
      this.complete(pending, completion);
      return saved;
    });
  }
}
