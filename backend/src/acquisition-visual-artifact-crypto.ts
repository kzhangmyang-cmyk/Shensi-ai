import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes
} from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";

export const ACQUISITION_VISUAL_ARTIFACT_ENVELOPE_VERSION =
  "goodjob.visual-artifact-envelope.v1" as const;
export const ACQUISITION_VISUAL_ARTIFACT_KEY_DERIVATION_VERSION =
  "hkdf-sha256.visual-artifact.v1" as const;
export const ACQUISITION_VISUAL_ARTIFACT_ALGORITHM =
  "aes-256-gcm" as const;

const VISUAL_ARTIFACT_HKDF_SALT = Buffer.from(
  "goodjob-acquisition-visual-artifact-salt.v1",
  "utf8"
);
const VISUAL_ARTIFACT_HKDF_INFO = Buffer.from(
  "goodjob-acquisition/redacted-visual-comment-artifacts/aes-256-gcm/v1",
  "utf8"
);
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface AcquisitionVisualArtifactContext {
  ownerId: string;
  teamId: string;
  sessionId: string;
  observationId: string;
  artifactId: string;
  mediaType: "image/webp";
  plaintextHash: string;
  byteLength: number;
}

export interface AcquisitionVisualArtifactEnvelope {
  envelopeVersion: typeof ACQUISITION_VISUAL_ARTIFACT_ENVELOPE_VERSION;
  keyDerivationVersion:
    typeof ACQUISITION_VISUAL_ARTIFACT_KEY_DERIVATION_VERSION;
  algorithm: typeof ACQUISITION_VISUAL_ARTIFACT_ALGORITHM;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

export class AcquisitionVisualArtifactIntegrityError extends Error {
  readonly code = "ACQUISITION_VISUAL_ARTIFACT_INTEGRITY" as const;

  constructor() {
    super("ACQUISITION_VISUAL_ARTIFACT_INTEGRITY");
    this.name = "AcquisitionVisualArtifactIntegrityError";
  }
}

function masterSecretBytes(masterSecret: string) {
  if (typeof masterSecret !== "string") {
    throw new TypeError(
      "acquisition master secret must contain at least 32 non-whitespace bytes"
    );
  }
  const normalized = masterSecret.trim();
  if (Buffer.byteLength(normalized, "utf8") < 32) {
    throw new TypeError(
      "acquisition master secret must contain at least 32 non-whitespace bytes"
    );
  }
  return Buffer.from(normalized, "utf8");
}

export function deriveAcquisitionVisualArtifactKey(masterSecret: string) {
  return Buffer.from(hkdfSync(
    "sha256",
    masterSecretBytes(masterSecret),
    VISUAL_ARTIFACT_HKDF_SALT,
    VISUAL_ARTIFACT_HKDF_INFO,
    32
  ));
}

function validContext(context: AcquisitionVisualArtifactContext) {
  const identityValues = [
    context.ownerId,
    context.teamId,
    context.sessionId,
    context.observationId,
    context.artifactId
  ];
  return identityValues.every((value) =>
    typeof value === "string" && value.length > 0)
    && context.mediaType === "image/webp"
    && SHA256_DIGEST.test(context.plaintextHash)
    && Number.isSafeInteger(context.byteLength)
    && context.byteLength > 0
    && context.byteLength <= 262_144;
}

function additionalAuthenticatedData(context: AcquisitionVisualArtifactContext) {
  if (!validContext(context)) {
    throw new TypeError("invalid visual artifact encryption context");
  }
  return Buffer.from(canonicalJsonStringify({
    envelopeVersion: ACQUISITION_VISUAL_ARTIFACT_ENVELOPE_VERSION,
    keyDerivationVersion:
      ACQUISITION_VISUAL_ARTIFACT_KEY_DERIVATION_VERSION,
    algorithm: ACQUISITION_VISUAL_ARTIFACT_ALGORITHM,
    ownerId: context.ownerId,
    teamId: context.teamId,
    sessionId: context.sessionId,
    observationId: context.observationId,
    artifactId: context.artifactId,
    mediaType: context.mediaType,
    plaintextHash: context.plaintextHash,
    byteLength: context.byteLength
  }) ?? "", "utf8");
}

function plaintextDigest(plaintext: Buffer) {
  return `sha256:${createHash("sha256").update(plaintext).digest("hex")}`;
}

export function encryptAcquisitionVisualArtifact(input: {
  masterSecret: string;
  context: AcquisitionVisualArtifactContext;
  plaintext: Buffer;
}): AcquisitionVisualArtifactEnvelope {
  if (!Buffer.isBuffer(input.plaintext)
    || input.plaintext.byteLength !== input.context.byteLength
    || plaintextDigest(input.plaintext) !== input.context.plaintextHash) {
    throw new TypeError("invalid visual artifact plaintext");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    ACQUISITION_VISUAL_ARTIFACT_ALGORITHM,
    deriveAcquisitionVisualArtifactKey(input.masterSecret),
    iv
  );
  cipher.setAAD(additionalAuthenticatedData(input.context));
  const ciphertext = Buffer.concat([
    cipher.update(input.plaintext),
    cipher.final()
  ]);
  return {
    envelopeVersion: ACQUISITION_VISUAL_ARTIFACT_ENVELOPE_VERSION,
    keyDerivationVersion:
      ACQUISITION_VISUAL_ARTIFACT_KEY_DERIVATION_VERSION,
    algorithm: ACQUISITION_VISUAL_ARTIFACT_ALGORITHM,
    iv,
    authTag: cipher.getAuthTag(),
    ciphertext
  };
}

function validEnvelope(
  envelope: AcquisitionVisualArtifactEnvelope
): envelope is AcquisitionVisualArtifactEnvelope {
  return !!envelope
    && envelope.envelopeVersion
      === ACQUISITION_VISUAL_ARTIFACT_ENVELOPE_VERSION
    && envelope.keyDerivationVersion
      === ACQUISITION_VISUAL_ARTIFACT_KEY_DERIVATION_VERSION
    && envelope.algorithm === ACQUISITION_VISUAL_ARTIFACT_ALGORITHM
    && Buffer.isBuffer(envelope.iv)
    && envelope.iv.byteLength === 12
    && Buffer.isBuffer(envelope.authTag)
    && envelope.authTag.byteLength === 16
    && Buffer.isBuffer(envelope.ciphertext)
    && envelope.ciphertext.byteLength > 0;
}

export function decryptAcquisitionVisualArtifact(input: {
  masterSecret: string;
  context: AcquisitionVisualArtifactContext;
  envelope: AcquisitionVisualArtifactEnvelope;
}) {
  try {
    if (!validEnvelope(input.envelope) || !validContext(input.context)) {
      throw new AcquisitionVisualArtifactIntegrityError();
    }
    const decipher = createDecipheriv(
      ACQUISITION_VISUAL_ARTIFACT_ALGORITHM,
      deriveAcquisitionVisualArtifactKey(input.masterSecret),
      input.envelope.iv
    );
    decipher.setAAD(additionalAuthenticatedData(input.context));
    decipher.setAuthTag(input.envelope.authTag);
    const plaintext = Buffer.concat([
      decipher.update(input.envelope.ciphertext),
      decipher.final()
    ]);
    if (plaintext.byteLength !== input.context.byteLength
      || plaintextDigest(plaintext) !== input.context.plaintextHash) {
      throw new AcquisitionVisualArtifactIntegrityError();
    }
    return plaintext;
  } catch (error) {
    if (error instanceof AcquisitionVisualArtifactIntegrityError) throw error;
    throw new AcquisitionVisualArtifactIntegrityError();
  }
}
