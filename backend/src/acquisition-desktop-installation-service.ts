import { createHmac } from "node:crypto";

import { DESKTOP_INSTALLATION_TOKEN, desktopDeviceCredentialHash,
  desktopEnrollmentTokenHash, desktopInstallationIdHash,
  type DesktopInstallationPrincipal } from "./acquisition-desktop-installation.js";
import { desktopEnrollmentIdempotencyKeyHash,
  desktopExecutorBindingIdempotencyKeyHash,
  desktopRegistrationIdempotencyKeyHash,
  type DesktopInstallationRepository } from
  "./acquisition-desktop-installation-repository.js";
import type { AcquisitionSocialAccountDesktopBindingView } from
  "./acquisition-social-account.js";

export class AcquisitionDesktopInstallationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "AcquisitionDesktopInstallationError"; }
}

interface Scope { workspaceId: string; userId: string; teamId: string; }

function fail(code: string): never { throw new AcquisitionDesktopInstallationError(code); }
function validScope(scope: Scope) {
  return [scope.workspaceId, scope.userId, scope.teamId].every((value) =>
    typeof value === "string" && value.length > 0 && value.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(value));
}

export class AcquisitionDesktopInstallationService {
  private readonly secret: Buffer;
  constructor(private readonly options: {
    repository: DesktopInstallationRepository;
    secret: string | Uint8Array;
    now(): string;
    isActiveMembership(scope: Scope): Promise<boolean>;
  }) {
    this.secret = Buffer.from(options.secret);
    if (this.secret.byteLength < 32) throw new TypeError("desktop_installation_secret_invalid");
  }

  private token(domain: string, material: string) {
    return createHmac("sha256", this.secret).update(`${domain}\0${material}`, "utf8")
      .digest("base64url");
  }

  async createEnrollment(scope: Scope,
    input: { installationId: string; protocolVersion: 1 },
    idempotencyKey: string, requestHash: string) {
    if (!validScope(scope) || !DESKTOP_INSTALLATION_TOKEN.test(input.installationId)
      || input.protocolVersion !== 1 || typeof idempotencyKey !== "string"
      || idempotencyKey.length < 8 || idempotencyKey.length > 200
      || !/^[a-f0-9]{64}$/u.test(requestHash)) fail("desktop_enrollment_invalid");
    let active;
    try { active = await this.options.isActiveMembership(scope); }
    catch { fail("desktop_enrollment_unavailable"); }
    if (!active) fail("desktop_membership_inactive");
    const createdAt = this.options.now();
    const at = Date.parse(createdAt);
    if (!Number.isFinite(at)) fail("desktop_enrollment_invalid");
    const deviceIdHash = desktopInstallationIdHash(input.installationId);
    const token = this.token("shensi-desktop-enrollment-token-derivation",
      `${scope.workspaceId}\0${scope.userId}\0${scope.teamId}\0${deviceIdHash}\0${idempotencyKey}\0${requestHash}`);
    const expiresAt = new Date(at + 60_000).toISOString();
    let result;
    try {
      result = await this.options.repository.createEnrollment({
        ...scope, deviceIdHash, protocolVersion: 1,
        enrollmentTokenHash: desktopEnrollmentTokenHash(token),
        idempotencyKeyHash: desktopEnrollmentIdempotencyKeyHash(idempotencyKey),
        requestHash, expiresAt, createdAt, consumedAt: null,
        registrationIdempotencyKeyHash: null, registrationRequestHash: null
      });
    } catch { fail("desktop_enrollment_unavailable"); }
    if (result === "conflict") fail("desktop_enrollment_idempotency_conflict");
    if (result === "replayed") {
      let replay;
      try {
        replay = await this.options.repository.findEnrollmentReplay(scope.workspaceId,
          desktopEnrollmentIdempotencyKeyHash(idempotencyKey));
      } catch { fail("desktop_enrollment_unavailable"); }
      if (!replay || replay.requestHash !== requestHash
        || !replay.enrollmentTokenHash
        || replay.enrollmentTokenHash !== desktopEnrollmentTokenHash(token)) {
        fail("desktop_enrollment_invalid");
      }
      return Object.freeze({ token, expiresAt: replay.expiresAt });
    }
    return Object.freeze({ token, expiresAt });
  }

  async register(input: { installationId: string; enrollmentToken: string;
    protocolVersion: 1 }, idempotencyKey: string, requestHash: string) {
    if (!DESKTOP_INSTALLATION_TOKEN.test(input.installationId)
      || !DESKTOP_INSTALLATION_TOKEN.test(input.enrollmentToken)
      || input.protocolVersion !== 1 || typeof idempotencyKey !== "string"
      || idempotencyKey.length < 8 || idempotencyKey.length > 200
      || !/^[a-f0-9]{64}$/u.test(requestHash)) fail("desktop_enrollment_invalid");
    const consumedAt = this.options.now();
    const deviceIdHash = desktopInstallationIdHash(input.installationId);
    const enrollmentTokenHash = desktopEnrollmentTokenHash(input.enrollmentToken);
    const deviceToken = this.token("shensi-desktop-device-credential-derivation",
      `${deviceIdHash}\0${enrollmentTokenHash}`);
    try {
      const record = await this.options.repository.consumeEnrollment({ deviceIdHash,
        enrollmentTokenHash, deviceCredentialHash: desktopDeviceCredentialHash(deviceToken),
        protocolVersion: 1, consumedAt,
        registrationIdempotencyKeyHash: desktopRegistrationIdempotencyKeyHash(idempotencyKey),
        registrationRequestHash: requestHash });
      if (record.kind === "conflict") fail("desktop_registration_idempotency_conflict");
      return Object.freeze({ deviceToken, workspaceId: record.installation.workspaceId,
        protocolVersion: record.installation.protocolVersion,
        replayed: record.kind === "replay" });
    } catch (error) {
      const code = (error as Error)?.message;
      if (["desktop_registration_idempotency_conflict", "desktop_enrollment_expired"].includes(code)) {
        fail(code);
      }
      fail("desktop_enrollment_invalid");
    }
  }

  async authenticate(input: { workspaceId: string; installationId: string;
    deviceToken: string; protocolVersion: 1 }): Promise<DesktopInstallationPrincipal | null> {
    if (!input.workspaceId || !DESKTOP_INSTALLATION_TOKEN.test(input.installationId)
      || !DESKTOP_INSTALLATION_TOKEN.test(input.deviceToken)
      || input.protocolVersion !== 1) return null;
    let record;
    try {
      record = await this.options.repository.authenticate({
        workspaceId: input.workspaceId,
        deviceIdHash: desktopInstallationIdHash(input.installationId),
        deviceCredentialHash: desktopDeviceCredentialHash(input.deviceToken),
        protocolVersion: 1
      });
    } catch { fail("desktop_installation_unavailable"); }
    if (!record) return null;
    let membershipActive;
    try { membershipActive = await this.options.isActiveMembership(record); }
    catch { fail("desktop_installation_unavailable"); }
    if (!membershipActive) return null;
    return Object.freeze({ workspaceId: record.workspaceId, userId: record.userId,
      teamId: record.teamId, deviceIdHash: record.deviceIdHash, protocolVersion: 1 });
  }

  async authenticateDevice(input: { installationId: string; deviceToken: string;
    protocolVersion: 1 }): Promise<DesktopInstallationPrincipal | null> {
    if (!DESKTOP_INSTALLATION_TOKEN.test(input.installationId)
      || !DESKTOP_INSTALLATION_TOKEN.test(input.deviceToken)
      || input.protocolVersion !== 1) return null;
    let record;
    try {
      record = await this.options.repository.authenticateDevice({
        deviceIdHash: desktopInstallationIdHash(input.installationId),
        deviceCredentialHash: desktopDeviceCredentialHash(input.deviceToken),
        protocolVersion: 1
      });
    } catch { fail("desktop_installation_unavailable"); }
    if (!record) return null;
    let membershipActive;
    try { membershipActive = await this.options.isActiveMembership(record); }
    catch { fail("desktop_installation_unavailable"); }
    if (!membershipActive) return null;
    return Object.freeze({ workspaceId: record.workspaceId, userId: record.userId,
      teamId: record.teamId, deviceIdHash: record.deviceIdHash, protocolVersion: 1 });
  }

  async revoke(scope: Scope, installationId: string) {
    if (!validScope(scope) || !DESKTOP_INSTALLATION_TOKEN.test(installationId)) {
      fail("desktop_installation_invalid");
    }
    try {
      return await this.options.repository.revoke(scope.workspaceId,
        desktopInstallationIdHash(installationId), this.options.now());
    } catch { fail("desktop_installation_unavailable"); }
  }

  async getDesktopBindingStatus(scope: Scope, accountId: string, installationId: string) {
    if (!validScope(scope) || typeof accountId !== "string" || !accountId
      || accountId.length > 255 || /[\u0000-\u001f\u007f]/u.test(accountId)
      || !DESKTOP_INSTALLATION_TOKEN.test(installationId)) fail("desktop_executor_binding_invalid");
    let result;
    try {
      if (!await this.options.isActiveMembership(scope)) fail("desktop_membership_inactive");
      result = await this.options.repository.getDesktopBindingStatus({ ...scope, accountId,
        deviceIdHash: desktopInstallationIdHash(installationId) });
    } catch (error) {
      if ((error as Error)?.message === "desktop_membership_inactive") throw error;
      fail("desktop_executor_binding_unavailable");
    }
    if (!result) fail("social_account_not_found");
    return Object.freeze(result);
  }

  async bindDesktopExecutor(scope: Scope, accountId: string, input: {
    accountHandle: string; loginStateVersion: number; installationId: string;
    expectedGeneration: number; handoff: boolean;
  }, idempotencyKey: string, requestHash: string):
    Promise<AcquisitionSocialAccountDesktopBindingView> {
    if (!validScope(scope) || typeof accountId !== "string" || !accountId
      || accountId.length > 255
      || !/^dyacct_[0-9a-f]{64}$/u.test(input.accountHandle)
      || !Number.isSafeInteger(input.loginStateVersion) || input.loginStateVersion < 1
      || !DESKTOP_INSTALLATION_TOKEN.test(input.installationId)
      || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0
      || typeof input.handoff !== "boolean"
      || typeof idempotencyKey !== "string" || idempotencyKey.length < 8
      || idempotencyKey.length > 200 || !/^[a-f0-9]{64}$/u.test(requestHash)) {
      fail("desktop_executor_binding_invalid");
    }
    const boundAt = this.options.now();
    const at = Date.parse(boundAt);
    if (!Number.isFinite(at)) fail("desktop_executor_binding_invalid");
    let result;
    try {
      result = await this.options.repository.bindDesktopExecutor({ ...scope, accountId,
        accountHandle: input.accountHandle, loginStateVersion: input.loginStateVersion,
        deviceIdHash: desktopInstallationIdHash(input.installationId),
        expectedGeneration: input.expectedGeneration, handoff: input.handoff,
        idempotencyKeyHash: desktopExecutorBindingIdempotencyKeyHash(idempotencyKey),
        requestHash, boundAt, leaseExpiresAt: new Date(at + 90_000).toISOString() });
    } catch { fail("desktop_executor_binding_unavailable"); }
    if (result.kind === "conflict") fail("idempotency_key_conflict");
    if (result.kind === "handoff_required") fail("desktop_executor_handoff_required");
    if (result.kind === "handoff_blocked") fail("desktop_executor_handoff_blocked");
    if (result.kind === "generation_stale") fail("desktop_executor_generation_stale");
    if (result.kind !== "bound" && result.kind !== "replay") {
      fail("social_account_not_found");
    }
    const account = result.account;
    if (account.executorMode !== "desktop"
      || account.executorDeviceIdHash !== desktopInstallationIdHash(input.installationId)
      || account.executorBindingGeneration < 1 || !account.executorLeaseExpiresAt) {
      fail("desktop_executor_binding_unavailable");
    }
    return Object.freeze({ accountId: account.id, executorMode: "desktop",
      bindingGeneration: account.executorBindingGeneration,
      leaseExpiresAt: account.executorLeaseExpiresAt,
      ownedByInstallation: true });
  }

  async renewDesktopExecutor(principal: DesktopInstallationPrincipal,
    bindings: readonly { accountId: string; accountHandle: string;
      loginStateVersion: number; bindingGeneration: number }[], now: string) {
    const at = Date.parse(now);
    if (!Number.isFinite(at) || !Array.isArray(bindings) || bindings.length < 1
      || bindings.some((binding) => !binding.accountId
        || !/^dyacct_[0-9a-f]{64}$/u.test(binding.accountHandle)
        || !Number.isSafeInteger(binding.loginStateVersion) || binding.loginStateVersion < 1
        || !Number.isSafeInteger(binding.bindingGeneration)
        || binding.bindingGeneration < 1)) {
      fail("desktop_executor_renewal_invalid");
    }
    try {
      return await this.options.repository.renewDesktopExecutors({ principal, bindings,
        renewedAt: now, leaseExpiresAt: new Date(at + 90_000).toISOString() });
    } catch { fail("desktop_executor_binding_stale"); }
  }
}
