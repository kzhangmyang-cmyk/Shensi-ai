import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

type PackageContentPolicy = {
  findDeveloperAbsolutePath?: (value: string) => string | null;
  isReviewedVendorPathExample?: (relativePath: string, bytes: Uint8Array) => boolean;
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

test("reviewed vendor path examples require the exact packaged path and unchanged bytes", async () => {
  assert.equal(typeof policy.isReviewedVendorPathExample, "function");
  if (!policy.isReviewedVendorPathExample) return;
  const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
  const bytes = await readFile(path.join(path.dirname(requireBackend.resolve("typescript")), "lib.es2020.bigint.d.ts"));
  const name = "backend/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2020.bigint.d.ts";
  assert.equal(policy.isReviewedVendorPathExample(name, bytes), true);
  assert.equal(policy.isReviewedVendorPathExample(name, Buffer.concat([bytes, Buffer.from("\nchanged")])), false);
  assert.equal(policy.isReviewedVendorPathExample(name.replace("5.9.3", "5.9.4"), bytes), false);
  assert.equal(policy.isReviewedVendorPathExample(`other/${name}`, bytes), false);
  assert.equal(policy.isReviewedVendorPathExample("backend/dist/server.js", bytes), false);
  assert.equal(policy.isReviewedVendorPathExample(name, Buffer.from("/Users/mac/private/project")), false);
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
