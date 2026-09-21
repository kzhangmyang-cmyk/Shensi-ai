import { randomBytes as nativeRandomBytes } from "node:crypto";
import { join } from "node:path";

// This module is test-only and is excluded from the Backend production build.
// @ts-expect-error The validator is owned by the root runtime supervisor.
import { validateDisposableApiOnlyOwnerLock } from "../../scripts/api-only-runtime.mjs";

export function createDesktopStorageMysqlTestDatabaseName(
  randomBytes: (size: number) => Uint8Array = nativeRandomBytes
) {
  let entropy: Uint8Array;
  try { entropy = randomBytes(16); }
  catch { throw new Error("DESKTOP_ACTION_STORAGE_TEST_DATABASE_INVALID"); }
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 16) {
    throw new Error("DESKTOP_ACTION_STORAGE_TEST_DATABASE_INVALID");
  }
  const name = `goodjob_desktop_installation_${Buffer.from(entropy).toString("hex")}`;
  if (!/^goodjob_desktop_installation_[a-f0-9]{32}$/u.test(name)) {
    throw new Error("DESKTOP_ACTION_STORAGE_TEST_DATABASE_INVALID");
  }
  return name;
}

export async function assertDesktopStorageMysqlTestAuthority(input: {
  environment: NodeJS.ProcessEnv;
  repositoryRoot: string;
  validateOwnerLock?: (repositoryRoot: string,
    options: { nonce: string }) => Promise<unknown>;
}) {
  const urlText = input.environment.MYSQL_TEST_ADMIN_URL;
  const nonce = input.environment.DESKTOP_ACTION_STORAGE_LOCK_NONCE;
  if (!urlText || !/^[a-f0-9]{32}$/u.test(nonce ?? "")) {
    throw new Error("DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID");
  }
  let url: URL;
  try { url = new URL(urlText); } catch {
    throw new Error("DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID");
  }
  if (url.protocol !== "mysql:" || url.hostname !== "127.0.0.1" || url.port !== "3312"
    || url.username !== "root" || !url.password || url.pathname !== "/mysql"
    // mysql2 accepts query options such as socketPath, which can bypass the
    // nominal TCP host/port. Reject even empty query/fragment delimiters; the
    // operator percent-encodes reserved characters in generated passwords.
    || urlText.includes("?") || urlText.includes("#")) {
    throw new Error("DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID");
  }
  const path = join(input.repositoryRoot, ".runtime", "api-only-empty",
    "disposable-5628-3312");
  let lock: unknown;
  try {
    const validate = input.validateOwnerLock ?? validateDisposableApiOnlyOwnerLock;
    lock = await validate(input.repositoryRoot, { nonce });
  } catch { throw new Error("DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID"); }
  const record = lock as Record<string, unknown>;
  const ports = record?.ports as Record<string, unknown> | undefined;
  if (JSON.stringify(Object.keys(record)) !== JSON.stringify([
    "path", "project", "ports", "pid", "processStartToken", "nonce",
    "engineIdHash", "createdAt"
  ])
    || record.path !== path
    || !/^shensi-api-empty-[a-f0-9]{12}$/u.test(String(record.project ?? ""))
    || !ports || JSON.stringify(Object.keys(ports)) !== JSON.stringify(["gateway", "mysql"])
    || ports.gateway !== 5628 || ports.mysql !== 3312
    || !Number.isSafeInteger(record.pid) || Number(record.pid) < 1
    || typeof record.processStartToken !== "string" || !record.processStartToken
    || record.processStartToken.includes("\0")
    || record.nonce !== nonce
    || !/^[a-f0-9]{64}$/u.test(String(record.engineIdHash ?? ""))
    || typeof record.createdAt !== "string"
    || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error("DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID");
  }
  return Object.freeze({ adminUrl: url.href, lockNonce: nonce,
    project: String(record.project) });
}
