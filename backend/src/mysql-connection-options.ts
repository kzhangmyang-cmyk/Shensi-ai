import type { PoolOptions } from "mysql2/promise";

const PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/u;

export interface MysqlConnectionEnvironment {
  MYSQL_SSL_MODE?: string;
  MYSQL_SSL_CA?: string;
}

export interface MysqlConnectionOverrides {
  connectionLimit?: number;
  namedPlaceholders?: boolean;
  timezone?: string;
  dateStrings?: boolean;
}

export function createMysqlConnectionOptions(
  databaseUrl: string,
  environment: MysqlConnectionEnvironment | NodeJS.ProcessEnv = process.env,
  overrides: MysqlConnectionOverrides = {}
): PoolOptions {
  const mode = environment.MYSQL_SSL_MODE?.trim().toLowerCase() || "disabled";
  let uri = databaseUrl;
  if (mode === "verify_ca") {
    const parsed = new URL(databaseUrl);
    parsed.searchParams.delete("ssl-mode");
    uri = parsed.toString();
  }
  const options: PoolOptions = {
    uri,
    connectionLimit: overrides.connectionLimit ?? 4,
    namedPlaceholders: overrides.namedPlaceholders ?? true
  };
  if (overrides.timezone !== undefined) options.timezone = overrides.timezone;
  if (overrides.dateStrings !== undefined) options.dateStrings = overrides.dateStrings;
  if (mode === "disabled") return options;
  if (mode !== "verify_ca") {
    throw new Error("MYSQL_SSL_MODE must be disabled or verify_ca");
  }
  const ca = environment.MYSQL_SSL_CA?.trim();
  if (!ca || !PEM_CERTIFICATE.test(ca)) {
    throw new Error("MYSQL_SSL_CA must contain a PEM certificate when MYSQL_SSL_MODE=verify_ca");
  }
  options.ssl = {
    ca,
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
    verifyIdentity: true
  };
  return options;
}
