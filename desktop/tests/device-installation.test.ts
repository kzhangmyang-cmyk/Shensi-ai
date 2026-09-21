import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeviceInstallationStore, createProcessInstanceId } from "../src/main/device-installation.ts";

test("installation persists one 32-byte identity across concurrent instances and restart, never process identity", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shensi-installation-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "installation");
  const ids = await Promise.all(Array.from({ length: 8 }, () => createDeviceInstallationStore(directory).getOrCreateInstallationId()));
  assert.equal(new Set(ids).size, 1);
  assert.match(ids[0], /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(Buffer.from(ids[0], "base64url").length, 32);
  assert.equal(await createDeviceInstallationStore(directory).getOrCreateInstallationId(), ids[0]);
  const processIds = [createProcessInstanceId(), createProcessInstanceId()];
  assert.equal(new Set([...processIds, ids[0]]).size, 3);
  processIds.forEach((id) => assert.match(id, /^[A-Za-z0-9_-]{43}$/u));
  const files = await readdir(directory);
  assert.deepEqual(files, ["installation.json"]);
  const path = join(directory, files[0]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { installationId: ids[0], protocolVersion: 1 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test("installation rejects corrupt metadata, extra keys, unsafe permissions and symlinks without replacement", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shensi-installation-invalid-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createDeviceInstallationStore(join(root, "installation"));
  await store.getOrCreateInstallationId();
  const path = join(root, "installation", "installation.json");
  for (const content of ["{", JSON.stringify({ installationId: "a".repeat(43), protocolVersion: 2 }), JSON.stringify({ installationId: "a".repeat(43), protocolVersion: 1, processInstanceId: "secret" })]) {
    await writeFile(path, content);
    await assert.rejects(store.getOrCreateInstallationId());
    assert.equal(await readFile(path, "utf8"), content);
  }
  await writeFile(path, JSON.stringify({ installationId: "A".repeat(43), protocolVersion: 1 }));
  await chmod(path, 0o644);
  await assert.rejects(store.getOrCreateInstallationId());
  await rm(path);
  const external = join(root, "external.json");
  await writeFile(external, "untouched", { mode: 0o600 });
  await symlink(external, path);
  await assert.rejects(store.getOrCreateInstallationId());
  assert.equal(await readFile(external, "utf8"), "untouched");
  await symlink(join(root, "installation"), join(root, "linked"));
  await assert.rejects(createDeviceInstallationStore(join(root, "linked")).getOrCreateInstallationId());
});
