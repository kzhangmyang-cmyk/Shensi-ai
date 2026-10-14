import assert from "node:assert/strict";
import test from "node:test";

import { desktopDeviceCredentialHash, desktopEnrollmentTokenHash, desktopInstallationIdHash,
  desktopSecretHashEqual } from
  "./acquisition-desktop-installation.js";
import { desktopEnrollmentIdempotencyKeyHash,
  InMemoryDesktopInstallationRepository } from
  "./acquisition-desktop-installation-repository.js";
import { AcquisitionDesktopInstallationService } from
  "./acquisition-desktop-installation-service.js";

const installationId = "A".repeat(43);
const otherInstallationId = "C".repeat(43);
const requestHash = "1".repeat(64);
const scope = { workspaceId: "workspace-1", userId: "user-1", teamId: "team-1" };

function fixture() {
  let now = "2026-09-04T00:00:00.000Z";
  const active = new Set(["workspace-1\0user-1\0team-1"]);
  const repository = new InMemoryDesktopInstallationRepository();
  const service = new AcquisitionDesktopInstallationService({
    repository,
    secret: "desktop-installation-test-secret-32-bytes-minimum",
    now: () => now,
    isActiveMembership: async (candidate) => active.has(
      `${candidate.workspaceId}\0${candidate.userId}\0${candidate.teamId}`
    )
  });
  return { service, repository, active, setNow(value: string) { now = value; } };
}

test("desktop installation and credential hashes use separate locked domains", () => {
  assert.equal(desktopInstallationIdHash(installationId),
    "sha256:87c4f63546a7d6acb93d164aa6af00056882d79e47cd23af24a84c219a224778");
  assert.equal(desktopDeviceCredentialHash("B".repeat(43)),
    "sha256:b3cec3a5c6362f1d9d5387a5f64030f20a6a3f5e2f82b9601e961bc4ce1f307f");
  assert.equal(desktopSecretHashEqual("sha256:" + "a".repeat(64),
    "sha256:" + "a".repeat(64)), true);
  assert.equal(desktopSecretHashEqual("sha256:" + "a".repeat(64),
    "sha256:" + "b".repeat(64)), false);
  assert.equal(desktopEnrollmentIdempotencyKeyHash("same-key"),
    "7d67b28621e7ee2be73326f82c2699de7cf5cc567544cabcf54df8ff719bb3e1");
});

test("enrollment expires after exactly sixty seconds and is single-use", async () => {
  const { service } = fixture();
  const enrollment = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "enroll-key", requestHash);
  assert.match(enrollment.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(enrollment.expiresAt, "2026-09-04T00:01:00.000Z");
  const registered = await service.register({
    installationId, enrollmentToken: enrollment.token, protocolVersion: 1
  }, "single-use-registration", "6".repeat(64));
  assert.match(registered.deviceToken, /^[A-Za-z0-9_-]{43}$/u);
  await assert.rejects(service.register({
    installationId, enrollmentToken: enrollment.token, protocolVersion: 1
  }, "single-use-registration-other", "6".repeat(64)),
  /desktop_registration_idempotency_conflict/u);
});

test("enrollment command replays deterministically and conflicts on request hash", async () => {
  const { service, repository, setNow, active } = fixture();
  const first = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "same-key", requestHash);
  setNow("2026-09-04T00:00:30.000Z");
  const restarted = new AcquisitionDesktopInstallationService({ repository,
    secret: "desktop-installation-test-secret-32-bytes-minimum",
    now: () => "2026-09-04T00:00:30.000Z",
    isActiveMembership: async (candidate) => active.has(
      `${candidate.workspaceId}\0${candidate.userId}\0${candidate.teamId}`)
  });
  assert.deepEqual(await restarted.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "same-key", requestHash), first);
  await assert.rejects(restarted.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "same-key", "2".repeat(64)),
  /desktop_enrollment_idempotency_conflict/u);
});

test("concurrent registration has exactly one winner", async () => {
  const { service } = fixture();
  const enrollment = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "race-key", requestHash);
  const results = await Promise.allSettled([service.register({ installationId,
    enrollmentToken: enrollment.token, protocolVersion: 1 }, "race-registration", "7".repeat(64)),
  service.register({ installationId, enrollmentToken: enrollment.token, protocolVersion: 1 },
  "race-registration", "7".repeat(64))]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.deepEqual(results.filter((result) => result.status === "fulfilled")
    .map((result) => (result as PromiseFulfilledResult<{ replayed: boolean }>).value.replayed)
    .sort(), [false, true]);
});

test("failed installation insert rolls back consumption and the mutation queue recovers", async () => {
  const repository = new InMemoryDesktopInstallationRepository({
    failInstallationInsertAt: 1
  });
  const service = new AcquisitionDesktopInstallationService({ repository,
    secret: "desktop-installation-test-secret-32-bytes-minimum",
    now: () => "2026-09-04T00:00:00.000Z",
    isActiveMembership: async () => true });
  const enrollment = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "rollback-key", requestHash);
  await assert.rejects(service.register({ installationId,
    enrollmentToken: enrollment.token, protocolVersion: 1 }, "rollback-registration", "8".repeat(64)),
  /desktop_enrollment_invalid/u);
  const registered = await service.register({ installationId,
    enrollmentToken: enrollment.token, protocolVersion: 1 }, "rollback-registration", "8".repeat(64));
  assert.match(registered.deviceToken, /^[A-Za-z0-9_-]{43}$/u);
});

test("expired and mismatched enrollment inputs fail without leaking credentials", async () => {
  const { service, setNow } = fixture();
  const enrollment = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "expiry-key", requestHash);
  for (const input of [
    { installationId: otherInstallationId, enrollmentToken: enrollment.token, protocolVersion: 1 },
    { installationId, enrollmentToken: "Z".repeat(43), protocolVersion: 1 },
    { installationId, enrollmentToken: enrollment.token, protocolVersion: 2 }
  ]) {
    await assert.rejects(service.register(input as never, "invalid-registration", "9".repeat(64)), (error: unknown) => {
      assert.equal(String((error as Error).message).includes(enrollment.token), false);
      assert.equal(String((error as Error).message).includes(installationId), false);
      return /desktop_enrollment_invalid/u.test(String((error as Error).message));
    });
  }
  setNow("2026-09-04T00:01:00.000Z");
  await assert.rejects(service.register({
    installationId, enrollmentToken: enrollment.token, protocolVersion: 1
  }, "expiry-registration", "a".repeat(64)), /desktop_enrollment_expired/u);
});

test("authentication is workspace scoped and requires current active membership", async () => {
  const { service, active } = fixture();
  const enrollment = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "auth-key", requestHash);
  const registered = await service.register({
    installationId, enrollmentToken: enrollment.token, protocolVersion: 1
  }, "auth-registration", "b".repeat(64));
  assert.deepEqual(await service.authenticate({ workspaceId: "workspace-1",
    installationId, deviceToken: registered.deviceToken, protocolVersion: 1 }), {
    workspaceId: "workspace-1", userId: "user-1", teamId: "team-1",
    deviceIdHash: desktopInstallationIdHash(installationId), protocolVersion: 1
  });
  assert.equal(await service.authenticate({ workspaceId: "workspace-2",
    installationId, deviceToken: registered.deviceToken, protocolVersion: 1 }), null);
  assert.equal(await service.authenticate({ workspaceId: "workspace-1",
    installationId, deviceToken: "Y".repeat(43), protocolVersion: 1 }), null);
  assert.equal(await service.authenticate({ workspaceId: "workspace-1",
    installationId, deviceToken: registered.deviceToken, protocolVersion: 2 as never }), null);
  active.clear();
  assert.equal(await service.authenticate({ workspaceId: "workspace-1",
    installationId, deviceToken: registered.deviceToken, protocolVersion: 1 }), null);
});

test("one active user can register two independent Mac installations against the same central workspace", async () => {
  const { service } = fixture();
  const firstEnrollment = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "mac-a-enrollment", requestHash);
  const secondEnrollment = await service.createEnrollment(scope,
    { installationId: otherInstallationId, protocolVersion: 1 }, "mac-b-enrollment", "2".repeat(64));
  const first = await service.register({ installationId,
    enrollmentToken: firstEnrollment.token, protocolVersion: 1 }, "mac-a-registration", "3".repeat(64));
  const second = await service.register({ installationId: otherInstallationId,
    enrollmentToken: secondEnrollment.token, protocolVersion: 1 }, "mac-b-registration", "4".repeat(64));
  assert.notEqual(first.deviceToken, second.deviceToken);
  assert.equal((await service.authenticate({ workspaceId: scope.workspaceId,
    installationId, deviceToken: first.deviceToken, protocolVersion: 1 }))?.userId, scope.userId);
  assert.equal((await service.authenticate({ workspaceId: scope.workspaceId,
    installationId: otherInstallationId, deviceToken: second.deviceToken, protocolVersion: 1 }))?.userId, scope.userId);
  assert.equal(await service.authenticate({ workspaceId: "workspace-other",
    installationId: otherInstallationId, deviceToken: second.deviceToken, protocolVersion: 1 }), null);
});

test("revoked installations cannot authenticate", async () => {
  const { service } = fixture();
  const enrollment = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "revoke-key", requestHash);
  const registered = await service.register({
    installationId, enrollmentToken: enrollment.token, protocolVersion: 1
  }, "revoke-registration", "c".repeat(64));
  assert.equal(await service.revoke(scope, installationId), true);
  assert.equal(await service.authenticate({ workspaceId: "workspace-1",
    installationId, deviceToken: registered.deviceToken, protocolVersion: 1 }), null);
});

test("re-enrollment preserves durable installation creation time in Memory", async () => {
  const { service, repository, setNow } = fixture();
  const firstEnrollment = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "first-enrollment", requestHash);
  await service.register({ installationId, enrollmentToken: firstEnrollment.token,
    protocolVersion: 1 }, "first-registration", "d".repeat(64));
  setNow("2026-09-04T00:02:00.000Z");
  const secondEnrollment = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "second-enrollment", requestHash);
  const second = await service.register({ installationId,
    enrollmentToken: secondEnrollment.token, protocolVersion: 1 }, "second-registration", "e".repeat(64));
  const record = await repository.authenticate({ workspaceId: scope.workspaceId,
    deviceIdHash: desktopInstallationIdHash(installationId),
    deviceCredentialHash: desktopDeviceCredentialHash(second.deviceToken),
    protocolVersion: 1 });
  assert.equal(record?.createdAt, "2026-09-04T00:00:00.000Z");
  assert.equal(record?.updatedAt, "2026-09-04T00:02:00.000Z");
});

test("service sanitizes repository failures across enrollment auth and revocation", async () => {
  const leaked = "mysql password=super-secret";
  const repository = {
    async createEnrollment() { throw new Error(leaked); },
    async findEnrollmentReplay() { throw new Error(leaked); },
    async consumeEnrollment() { throw new Error(leaked); },
    async authenticate() { throw new Error(leaked); },
    async revoke() { throw new Error(leaked); }
  };
  const service = new AcquisitionDesktopInstallationService({
    repository, secret: "desktop-installation-test-secret-32-bytes-minimum",
    now: () => "2026-09-04T00:00:00.000Z", isActiveMembership: async () => true
  });
  for (const [operation, expected] of [
    [() => service.createEnrollment(scope, { installationId, protocolVersion: 1 },
      "sanitize-enrollment", requestHash), "desktop_enrollment_unavailable"],
    [() => service.register({ installationId, enrollmentToken: "C".repeat(43),
      protocolVersion: 1 }, "sanitize-registration", "f".repeat(64)), "desktop_enrollment_invalid"],
    [() => service.authenticate({ workspaceId: scope.workspaceId, installationId,
      deviceToken: "B".repeat(43), protocolVersion: 1 }), "desktop_installation_unavailable"],
    [() => service.revoke(scope, installationId), "desktop_installation_unavailable"]
  ] as const) {
    await assert.rejects(operation, (error: unknown) => {
      assert.equal((error as Error).message, expected);
      assert.equal(String(error).includes(leaked), false);
      return true;
    });
  }
});

test("enrollment idempotency keys enforce exact 8 through 200 character bounds", async () => {
  for (const key of ["k".repeat(7), "k".repeat(201)]) {
    const { service } = fixture();
    await assert.rejects(service.createEnrollment(scope,
      { installationId, protocolVersion: 1 }, key, requestHash),
    /desktop_enrollment_invalid/u);
  }
  for (const key of ["k".repeat(8), "k".repeat(200)]) {
    const { service } = fixture();
    assert.match((await service.createEnrollment(scope,
      { installationId, protocolVersion: 1 }, key, requestHash)).token,
    /^[A-Za-z0-9_-]{43}$/u);
  }
});

test("registration replays only the exact committed idempotency command", async () => {
  const { service } = fixture();
  const enrollment = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "registration-replay-enrollment", requestHash);
  const first = await service.register({ installationId, enrollmentToken: enrollment.token,
    protocolVersion: 1 }, "registration-replay-key", "3".repeat(64));
  const replay = await service.register({ installationId, enrollmentToken: enrollment.token,
    protocolVersion: 1 }, "registration-replay-key", "3".repeat(64));
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal(first.replayed, false);
  assert.equal("deviceIdHash" in first, false);
  await assert.rejects(service.register({ installationId, enrollmentToken: enrollment.token,
    protocolVersion: 1 }, "different-registration-key", "3".repeat(64)),
  /desktop_registration_idempotency_conflict/u);
  await assert.rejects(service.register({ installationId, enrollmentToken: enrollment.token,
    protocolVersion: 1 }, "registration-replay-key", "4".repeat(64)),
  /desktop_registration_idempotency_conflict/u);
});

test("header-shaped device authentication resolves one active principal without workspace input", async () => {
  const { service, active } = fixture();
  const enrollment = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "device-principal-enrollment", requestHash);
  const registration = await service.register({ installationId, enrollmentToken: enrollment.token,
    protocolVersion: 1 }, "device-principal-registration", "5".repeat(64));
  assert.deepEqual(await service.authenticateDevice({ installationId,
    deviceToken: registration.deviceToken, protocolVersion: 1 }), {
    workspaceId: scope.workspaceId, userId: scope.userId, teamId: scope.teamId,
    deviceIdHash: desktopInstallationIdHash(installationId), protocolVersion: 1
  });
  active.clear();
  assert.equal(await service.authenticateDevice({ installationId,
    deviceToken: registration.deviceToken, protocolVersion: 1 }), null);
});

test("header-shaped authentication rejects ambiguous active device records", async () => {
  const { service, repository } = fixture();
  const deviceIdHash = desktopInstallationIdHash(installationId);
  const credentialHash = desktopDeviceCredentialHash("B".repeat(43));
  for (const [workspaceId, userId, teamId, token] of [
    ["workspace-1", "user-1", "team-1", "C".repeat(43)],
    ["workspace-2", "user-2", "team-2", "D".repeat(43)]
  ]) {
    await repository.createEnrollment({ workspaceId, userId, teamId, deviceIdHash,
      protocolVersion: 1, enrollmentTokenHash: desktopEnrollmentTokenHash(token),
      idempotencyKeyHash: `${workspaceId === "workspace-1" ? "6" : "7"}`.repeat(64),
      requestHash: "8".repeat(64), expiresAt: "2026-09-04T00:01:00.000Z",
      createdAt: "2026-09-04T00:00:00.000Z", consumedAt: null });
    await repository.consumeEnrollment({ deviceIdHash,
      enrollmentTokenHash: desktopEnrollmentTokenHash(token), deviceCredentialHash: credentialHash,
      protocolVersion: 1, consumedAt: "2026-09-04T00:00:30.000Z" });
  }
  assert.equal(await service.authenticateDevice({ installationId, deviceToken: "B".repeat(43),
    protocolVersion: 1 }), null);
});

test("registration replay rejects legacy metadata and a rotated installation credential", async () => {
  const { service, repository } = fixture();
  const legacyToken = "C".repeat(43);
  await repository.createEnrollment({ ...scope, deviceIdHash: desktopInstallationIdHash(installationId),
    protocolVersion: 1, enrollmentTokenHash: desktopEnrollmentTokenHash(legacyToken),
    idempotencyKeyHash: "a".repeat(64), requestHash: "b".repeat(64),
    expiresAt: "2026-09-04T00:01:00.000Z", createdAt: "2026-09-04T00:00:00.000Z",
    consumedAt: "2026-09-04T00:00:30.000Z", registrationIdempotencyKeyHash: null,
    registrationRequestHash: null });
  assert.deepEqual(await repository.consumeEnrollment({
    deviceIdHash: desktopInstallationIdHash(installationId),
    enrollmentTokenHash: desktopEnrollmentTokenHash(legacyToken),
    deviceCredentialHash: desktopDeviceCredentialHash("B".repeat(43)), protocolVersion: 1,
    consumedAt: "2026-09-04T00:00:31.000Z" }), { kind: "conflict" });

  const firstEnrollment = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "stale-replay-enrollment", requestHash);
  const first = await service.register({ installationId, enrollmentToken: firstEnrollment.token,
    protocolVersion: 1 }, "stale-replay-registration", "c".repeat(64));
  const replacementEnrollment = await service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "replacement-enrollment", "d".repeat(64));
  await service.register({ installationId, enrollmentToken: replacementEnrollment.token,
    protocolVersion: 1 }, "replacement-registration", "e".repeat(64));
  await assert.rejects(service.register({ installationId, enrollmentToken: firstEnrollment.token,
    protocolVersion: 1 }, "stale-replay-registration", "c".repeat(64)),
  /desktop_registration_idempotency_conflict/u);
  assert.match(first.deviceToken, /^[A-Za-z0-9_-]{43}$/u);

  const revokedFixture = fixture();
  const revokedEnrollment = await revokedFixture.service.createEnrollment(scope,
    { installationId, protocolVersion: 1 }, "revoked-replay-enrollment", requestHash);
  await revokedFixture.service.register({ installationId, enrollmentToken: revokedEnrollment.token,
    protocolVersion: 1 }, "revoked-replay-registration", "f".repeat(64));
  await revokedFixture.service.revoke(scope, installationId);
  await assert.rejects(revokedFixture.service.register({ installationId,
    enrollmentToken: revokedEnrollment.token, protocolVersion: 1 },
  "revoked-replay-registration", "f".repeat(64)), /desktop_registration_idempotency_conflict/u);
});
