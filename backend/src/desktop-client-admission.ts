import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export const DESKTOP_BUILD_MANIFEST_SHA256_HEADER =
  "X-Shensi-Desktop-Build-Manifest-SHA256";

export const DESKTOP_CLIENT_MIGRATION_LOCKED_ERROR =
  "desktop_client_migration_locked";
export const DESKTOP_CLIENT_BUILD_NOT_ADMITTED_ERROR =
  "desktop_client_build_not_admitted";

export type DesktopClientAdmissionConfiguration =
  | { mode: "migration_locked" }
  | { mode: "exact"; admittedBuildManifestSha256: string;
      additionalAdmittedBuildManifestSha256s?: readonly string[] };

export interface DesktopClientAdmissionEnvironment {
  SHENSI_DESKTOP_CLIENT_ADMISSION_MODE?: string;
  SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256?: string;
  SHENSI_DESKTOP_ADDITIONAL_ADMITTED_BUILD_MANIFEST_SHA256S?: string;
}

const LOWERCASE_SHA256 = /^[a-f0-9]{64}$/u;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function resolveDesktopClientAdmissionConfiguration(
  environment: DesktopClientAdmissionEnvironment
): DesktopClientAdmissionConfiguration {
  const mode = environment.SHENSI_DESKTOP_CLIENT_ADMISSION_MODE;
  if (mode !== "migration_locked" && mode !== "exact") {
    throw new Error("SHENSI_DESKTOP_CLIENT_ADMISSION_MODE must be migration_locked|exact");
  }

  const admittedDigest = environment.SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256;
  const additionalDigests = environment.SHENSI_DESKTOP_ADDITIONAL_ADMITTED_BUILD_MANIFEST_SHA256S;
  if (mode === "migration_locked") {
    if (admittedDigest !== undefined && admittedDigest !== "") {
      throw new Error("SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256 must be empty in migration_locked mode");
    }
    if (additionalDigests !== undefined && additionalDigests !== "") {
      throw new Error("SHENSI_DESKTOP_ADDITIONAL_ADMITTED_BUILD_MANIFEST_SHA256S must be empty in migration_locked mode");
    }
    return { mode };
  }

  if (!admittedDigest || !LOWERCASE_SHA256.test(admittedDigest)) {
    throw new Error("SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256 must be 64 lowercase hexadecimal characters in exact mode");
  }
  if (additionalDigests === undefined || additionalDigests === "") {
    return { mode, admittedBuildManifestSha256: admittedDigest };
  }
  const parsed = additionalDigests.split(",");
  if (parsed.length > 7 || parsed.some((digest) => !LOWERCASE_SHA256.test(digest))
    || new Set([admittedDigest, ...parsed]).size !== parsed.length + 1) {
    throw new Error("SHENSI_DESKTOP_ADDITIONAL_ADMITTED_BUILD_MANIFEST_SHA256S must contain 1-7 unique comma-separated lowercase SHA-256 digests distinct from the primary digest");
  }
  return { mode, admittedBuildManifestSha256: admittedDigest,
    additionalAdmittedBuildManifestSha256s: Object.freeze(parsed) };
}

function suppliedBuildManifestDigests(rawHeaders: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase()
      === DESKTOP_BUILD_MANIFEST_SHA256_HEADER.toLowerCase()) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function isAdmittedDigest(
  supplied: string[],
  admitted: readonly string[]
): boolean {
  if (supplied.length !== 1 || !LOWERCASE_SHA256.test(supplied[0])) return false;
  const suppliedBytes = Buffer.from(supplied[0], "hex");
  let match = false;
  for (const candidate of admitted) {
    const admittedBytes = Buffer.from(candidate, "hex");
    match = (suppliedBytes.length === admittedBytes.length
      && timingSafeEqual(suppliedBytes, admittedBytes)) || match;
  }
  return match;
}

export function createDesktopClientAdmissionMiddleware(
  configuration: DesktopClientAdmissionConfiguration
): RequestHandler {
  return (request, response, next) => {
    if (READ_METHODS.has(request.method)) {
      next();
      return;
    }
    if (configuration.mode === "migration_locked") {
      response.status(503).json({ error: DESKTOP_CLIENT_MIGRATION_LOCKED_ERROR });
      return;
    }
    if (!isAdmittedDigest(suppliedBuildManifestDigests(request.rawHeaders), [
      configuration.admittedBuildManifestSha256,
      ...(configuration.additionalAdmittedBuildManifestSha256s ?? [])
    ])) {
      response.status(409).json({ error: DESKTOP_CLIENT_BUILD_NOT_ADMITTED_ERROR });
      return;
    }
    next();
  };
}
