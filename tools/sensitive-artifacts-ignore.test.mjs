import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sensitivePaths = [
  "artifacts/source.sql.gz",
  "artifacts/source.dump",
  "artifacts/source.backup",
  "migration-exports/raw/customers.json",
  "deploy/provider-keys/model.key",
  "backend/provider-keys/runtime.key"
];

test("sensitive migration exports and provider-key directories stay ignored", () => {
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--stdin"],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      input: `${sensitivePaths.join("\n")}\n`
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(
    result.stdout.trim().split("\n").sort(),
    sensitivePaths.toSorted()
  );

  for (const trackedSchema of [
    "backend/schema.mysql.sql",
    "backend/goodjob_crm.full.sql"
  ]) {
    const tracked = spawnSync(
      "git",
      ["ls-files", "--error-unmatch", trackedSchema],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" }
    );
    assert.equal(tracked.status, 0, `${trackedSchema} must remain tracked`);
  }
});
