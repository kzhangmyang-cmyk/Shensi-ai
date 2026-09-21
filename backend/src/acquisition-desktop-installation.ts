import { createHash, timingSafeEqual } from "node:crypto";

export const DESKTOP_INSTALLATION_PROTOCOL_VERSION = 1 as const;
export const DESKTOP_INSTALLATION_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
export const DESKTOP_INSTALLATION_HASH = /^sha256:[a-f0-9]{64}$/u;

function domainHash(domain: string, value: string) {
  return `sha256:${createHash("sha256").update(`${domain}\0${value}`, "utf8").digest("hex")}`;
}

export function desktopInstallationIdHash(id: string) {
  if (!DESKTOP_INSTALLATION_TOKEN.test(id)) {
    throw new TypeError("desktop_installation_id_invalid");
  }
  return domainHash("shensi-desktop-installation", id);
}

export function desktopDeviceCredentialHash(credential: string) {
  if (!DESKTOP_INSTALLATION_TOKEN.test(credential)) {
    throw new TypeError("desktop_device_credential_invalid");
  }
  return domainHash("shensi-desktop-device-credential", credential);
}

export function desktopEnrollmentTokenHash(token: string) {
  if (!DESKTOP_INSTALLATION_TOKEN.test(token)) {
    throw new TypeError("desktop_enrollment_invalid");
  }
  return domainHash("shensi-desktop-enrollment-token", token);
}

export function desktopSecretHashEqual(left: string, right: string) {
  if (!DESKTOP_INSTALLATION_HASH.test(left) || !DESKTOP_INSTALLATION_HASH.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "ascii"), Buffer.from(right, "ascii"));
}

export interface DesktopInstallationPrincipal {
  workspaceId: string;
  userId: string;
  teamId: string;
  deviceIdHash: string;
  protocolVersion: 1;
}

export type DesktopInstallationState = "active" | "revoked";
