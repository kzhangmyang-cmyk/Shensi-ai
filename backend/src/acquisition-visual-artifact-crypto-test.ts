import assert from "node:assert/strict";
import test from "node:test";
import {
  AcquisitionVisualArtifactIntegrityError,
  decryptAcquisitionVisualArtifact,
  deriveAcquisitionVisualArtifactKey,
  encryptAcquisitionVisualArtifact,
  type AcquisitionVisualArtifactContext,
  type AcquisitionVisualArtifactEnvelope
} from "./acquisition-visual-artifact-crypto.js";

const MASTER_SECRET =
  "visual-artifact-test-master-secret-at-least-32-bytes";
const PLAINTEXT = Buffer.from(
  "RIFF\u0018\u0000\u0000\u0000WEBPVP8 redacted-comment-card",
  "utf8"
);
const HASH =
  "sha256:f8a5ec5508b4405fcffed67992153a1d3001005f8c75cfa7317fe242c203d64d";

function context(
  overrides: Partial<AcquisitionVisualArtifactContext> = {}
): AcquisitionVisualArtifactContext {
  return {
    ownerId: "owner-visual",
    teamId: "team-visual",
    sessionId: "visual-session-1",
    observationId: "visual-observation-1",
    artifactId: "visual-artifact-1",
    mediaType: "image/webp",
    plaintextHash: HASH,
    byteLength: PLAINTEXT.byteLength,
    ...overrides
  };
}

function encrypted() {
  return encryptAcquisitionVisualArtifact({
    masterSecret: MASTER_SECRET,
    context: context(),
    plaintext: PLAINTEXT
  });
}

function tampered(
  envelope: AcquisitionVisualArtifactEnvelope,
  overrides: Partial<AcquisitionVisualArtifactEnvelope>
) {
  return {
    ...envelope,
    iv: Buffer.from(envelope.iv),
    authTag: Buffer.from(envelope.authTag),
    ciphertext: Buffer.from(envelope.ciphertext),
    ...overrides
  };
}

test("visual artifact encryption derives a dedicated key and uses a fresh IV", () => {
  const dedicated = deriveAcquisitionVisualArtifactKey(MASTER_SECRET);
  assert.equal(dedicated.byteLength, 32);
  assert.notDeepEqual(
    dedicated,
    Buffer.from(MASTER_SECRET.padEnd(32, "\u0000").slice(0, 32))
  );

  const first = encrypted();
  const second = encrypted();
  assert.equal(first.envelopeVersion, "goodjob.visual-artifact-envelope.v1");
  assert.equal(first.keyDerivationVersion, "hkdf-sha256.visual-artifact.v1");
  assert.equal(first.algorithm, "aes-256-gcm");
  assert.equal(first.iv.byteLength, 12);
  assert.equal(first.authTag.byteLength, 16);
  assert.notDeepEqual(first.iv, second.iv);
  assert.notDeepEqual(first.ciphertext, PLAINTEXT);
  assert.deepEqual(decryptAcquisitionVisualArtifact({
    masterSecret: MASTER_SECRET,
    context: context(),
    envelope: first
  }), PLAINTEXT);
});

test("visual artifact AAD binds every tenant and artifact identity fact", () => {
  const envelope = encrypted();
  const mutations: Array<Partial<AcquisitionVisualArtifactContext>> = [
    { ownerId: "other-owner" },
    { teamId: "other-team" },
    { sessionId: "visual-session-2" },
    { observationId: "visual-observation-2" },
    { artifactId: "visual-artifact-2" },
    { plaintextHash: `sha256:${"f".repeat(64)}` },
    { byteLength: PLAINTEXT.byteLength + 1 }
  ];
  for (const mutation of mutations) {
    assert.throws(
      () => decryptAcquisitionVisualArtifact({
        masterSecret: MASTER_SECRET,
        context: context(mutation),
        envelope
      }),
      (error: unknown) =>
        error instanceof AcquisitionVisualArtifactIntegrityError
        && error.code === "ACQUISITION_VISUAL_ARTIFACT_INTEGRITY"
    );
  }
});

test("visual artifact decryption fails closed for tampering and the wrong key", () => {
  const envelope = encrypted();
  const ciphertext = Buffer.from(envelope.ciphertext);
  ciphertext[0] ^= 0xff;
  const authTag = Buffer.from(envelope.authTag);
  authTag[0] ^= 0xff;
  const iv = Buffer.from(envelope.iv);
  iv[0] ^= 0xff;
  const candidates = [
    tampered(envelope, { ciphertext }),
    tampered(envelope, { authTag }),
    tampered(envelope, { iv })
  ];
  for (const candidate of candidates) {
    assert.throws(
      () => decryptAcquisitionVisualArtifact({
        masterSecret: MASTER_SECRET,
        context: context(),
        envelope: candidate
      }),
      AcquisitionVisualArtifactIntegrityError
    );
  }
  assert.throws(
    () => decryptAcquisitionVisualArtifact({
      masterSecret: `${MASTER_SECRET}-wrong`,
      context: context(),
      envelope
    }),
    AcquisitionVisualArtifactIntegrityError
  );
});

test("visual artifact crypto rejects malformed envelopes without releasing bytes", () => {
  const envelope = encrypted();
  const malformed: AcquisitionVisualArtifactEnvelope[] = [
    tampered(envelope, { envelopeVersion: "unknown" as never }),
    tampered(envelope, { keyDerivationVersion: "unknown" as never }),
    tampered(envelope, { algorithm: "aes-128-gcm" as never }),
    tampered(envelope, { iv: Buffer.alloc(11) }),
    tampered(envelope, { authTag: Buffer.alloc(15) }),
    tampered(envelope, { ciphertext: Buffer.alloc(0) })
  ];
  for (const candidate of malformed) {
    assert.throws(
      () => decryptAcquisitionVisualArtifact({
        masterSecret: MASTER_SECRET,
        context: context(),
        envelope: candidate
      }),
      AcquisitionVisualArtifactIntegrityError
    );
  }
});

test("visual artifact crypto validates the acquisition master secret", () => {
  for (const secret of ["too-short", " ".repeat(64)]) {
    assert.throws(
      () => deriveAcquisitionVisualArtifactKey(secret),
      /master secret|32/u
    );
  }
});
