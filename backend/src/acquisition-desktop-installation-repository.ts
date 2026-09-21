import { createHash } from "node:crypto";

import { desktopSecretHashEqual,
  type DesktopInstallationState } from "./acquisition-desktop-installation.js";
import { AcquisitionMemoryTransactionCoordinator,
  type AcquisitionMemoryTransactionToken } from "./acquisition-memory-transaction-coordinator.js";
import type { AcquisitionSocialAccountDesktopBindingView, AcquisitionSocialAccountDesktopBindingStatus } from
  "./acquisition-social-account.js";
import type { AcquisitionSocialAccountPrivateRecord,
  InMemoryAcquisitionSocialAccountRepository } from
  "./acquisition-social-account-repository.js";
import type { InMemoryAcquisitionOutreachBatchRepository } from
  "./acquisition-outreach-batch-repository.js";

export interface DesktopEnrollmentRecord {
  workspaceId: string;
  userId: string;
  teamId: string;
  deviceIdHash: string;
  protocolVersion: 1;
  enrollmentTokenHash: string;
  idempotencyKeyHash: string;
  requestHash: string;
  expiresAt: string;
  createdAt: string;
  consumedAt: string | null;
  registrationIdempotencyKeyHash?: string | null;
  registrationRequestHash?: string | null;
}

export interface DesktopInstallationRecord {
  workspaceId: string;
  userId: string;
  teamId: string;
  deviceIdHash: string;
  deviceCredentialHash: string;
  protocolVersion: 1;
  state: DesktopInstallationState;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface ConsumeDesktopEnrollmentInput {
  deviceIdHash: string;
  enrollmentTokenHash: string;
  deviceCredentialHash: string;
  protocolVersion: 1;
  consumedAt: string;
  registrationIdempotencyKeyHash?: string;
  registrationRequestHash?: string;
}

export type ConsumeDesktopEnrollmentResult = {
  kind: "created" | "replay";
  installation: DesktopInstallationRecord;
} | { kind: "conflict" };

export interface AuthenticateDesktopInstallationInput {
  workspaceId: string;
  deviceIdHash: string;
  deviceCredentialHash: string;
  protocolVersion: 1;
}

export interface DesktopInstallationRepository {
  createEnrollment(input: DesktopEnrollmentRecord):
    Promise<"created" | "replayed" | "conflict">;
  findEnrollmentReplay(workspaceId: string, idempotencyKeyHash: string):
    Promise<DesktopEnrollmentRecord | null>;
  consumeEnrollment(input: ConsumeDesktopEnrollmentInput):
    Promise<ConsumeDesktopEnrollmentResult>;
  authenticate(input: AuthenticateDesktopInstallationInput):
    Promise<DesktopInstallationRecord | null>;
  authenticateDevice(input: Omit<AuthenticateDesktopInstallationInput, "workspaceId">):
    Promise<DesktopInstallationRecord | null>;
  revoke(workspaceId: string, deviceIdHash: string, revokedAt: string): Promise<boolean>;
  bindDesktopExecutor(input: BindDesktopExecutorRepositoryInput):
    Promise<BindDesktopExecutorRepositoryResult>;
  renewDesktopExecutors(input: RenewDesktopExecutorsRepositoryInput):
    Promise<readonly AcquisitionSocialAccountDesktopBindingView[]>;
  getDesktopBindingStatus(input: DesktopBindingStatusRepositoryInput):
    Promise<AcquisitionSocialAccountDesktopBindingStatus | null>;
}

export interface DesktopBindingStatusRepositoryInput {
  workspaceId: string;
  userId: string;
  teamId: string;
  accountId: string;
  deviceIdHash: string;
}

export interface BindDesktopExecutorRepositoryInput {
  workspaceId: string;
  userId: string;
  teamId: string;
  accountId: string;
  accountHandle: string;
  loginStateVersion: number;
  deviceIdHash: string;
  expectedGeneration: number;
  handoff: boolean;
  idempotencyKeyHash: string;
  requestHash: string;
  boundAt: string;
  leaseExpiresAt: string;
}

export type BindDesktopExecutorRepositoryResult =
  | { kind: "bound" | "replay"; account: AcquisitionSocialAccountPrivateRecord }
  | { kind: "not_found" | "installation_invalid" | "identity_mismatch"
      | "generation_stale" | "handoff_required" | "handoff_blocked" | "conflict" };

export interface RenewDesktopExecutorsRepositoryInput {
  principal: { workspaceId: string; userId: string; teamId: string;
    deviceIdHash: string; protocolVersion: 1 };
  bindings: readonly { accountId: string; accountHandle: string;
    loginStateVersion: number; bindingGeneration: number }[];
  renewedAt: string;
  leaseExpiresAt: string;
}

export function desktopEnrollmentIdempotencyKeyHash(key: string) {
  return createHash("sha256").update(
    `shensi-desktop-enrollment-idempotency\0${key}`, "utf8").digest("hex");
}

export function desktopExecutorBindingIdempotencyKeyHash(key: string) {
  return createHash("sha256").update(
    `shensi-desktop-executor-binding-idempotency\0${key}`, "utf8").digest("hex");
}

export function desktopRegistrationIdempotencyKeyHash(key: string) {
  return createHash("sha256").update(
    `shensi-desktop-registration-idempotency\0${key}`, "utf8").digest("hex");
}

function copy<T>(value: T): T { return structuredClone(value); }
function replayKey(record: Pick<DesktopEnrollmentRecord,
  "workspaceId" | "idempotencyKeyHash">) {
  return `${record.workspaceId}\0${record.idempotencyKeyHash}`;
}
function installationKey(workspaceId: string, deviceIdHash: string) {
  return `${workspaceId}\0${deviceIdHash}`;
}

export class InMemoryDesktopInstallationRepository
implements DesktopInstallationRepository {
  private readonly enrollments = new Map<string, DesktopEnrollmentRecord>();
  private readonly installations = new Map<string, DesktopInstallationRecord>();
  private tail: Promise<void> = Promise.resolve();
  private installationInsertCount = 0;
  private bindingWriteCount = 0;
  private readonly bindingReplays = new Map<string, { requestHash: string;
    account: AcquisitionSocialAccountPrivateRecord }>();
  readonly memoryTransactions: AcquisitionMemoryTransactionCoordinator;

  constructor(private readonly testing: { failInstallationInsertAt?: number;
    failBindingWriteAt?: number;
    memoryTransactions?: AcquisitionMemoryTransactionCoordinator;
    socialAccounts?: InMemoryAcquisitionSocialAccountRepository;
    outreachActions?: InMemoryAcquisitionOutreachBatchRepository } = {}) {
    this.memoryTransactions = testing.memoryTransactions
      ?? new AcquisitionMemoryTransactionCoordinator();
  }

  hasDesktopAuthorityBundle(socialAccounts: InMemoryAcquisitionSocialAccountRepository,
    outreachActions: InMemoryAcquisitionOutreachBatchRepository): boolean {
    return this.testing.socialAccounts === socialAccounts
      && this.testing.outreachActions === outreachActions
      && socialAccounts.memoryTransactions === this.memoryTransactions
      && outreachActions.memoryTransactions === this.memoryTransactions;
  }

  private transaction<T>(work: (token: AcquisitionMemoryTransactionToken) => T | Promise<T>) {
    const execute = () => this.memoryTransactions.transaction(work);
    const result = this.tail.then(execute, execute);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  createEnrollment(input: DesktopEnrollmentRecord) {
    return this.transaction<"created" | "replayed" | "conflict">(() => {
      const key = replayKey(input);
      const current = this.enrollments.get(key);
      if (current) return current.requestHash === input.requestHash ? "replayed" : "conflict";
      this.enrollments.set(key, copy(input));
      return "created";
    });
  }

  async findEnrollmentReplay(workspaceId: string, idempotencyKeyHash: string) {
    await this.tail;
    const record = this.enrollments.get(replayKey({ workspaceId, idempotencyKeyHash }));
    return record ? copy(record) : null;
  }

  consumeEnrollment(input: ConsumeDesktopEnrollmentInput) {
    return this.transaction<ConsumeDesktopEnrollmentResult>(() => {
      const candidates = [...this.enrollments.values()]
        .filter((record) => record.deviceIdHash === input.deviceIdHash);
      const enrollment = candidates.find((record) =>
        desktopSecretHashEqual(record.enrollmentTokenHash, input.enrollmentTokenHash));
      if (!enrollment || enrollment.protocolVersion !== input.protocolVersion) {
        throw new Error("desktop_enrollment_invalid");
      }
      if (enrollment.consumedAt) {
        if (typeof enrollment.registrationIdempotencyKeyHash === "string"
          && typeof enrollment.registrationRequestHash === "string"
          && typeof input.registrationIdempotencyKeyHash === "string"
          && typeof input.registrationRequestHash === "string"
          && enrollment.registrationIdempotencyKeyHash === input.registrationIdempotencyKeyHash
          && enrollment.registrationRequestHash === input.registrationRequestHash) {
          const existing = this.installations.get(installationKey(enrollment.workspaceId,
            enrollment.deviceIdHash));
          if (existing?.state === "active" && desktopSecretHashEqual(
            existing.deviceCredentialHash, input.deviceCredentialHash)) {
            return { kind: "replay", installation: copy(existing) };
          }
        }
        return { kind: "conflict" };
      }
      if (Date.parse(input.consumedAt) >= Date.parse(enrollment.expiresAt)) {
        throw new Error("desktop_enrollment_expired");
      }
      const key = installationKey(enrollment.workspaceId, enrollment.deviceIdHash);
      const existing = this.installations.get(key);
      const record: DesktopInstallationRecord = Object.freeze({
        workspaceId: enrollment.workspaceId, userId: enrollment.userId,
        teamId: enrollment.teamId, deviceIdHash: enrollment.deviceIdHash,
        deviceCredentialHash: input.deviceCredentialHash,
        protocolVersion: 1, state: "active", createdAt: existing?.createdAt ?? input.consumedAt,
        updatedAt: input.consumedAt, revokedAt: null
      });
      this.installationInsertCount += 1;
      if (this.testing.failInstallationInsertAt === this.installationInsertCount) {
        throw new Error("desktop_installation_insert_failed");
      }
      enrollment.consumedAt = input.consumedAt;
      enrollment.registrationIdempotencyKeyHash = input.registrationIdempotencyKeyHash ?? null;
      enrollment.registrationRequestHash = input.registrationRequestHash ?? null;
      this.installations.set(key, record);
      return { kind: "created", installation: copy(record) };
    });
  }

  async authenticate(input: AuthenticateDesktopInstallationInput) {
    await this.tail;
    const record = this.installations.get(installationKey(input.workspaceId,
      input.deviceIdHash));
    return record?.state === "active" && record.protocolVersion === input.protocolVersion
      && desktopSecretHashEqual(record.deviceCredentialHash, input.deviceCredentialHash)
      ? copy(record) : null;
  }

  async authenticateDevice(input: Omit<AuthenticateDesktopInstallationInput, "workspaceId">) {
    await this.tail;
    const matches = [...this.installations.values()].filter((record) =>
      record.state === "active" && record.deviceIdHash === input.deviceIdHash
      && record.protocolVersion === input.protocolVersion
      && desktopSecretHashEqual(record.deviceCredentialHash, input.deviceCredentialHash));
    return matches.length === 1 ? copy(matches[0]) : null;
  }

  getActiveInstallationRecord(token: AcquisitionMemoryTransactionToken,
    workspaceId: string, deviceIdHash: string) {
    this.memoryTransactions.assertOwns(token);
    const record = this.installations.get(installationKey(workspaceId, deviceIdHash));
    return record?.state === "active" ? copy(record) : null;
  }

  revoke(workspaceId: string, deviceIdHash: string, revokedAt: string) {
    return this.transaction((token) => {
      const key = installationKey(workspaceId, deviceIdHash);
      const record = this.installations.get(key);
      if (!record || record.state !== "active") return false;
      this.installations.set(key, { ...record, state: "revoked",
        updatedAt: revokedAt, revokedAt });
      const social = this.testing.socialAccounts;
      if (social) {
        const account = social.getDesktopExecutorBindingByDevice(token,
          workspaceId, deviceIdHash);
        if (account) social.setDesktopExecutorBindingRecord(token, {
          ...account, executorMode: "desktop", executorDeviceIdHash: deviceIdHash,
          executorBindingGeneration: account.executorBindingGeneration + 1,
          executorLeaseExpiresAt: revokedAt,
          revision: account.revision + 1,
          etag: `"account-v${account.revision + 1}"`, updatedAt: revokedAt
        });
      }
      return true;
    });
  }

  getDesktopBindingStatus(input: DesktopBindingStatusRepositoryInput) {
    return this.transaction<AcquisitionSocialAccountDesktopBindingStatus | null>((token) => {
      const social = this.testing.socialAccounts;
      const actions = this.testing.outreachActions;
      if (!social || !actions || social.memoryTransactions !== this.memoryTransactions
        || actions.memoryTransactions !== this.memoryTransactions) {
        throw new Error("acquisition_memory_transaction_boundary_required");
      }
      const installation = this.installations.get(installationKey(input.workspaceId, input.deviceIdHash));
      if (!installation || installation.state !== "active"
        || installation.userId !== input.userId || installation.teamId !== input.teamId) return null;
      const account = social.getDesktopExecutorBindingRecord(token, input.workspaceId, input.accountId);
      if (!account) return null;
      return { accountId: account.id, executorMode: account.executorMode,
        bindingGeneration: account.executorBindingGeneration,
        leaseExpiresAt: account.executorLeaseExpiresAt,
        ownedByInstallation: account.executorMode === "desktop" && account.executorDeviceIdHash === input.deviceIdHash,
        hasUnresolvedActions: actions.hasUnresolvedAccountActions(token, input.workspaceId, input.accountId) };
    });
  }

  bindDesktopExecutor(input: BindDesktopExecutorRepositoryInput) {
    return this.transaction<BindDesktopExecutorRepositoryResult>((token) => {
      const social = this.testing.socialAccounts;
      const actions = this.testing.outreachActions;
      if (!social || !actions
        || social.memoryTransactions !== this.memoryTransactions
        || actions.memoryTransactions !== this.memoryTransactions) {
        throw new Error("acquisition_memory_transaction_boundary_required");
      }
      const replayKey = `${input.workspaceId}\0bind_desktop_executor\0${input.idempotencyKeyHash}`;
      const replay = this.bindingReplays.get(replayKey);
      if (replay) return replay.requestHash === input.requestHash
        ? { kind: "replay" as const, account: copy(replay.account) }
        : { kind: "conflict" as const };
      const installation = this.installations.get(installationKey(input.workspaceId,
        input.deviceIdHash));
      if (!installation || installation.state !== "active"
        || installation.userId !== input.userId || installation.teamId !== input.teamId) {
        return { kind: "installation_invalid" as const };
      }
      const account = social.getDesktopExecutorBindingRecord(token,
        input.workspaceId, input.accountId);
      if (!account) return { kind: "not_found" as const };
      if (account.state !== "active" || account.accountHandle !== input.accountHandle
        || account.loginStateVersion !== input.loginStateVersion) {
        return { kind: "identity_mismatch" as const };
      }
      if (account.executorBindingGeneration !== input.expectedGeneration) {
        return { kind: "generation_stale" as const };
      }
      const sameDevice = account.executorMode === "desktop"
        && account.executorDeviceIdHash === input.deviceIdHash;
      if (account.executorMode === "desktop" && !sameDevice && !input.handoff) {
        return { kind: "handoff_required" as const };
      }
      if (account.executorMode === "desktop" && !sameDevice
        && actions.hasUnresolvedAccountActions(token, input.workspaceId, input.accountId)) {
        return { kind: "handoff_blocked" as const };
      }
      const generation = sameDevice ? account.executorBindingGeneration
        : Math.max(account.executorBindingGeneration, account.executorBindingGenerationHighWater ?? 0) + 1;
      const revision = account.revision + 1;
      const saved = social.setDesktopExecutorBindingRecord(token, {
        ...account, executorMode: "desktop", executorDeviceIdHash: input.deviceIdHash,
        executorBindingGeneration: generation,
        executorBindingGenerationHighWater: Math.max(generation, account.executorBindingGenerationHighWater ?? 0),
        executorLeaseExpiresAt: input.leaseExpiresAt, revision,
        etag: `"account-v${revision}"`, updatedAt: input.boundAt
      });
      try {
        this.bindingWriteCount += 1;
        if (this.testing.failBindingWriteAt === this.bindingWriteCount) {
          throw new Error("desktop_executor_binding_write_failed");
        }
        this.bindingReplays.set(replayKey, { requestHash: input.requestHash,
          account: copy(saved) });
      } catch (error) {
        social.setDesktopExecutorBindingRecord(token, account);
        this.bindingReplays.delete(replayKey);
        throw error;
      }
      return { kind: "bound", account: copy(saved) };
    });
  }

  renewDesktopExecutors(input: RenewDesktopExecutorsRepositoryInput) {
    return this.transaction<readonly AcquisitionSocialAccountDesktopBindingView[]>((token) => {
      const social = this.testing.socialAccounts;
      if (!social || social.memoryTransactions !== this.memoryTransactions) {
        throw new Error("acquisition_memory_transaction_boundary_required");
      }
      const installation = this.installations.get(installationKey(
        input.principal.workspaceId, input.principal.deviceIdHash));
      if (!installation || installation.state !== "active"
        || installation.userId !== input.principal.userId
        || installation.teamId !== input.principal.teamId) {
        throw new Error("desktop_installation_invalid");
      }
      const records = input.bindings.map((binding) => {
        const account = social.getDesktopExecutorBindingRecord(token,
          input.principal.workspaceId, binding.accountId);
        if (!account || account.state !== "active"
          || account.accountHandle !== binding.accountHandle
          || account.loginStateVersion !== binding.loginStateVersion
          || account.executorMode !== "desktop"
          || account.executorDeviceIdHash !== input.principal.deviceIdHash
          || account.executorBindingGeneration !== binding.bindingGeneration
          || Date.parse(input.renewedAt) >= Date.parse(account.executorLeaseExpiresAt ?? "")) {
          throw new Error("desktop_executor_binding_stale");
        }
        return account;
      });
      return Object.freeze(records.map((account) => {
        social.setDesktopExecutorBindingRecord(token, { ...account,
          executorLeaseExpiresAt: input.leaseExpiresAt, updatedAt: input.renewedAt });
        return Object.freeze({ accountId: account.id, executorMode: "desktop" as const,
          bindingGeneration: account.executorBindingGeneration,
          leaseExpiresAt: input.leaseExpiresAt, ownedByInstallation: true as const });
      }));
    });
  }
}
