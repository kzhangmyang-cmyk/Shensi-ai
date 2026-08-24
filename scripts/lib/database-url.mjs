export function parseMysqlUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "mysql:") throw new Error("MYSQL_URL_PROTOCOL_INVALID");
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!url.hostname || !url.username || !database) throw new Error("MYSQL_URL_INCOMPLETE");
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database
  };
}

export function requireDistinctDatabases(source, target) {
  if (source === target) throw new Error("SOURCE_TARGET_DATABASE_MATCH");
}

export function mysqlCliEnvironment(parsed, baseEnv = process.env) {
  return { ...baseEnv, MYSQL_PWD: parsed.password };
}
