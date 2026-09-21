import type mysql from "mysql2/promise";

export const ACQUISITION_MYSQL_NAMED_LOCK_RELEASE_FAILED =
  "ACQUISITION_MYSQL_NAMED_LOCK_RELEASE_FAILED";

const poisonedConnections = new WeakSet<object>();

export class AcquisitionMysqlNamedLockReleaseError extends Error {
  readonly code = ACQUISITION_MYSQL_NAMED_LOCK_RELEASE_FAILED;

  constructor() {
    super(ACQUISITION_MYSQL_NAMED_LOCK_RELEASE_FAILED);
    this.name = "AcquisitionMysqlNamedLockReleaseError";
  }
}

export function isAcquisitionMysqlNamedLockReleaseError(
  error: unknown
) {
  return error instanceof AcquisitionMysqlNamedLockReleaseError
    || (error instanceof Error
      && error.message === ACQUISITION_MYSQL_NAMED_LOCK_RELEASE_FAILED);
}

export function poisonAcquisitionMysqlConnection(
  connection: mysql.PoolConnection
) {
  if (poisonedConnections.has(connection)) return;
  poisonedConnections.add(connection);
  try {
    connection.destroy();
  } catch {
    // A failed destroy must never make the poisoned session eligible for reuse.
  }
}

export function releaseAcquisitionMysqlConnection(
  connection: mysql.PoolConnection
) {
  if (!poisonedConnections.has(connection)) connection.release();
}

export async function releaseAcquisitionMysqlNamedLocks(
  connection: mysql.PoolConnection,
  lockNames: Iterable<string>
) {
  for (const lockName of [...lockNames].reverse()) {
    try {
      const [result] = await connection.query(
        "SELECT RELEASE_LOCK(?) AS lock_released",
        [lockName]
      );
      const row = Array.isArray(result)
        ? result[0] as Record<string, unknown> | undefined
        : undefined;
      if (Number(row?.lock_released) !== 1) {
        throw new AcquisitionMysqlNamedLockReleaseError();
      }
    } catch {
      poisonAcquisitionMysqlConnection(connection);
      throw new AcquisitionMysqlNamedLockReleaseError();
    }
  }
}
