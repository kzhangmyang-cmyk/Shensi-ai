import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const exists = async (filePath) => access(filePath).then(
  () => true,
  () => false
);

test("repository exposes the approved monorepo layout", async () => {
  const workspace = await readFile("pnpm-workspace.yaml", "utf8");
  assert.match(workspace, /- backend/u);
  assert.match(workspace, /- frontend/u);
  assert.match(workspace, /- contracts/u);
  assert.equal(await exists("backend/src/server.ts"), true);
  assert.equal(await exists("frontend/src/main.tsx"), true);
  assert.equal(await exists("contracts/package.json"), true);
  assert.equal(await exists("package-lock.json"), false);
  assert.equal(await exists("debug-agents.mts"), false);
  assert.equal(await exists("frontend/debug-agents.mts"), false);
});

test("real council E2E resolves the backend from this monorepo", async () => {
  const config = await readFile(
    "frontend/playwright.financial-council-real.config.ts",
    "utf8"
  );
  assert.doesNotMatch(config, /GoodJob-growth/u);
  assert.match(config, /import\.meta\.url/u);
});
