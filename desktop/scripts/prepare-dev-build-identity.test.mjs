import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSourceContentManifest } from "../../scripts/source-content-manifest.mjs";
import { readDevelopmentDesktopBuildIdentity } from "../src/main/desktop-build-identity.ts";
import { prepareDevelopmentBuildIdentity, startDevelopmentDesktop } from "./prepare-dev-build-identity.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "shensi-dev-producer-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createSourceContentManifest(repository, "desktop-app");
  for (const record of source.records) {
    const destination = path.join(root, record.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(repository, record.path)), { mode: record.mode });
  }
  return root;
}

test("producer derives path and digest only from real canonical desktop-app inputs and uses exact owner modes", async (t) => {
  const root = await fixture(t);
  const source = await createSourceContentManifest(root, "desktop-app");
  const file = await prepareDevelopmentBuildIdentity(root);
  assert.equal(file, path.join(root, ".runtime", "desktop-dev", source.rootHash, "desktop-build-manifest.json"));
  const text = await readFile(file, "utf8"); const manifest = JSON.parse(text);
  assert.deepEqual(manifest, { version: 1, kind: "development", sourceRootHash: source.rootHash, records: source.records, architecture: process.arch, bundleId: "com.shensi.desktop" });
  assert.equal(text, `${JSON.stringify(manifest)}\n`);
  assert.equal((await lstat(file)).mode & 0o7777, 0o644);
  for (const directory of [path.join(root, ".runtime"), path.join(root, ".runtime/desktop-dev"), path.dirname(file)]) assert.equal((await lstat(directory)).mode & 0o7777, 0o700);
  const digest = createHash("sha256").update(text).digest("hex");
  assert.equal(await readDevelopmentDesktopBuildIdentity(root, file), digest);
  await writeFile(path.join(root, "desktop/src/main/main.ts"), "changed source");
  const next = await prepareDevelopmentBuildIdentity(root);
  assert.notEqual(next, file);
  assert.notEqual(await readDevelopmentDesktopBuildIdentity(root, next), digest);
});

test("producer rejects unsafe owner roots and cannot follow a symlink or replace existing identity", async (t) => {
  const root = await fixture(t);
  const runtime = path.join(root, ".runtime");
  await mkdir(runtime, { mode: 0o775 });
  await chmod(runtime, 0o775);
  await assert.rejects(prepareDevelopmentBuildIdentity(root), /desktop_dev_build_identity_invalid/u);
  await chmod(runtime, 0o700);
  const elsewhere = path.join(root, "elsewhere"); await mkdir(elsewhere, { mode: 0o700 });
  await symlink(elsewhere, path.join(runtime, "desktop-dev"));
  await assert.rejects(prepareDevelopmentBuildIdentity(root), /desktop_dev_build_identity_invalid/u);
  assert.deepEqual(await import("node:fs/promises").then((fs) => fs.readdir(elsewhere)), []);
});

test("same-source restart reuses exact immutable identity without writes but refuses corrupt or extra owner-root contents", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, ".runtime"), { mode: 0o755 });
  await chmod(path.join(root, ".runtime"), 0o755);
  const file = await prepareDevelopmentBuildIdentity(root);
  const before = await lstat(file);
  assert.equal(await prepareDevelopmentBuildIdentity(root), file);
  assert.equal((await lstat(file)).mtimeMs, before.mtimeMs);
  assert.equal((await lstat(path.join(root, ".runtime"))).mode & 0o7777, 0o755);
  await writeFile(path.join(path.dirname(file), "unexpected"), "not owned");
  await assert.rejects(prepareDevelopmentBuildIdentity(root), /desktop_dev_build_identity_invalid/u);
  await rm(path.join(path.dirname(file), "unexpected"));
  await writeFile(file, "corrupt");
  await assert.rejects(prepareDevelopmentBuildIdentity(root), /desktop_dev_build_identity_invalid/u);
  assert.equal(await readFile(file, "utf8"), "corrupt");
});

test("producer starts only Electron with its validated absolute path and never propagates a caller digest or Vite origin", async (t) => {
  const root = await fixture(t);
  const calls = [];
  const result = await startDevelopmentDesktop({ repositoryRoot: root, electronExecutable: "/fake/electron", environment: {
    SHENSI_DESKTOP_BUILD_MANIFEST_SHA256: "attacker", SHENSI_DESKTOP_DEV_BUILD_MANIFEST_PATH: "/outside/attacker.json",
    SHENSI_RENDERER_DEV_ORIGIN: "http://127.0.0.1:5188", SHENSI_REMOTE_ORIGIN: "http://127.0.0.1:5608",
  }, spawnProcess: (...args) => { calls.push(args); return "fake-child"; } });
  assert.equal(result, "fake-child"); assert.equal(calls.length, 1);
  const [executable, argv, options] = calls[0];
  assert.equal(executable, "/fake/electron"); assert.deepEqual(argv, ["dist/main/main.js"]);
  assert.equal(options.cwd, path.join(root, "desktop"));
  assert.equal(options.shell, false);
  assert.equal(options.detached, true);
  const manifestPath = options.env.SHENSI_DESKTOP_DEV_BUILD_MANIFEST_PATH;
  assert.match(await readDevelopmentDesktopBuildIdentity(root, manifestPath), /^[a-f0-9]{64}$/u);
  assert.deepEqual(options.env, { SHENSI_REMOTE_ORIGIN: "http://127.0.0.1:5608", SHENSI_DESKTOP_DEV_BUILD_MANIFEST_PATH: manifestPath });
});
