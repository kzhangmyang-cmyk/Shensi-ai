import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("quality workflow covers the full pnpm, MySQL, and browser gates", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/quality.yml"),
    "utf8"
  );

  assert.match(workflow, /name:\s*Quality gates/);
  assert.match(workflow, /image:\s*mysql:8\.4/);
  assert.match(
    workflow,
    /MYSQL_TEST_ADMIN_URL:\s*mysql:\/\/root@127\.0\.0\.1:3306\/mysql/
  );
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm test:layout/);
  assert.match(workflow, /pnpm test(?:\s|$)/m);
  assert.match(workflow, /pnpm build/);
  assert.match(workflow, /pnpm test:financial-council/);
  assert.match(workflow, /pnpm --filter \.\/frontend test:e2e/);
  assert.match(workflow, /pnpm test:e2e:financial-council:real/);
  assert.doesNotMatch(workflow, /secrets\./);
});
