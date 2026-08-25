import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "../backend/node_modules/mysql2/promise.js";

const socketPath = process.env.MYSQL_TEST_ADMIN_SOCKET?.trim()
  || "/Users/mac/.local/var/mysql-shensi-sales/mysql.sock";
const ownedPrefixes = [
  "shensi_task10_",
  "goodjob_social_",
  "goodjob_social_account_",
  "goodjob_douyin_automation_",
  "goodjob_crawler_",
  "goodjob_douyin_ingestion_",
  "goodjob_outreach_batch_"
];

function run(command, argumentsList, environment, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, { stdio: "inherit", env: environment, cwd });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`TASK10_MYSQL_GATE_FAILED:${signal ?? code}`));
    });
  });
}

async function main() {
  const root = await mysql.createConnection({ user: "root", socketPath, database: "mysql" });
  const suffix = randomBytes(8).toString("hex");
  const username = `task10_${suffix}`;
  const password = randomBytes(48).toString("base64url");
  const runtimeRoot = mkdtempSync(join(tmpdir(), "shensi-task10-runtime-"));
  const serviceSecretFile = join(runtimeRoot, "mediacrawler-service-secret");
  const stateDirectory = join(runtimeRoot, "encrypted-state");
  writeFileSync(serviceSecretFile, randomBytes(48).toString("base64url"), { mode: 0o600 });
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  let userCreated = false;
  const [initialSchemaRows] = await root.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA");
  const initialSchemas = new Set(initialSchemaRows.map((row) => String(row.SCHEMA_NAME)));
  try {
    const [portRows] = await root.query("SELECT @@port AS port");
    const port = Number(portRows[0]?.port || 3306);
    await root.query(`CREATE USER '${username}'@'127.0.0.1' IDENTIFIED BY ?`, [password]);
    userCreated = true;
    for (const prefix of ownedPrefixes) {
      const escaped = prefix.replaceAll("_", "\\_");
      await root.query(`GRANT ALL PRIVILEGES ON \`${escaped}%\`.* TO '${username}'@'127.0.0.1'`);
    }
    const adminUrl = `mysql://${username}:${encodeURIComponent(password)}@127.0.0.1:${port}/`;
    const runtimeSecurity = randomBytes(48).toString("base64url");
    const environment = {
      ...process.env,
      MYSQL_TEST_ADMIN_URL: adminUrl,
      NODE_ENV: "test",
      TZ: "UTC",
      JWT_SECRET: runtimeSecurity,
      PROVIDER_CREDENTIAL_KEY: runtimeSecurity,
      AGENT_JOB_ENCRYPTION_KEY: runtimeSecurity,
      ACQUISITION_MASTER_SECRET: runtimeSecurity,
      MEDIACRAWLER_SERVICE_SECRET_FILE: serviceSecretFile,
      MEDIACRAWLER_ENCRYPTED_VOLUME: stateDirectory,
      MEDIACRAWLER_BASE_URL: "http://127.0.0.1:5491",
      UV_CACHE_DIR: "/private/tmp/shensi-task10-uv-cache"
    };
    const browser = process.argv.includes("--browser");
    if (browser) {
      await run("pnpm", ["--filter", "./frontend", "test:e2e:douyin-mediacrawler:real"], environment);
    } else {
      await run("node", ["--import", "tsx", "--test", "--test-concurrency=1",
        "src/douyin-mediacrawler-mysql-integration-test.ts",
        "src/acquisition-social-account-mysql-repository-test.ts",
        "src/acquisition-outreach-batch-mysql-repository-test.ts"
      ], environment, `${process.cwd()}/backend`);
    }
    console.log(browser ? "TASK10_BROWSER_GATE_OK" : "TASK10_MYSQL_GATE_OK");
  } finally {
    const [rows] = await root.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA");
    for (const row of rows) {
      const database = String(row.SCHEMA_NAME);
      if (!initialSchemas.has(database)
        && ownedPrefixes.some((prefix) => database.startsWith(prefix))) {
        await root.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
    }
    if (userCreated) await root.query(`DROP USER IF EXISTS '${username}'@'127.0.0.1'`);
    await root.end();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
