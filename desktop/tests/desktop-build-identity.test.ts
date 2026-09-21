import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { decodeDesktopBuildManifest, readDesktopBuildIdentity, readDevelopmentDesktopBuildIdentity } from "../src/main/desktop-build-identity.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const packaged = { version: 1, kind: "packaged", sourceRootHash: "a".repeat(64), rendererSha256: "b".repeat(64), mainSha256: "c".repeat(64), sidecarSha256: "d".repeat(64), runtimeConfigSha256: "e".repeat(64), architecture: "arm64", bundleId: "com.shensi.desktop" };
const bytes = (value: unknown) => `${JSON.stringify(value)}\n`;
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "shensi-build-id-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "desktop-build-manifest.json");
  await fs.writeFile(file, bytes(packaged), { mode: 0o644 });
  return { root, file };
}

test("packaged reader hashes exact canonical bytes once and retains the immutable value", async (t) => {
  const { root, file } = await fixture(t);
  const digest = await readDesktopBuildIdentity(root);
  assert.equal(digest, hash(bytes(packaged)));
  await fs.writeFile(file, bytes({ ...packaged, mainSha256: "f".repeat(64) }));
  assert.equal(digest, hash(bytes(packaged)));
  assert.notEqual(await readDesktopBuildIdentity(root), digest);
});

test("packaged reader rejects missing, symlinked, non-regular, hardlinked and every non-0644 file mode", async (t) => {
  const { root, file } = await fixture(t);
  for (const mode of [0o600, 0o444, 0o664, 0o646, 0o755, 0o1644]) {
    await fs.chmod(file, mode);
    await assert.rejects(readDesktopBuildIdentity(root), /desktop_build_identity_invalid/u);
  }
  await fs.chmod(file, 0o644);
  await fs.link(file, path.join(root, "hardlink"));
  await assert.rejects(readDesktopBuildIdentity(root), /desktop_build_identity_invalid/u);
  await fs.unlink(file);
  await assert.rejects(readDesktopBuildIdentity(root), /desktop_build_identity_invalid/u);
  await fs.symlink(path.join(root, "hardlink"), file);
  await assert.rejects(readDesktopBuildIdentity(root), /desktop_build_identity_invalid/u);
  await fs.unlink(file); await fs.mkdir(file);
  await assert.rejects(readDesktopBuildIdentity(root), /desktop_build_identity_invalid/u);
  await fs.symlink(root, path.join(root, "alias"));
  await assert.rejects(readDesktopBuildIdentity(path.join(root, "alias")), /desktop_build_identity_invalid/u);
});

test("shared decoder rejects noncanonical bytes and unknown or malformed fields", () => {
  for (const text of [JSON.stringify(packaged), ` ${bytes(packaged)}`, bytes({ ...packaged, extra: true }), bytes({ ...packaged, version: 2 }), bytes({ ...packaged, mainSha256: "F".repeat(64) }), bytes({ ...packaged, architecture: "unknown" }), bytes({ ...packaged, bundleId: "" }), "{}\n"]) {
    assert.throws(() => decodeDesktopBuildManifest(text), /desktop_build_identity_invalid/u);
  }
});

test("reader rejects a manifest changed during the single descriptor read", async (t) => {
  const { root, file } = await fixture(t);
  const original = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: any[]) => {
        const result = await (read as any)(...readArgs);
        await fs.chmod(file, 0o600);
        return result;
      }) as typeof handle.read;
    }
    return handle;
  });
  await assert.rejects(readDesktopBuildIdentity(root), /desktop_build_identity_invalid/u);
});

test("development identity is source-hash-bound and accepted only beneath its owner-only canonical root", async (t) => {
  const { root } = await fixture(t);
  const record = { path: "desktop/src/main/main.ts", mode: 420, size: 0, sha256: hash("") };
  const sourceRootHash = hash(`${record.path}\0${record.mode}\0${record.size}\0${record.sha256}\n`);
  const manifest = { version: 1, kind: "development", sourceRootHash, records: [record], architecture: "arm64", bundleId: "com.shensi.desktop" };
  const runtime = path.join(root, ".runtime"); const dev = path.join(runtime, "desktop-dev"); const owner = path.join(dev, sourceRootHash);
  for (const directory of [runtime, dev, owner]) await fs.mkdir(directory, { mode: 0o700 });
  const file = path.join(owner, "desktop-build-manifest.json");
  await fs.writeFile(file, bytes(manifest), { mode: 0o644 });
  assert.equal(await readDevelopmentDesktopBuildIdentity(root, file), hash(bytes(manifest)));
  await fs.chmod(runtime, 0o755);
  assert.equal(await readDevelopmentDesktopBuildIdentity(root, file), hash(bytes(manifest)));
  await assert.rejects(readDesktopBuildIdentity(owner), /desktop_build_identity_invalid/u);
  await assert.rejects(readDevelopmentDesktopBuildIdentity(root, path.join(root, "desktop-build-manifest.json")), /desktop_build_identity_invalid/u);
  await assert.rejects(readDevelopmentDesktopBuildIdentity(root, path.relative(root, file)), /desktop_build_identity_invalid/u);
  for (const changed of [{ ...manifest, sourceRootHash: "f".repeat(64) }, { ...manifest, records: [{ ...record, size: 1 }] }, { ...manifest, records: [record, record] }, { ...manifest, records: [{ ...record, path: "../escape" }] }]) {
    assert.throws(() => decodeDesktopBuildManifest(bytes(changed)), /desktop_build_identity_invalid/u);
  }
  await fs.chmod(owner, 0o755);
  await assert.rejects(readDevelopmentDesktopBuildIdentity(root, file), /desktop_build_identity_invalid/u);
});
