import assert from "node:assert/strict";
import test from "node:test";

type PackageContentPolicy = {
  findDeveloperAbsolutePath?: (value: string) => string | null;
};

const policyUrl = new URL("../scripts/package-content-policy.mjs", import.meta.url).href;
const policy = await import(policyUrl).catch(() => ({})) as PackageContentPolicy;

test("developer-path scanning permits variable WSL homes", () => {
  assert.equal(typeof policy.findDeveloperAbsolutePath, "function");
  if (!policy.findDeveloperAbsolutePath) return;

  const playwrightScript = String.raw`if [ ! -f "/home/$Username/node/bin/node" ]; then
  mkdir -p /home/$Username/node
fi`;
  assert.equal(policy.findDeveloperAbsolutePath(playwrightScript), null);
  assert.equal(policy.findDeveloperAbsolutePath("/home/${USER}/portable-cache"), null);
});

test("developer-path scanning rejects concrete macOS and Linux home paths in content or link targets", () => {
  assert.equal(typeof policy.findDeveloperAbsolutePath, "function");
  if (!policy.findDeveloperAbsolutePath) return;

  assert.equal(
    policy.findDeveloperAbsolutePath("source=/Users/buildbot/private/repository"),
    "/Users/buildbot/",
  );
  assert.equal(
    policy.findDeveloperAbsolutePath("../../../../home/runner/private/repository"),
    "/home/runner/",
  );
});
