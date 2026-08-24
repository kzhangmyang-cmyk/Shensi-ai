import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("shensi is the canonical standalone repository", () => {
  assert.equal(basename(root), "shensi");
  for (const path of [
    "frontend/package.json",
    "backend/package.json",
    "contracts/package.json",
    "docs/SOURCE_PROVENANCE.md"
  ]) assert.equal(existsSync(resolve(root, path)), true, path);
  assert.doesNotMatch(readFileSync(resolve(root, ".gitignore"), "utf8"), /!\.env\.production\.local/u);
});
