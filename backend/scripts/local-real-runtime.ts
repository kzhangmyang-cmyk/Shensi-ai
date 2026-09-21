const MYSQL_HOST = "127.0.0.1";
const MYSQL_PORT = 3307;
const MYSQL_DATABASE = "shensi_sales";
const MYSQL_USER = "shensi_sales_app";

export interface LocalRealRuntimeConfig {
  readonly mysqlHost: "127.0.0.1";
  readonly mysqlPort: 3307;
  readonly mysqlDatabase: "shensi_sales";
  readonly backendOrigin: "http://127.0.0.1:4188";
  readonly frontendOrigin: "http://127.0.0.1:5188";
}

export function readLocalRealRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>
): LocalRealRuntimeConfig {
  if (env.CRM_STORE !== "mysql") {
    throw new Error("REAL_RUNTIME_REQUIRES_MYSQL");
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(env.DATABASE_URL ?? "");
  } catch {
    throw new Error("REAL_RUNTIME_MYSQL_TOPOLOGY_INVALID");
  }
  if (
    databaseUrl.protocol !== "mysql:"
    || databaseUrl.hostname !== MYSQL_HOST
    || databaseUrl.port !== String(MYSQL_PORT)
    || databaseUrl.username !== MYSQL_USER
    || databaseUrl.password.length === 0
    || databaseUrl.pathname !== `/${MYSQL_DATABASE}`
    || databaseUrl.search.length > 0
    || databaseUrl.hash.length > 0
  ) {
    throw new Error("REAL_RUNTIME_MYSQL_TOPOLOGY_INVALID");
  }

  return Object.freeze({
    mysqlHost: MYSQL_HOST,
    mysqlPort: MYSQL_PORT,
    mysqlDatabase: MYSQL_DATABASE,
    backendOrigin: "http://127.0.0.1:4188",
    frontendOrigin: "http://127.0.0.1:5188"
  });
}
