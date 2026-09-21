import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("explicit fresh-runtime environment does not inherit repository dotenv configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-local-env-"));
  try {
    await mkdir(join(root, "backend", "src"), { recursive: true });
    const module = join(root, "backend", "src", "runtime-env.mjs");
    await writeFile(module, await readFile(new URL("./runtime-env.ts", import.meta.url)));
    await writeFile(join(root, ".env"), "SHENSI_ENV_PROBE=old-runtime\n");
    const run = (skip: string) => execFileSync(process.execPath,
      ["--input-type=module", "-e", "import {loadLocalEnv} from './backend/src/runtime-env.mjs'; loadLocalEnv(); process.stdout.write(process.env.SHENSI_ENV_PROBE ?? 'empty');"],
      { cwd: root, env: { SHENSI_SKIP_LOCAL_ENV: skip }, encoding: "utf8" });
    assert.equal(run("true"), "empty");
    assert.equal(run("false"), "old-runtime");
  } finally { await rm(root, { recursive: true, force: true }); }
});
