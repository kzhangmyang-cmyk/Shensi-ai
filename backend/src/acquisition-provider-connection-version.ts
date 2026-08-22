import type { ProviderConnection } from "./types.js";

/**
 * New and migrated Provider connections expose a monotonic credential
 * version. The timestamp fallback only keeps legacy in-memory records
 * readable until they are persisted and materialized at version 1.
 */
export function acquisitionProviderConnectionVersion(
  connection: Pick<ProviderConnection, "updatedAt"> & {
    credentialVersion?: number;
  }
) {
  if (
    Number.isSafeInteger(connection.credentialVersion)
    && Number(connection.credentialVersion) > 0
  ) {
    return Number(connection.credentialVersion);
  }
  const version = Date.parse(connection.updatedAt);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("ACQUISITION_PROVIDER_VERSION_UNAVAILABLE");
  }
  return version;
}
