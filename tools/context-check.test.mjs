import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("current agent context is complete and points at shensi", () => {
  const result = spawnSync(process.execPath, ["scripts/context-check.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /SHENSI_CONTEXT_OK/u);
});
