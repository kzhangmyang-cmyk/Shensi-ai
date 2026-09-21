import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./cloud-test-secret-ingest.mjs", import.meta.url));

async function run(kind, input) {
  const root = await mkdtemp(join(tmpdir(), "shensi-cloud-secret-"));
  const result = spawnSync(process.execPath, [script, kind], {
    input,
    encoding: "utf8",
    env: { ...process.env, SHENSI_CLOUD_TEST_RUNTIME_ROOT: root }
  });
  return { root, result };
}

test("stores an Aiven URL owner-only without echoing it", async () => {
  const secret = "mysql://avnadmin:secret@example.aivencloud.com:14114/defaultdb?ssl-mode=REQUIRED";
  const { root, result } = await run("database-url", secret);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes(secret), false);
  const path = join(root, "secrets", "database_url");
  assert.equal((await readFile(path, "utf8")).trim(), secret);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("stores a PEM CA owner-only", async () => {
  const certificate = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----";
  const { root, result } = await run("ca", certificate);
  assert.equal(result.status, 0);
  const path = join(root, "secrets", "mysql_ca.pem");
  assert.equal((await readFile(path, "utf8")).trim(), certificate);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("rejects non-Aiven URLs and malformed certificates", async () => {
  for (const [kind, value] of [
    ["database-url", "mysql://user:secret@localhost:3306/db"],
    ["ca", "not-a-certificate"]
  ]) {
    const { result } = await run(kind, value);
    assert.notEqual(result.status, 0);
  }
});
