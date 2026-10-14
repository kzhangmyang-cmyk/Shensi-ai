import assert from "node:assert/strict";
import { constants } from "node:fs";
import { link, mkdtemp, open, readFile, readdir, realpath, rm, symlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPrivateFile, removePrivateFile, writePrivateFile } from "../src/main/private-storage.ts";

test("atomic storage fsyncs new parent, unpublished file and published directory in durable order", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shensi-storage-durability-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalSync = prototype.sync;
  await probe.close();
  const directory = join(root, "store"); const events: string[] = [];
  t.mock.method(prototype, "sync", async function(this: FileHandle) {
    const info = await this.stat();
    if (info.isFile()) {
      events.push("unpublished-file");
      await assert.rejects(readFile(join(directory, "value.json")), { code: "ENOENT" });
    } else {
      events.push((await readdir(root)).includes("store") && (await readdir(directory)).includes("value.json") ? "published-directory" : "new-parent");
    }
    return originalSync.call(this);
  });
  await writePrivateFile(directory, "value.json", "first", true);
  assert.deepEqual(events, ["new-parent", "unpublished-file", "published-directory"]);
});

test("file fsync failure preserves old value and removes unpublished temp file; deletion fsyncs its directory", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shensi-storage-interruption-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "store");
  await writePrivateFile(directory, "value.json", "first");
  const probe = await open(join(directory, "value.json"), "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle; const originalSync = prototype.sync;
  await probe.close();
  let directorySyncs = 0;
  t.mock.method(prototype, "sync", async function(this: FileHandle) {
    if ((await this.stat()).isFile()) throw Error("injected-file-fsync-failure");
    directorySyncs++; return originalSync.call(this);
  });
  await assert.rejects(writePrivateFile(directory, "value.json", "replacement"), /injected-file-fsync-failure/u);
  assert.equal(await readPrivateFile(directory, "value.json"), "first");
  assert.deepEqual(await readdir(directory), ["value.json"]);
  await removePrivateFile(directory, "value.json");
  assert.equal(directorySyncs, 1);
  assert.equal(await readPrivateFile(directory, "value.json"), null);
});

test("storage refuses symlink ancestors and hardlinked files without changing their targets", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shensi-storage-links-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "store"); await writePrivateFile(directory, "value.json", "original");
  await link(join(directory, "value.json"), join(root, "external"));
  await assert.rejects(readPrivateFile(directory, "value.json"));
  await assert.rejects(writePrivateFile(directory, "value.json", "replacement"));
  await assert.rejects(removePrivateFile(directory, "value.json"));
  await symlink(root, join(root, "alias"));
  await assert.rejects(writePrivateFile(join(root, "alias", "store"), "another.json", "forbidden"));
  assert.equal(await readFile(join(root, "external"), "utf8"), "original");
});
