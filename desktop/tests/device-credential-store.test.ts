import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createDeviceCredentialStore, type DesktopWorkspaceCredential, type SafeStorage } from "../src/main/device-credential-store.ts";

function encryption(): SafeStorage {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
    }
  };
}
const credential = (workspaceId = "workspace-one"): DesktopWorkspaceCredential => ({
  workspaceId, deviceToken: "A".repeat(43), protocolVersion: 1,
  bindings: [{ accountId: "account-one", bindingGeneration: 1 }]
});
test("registered workspace listing survives restart without a plaintext index", async (t) => {
  const { directory, safeStorage, store } = await fixture(t);
  assert.deepEqual(await store.registeredWorkspaceIds(), []);
  await store.save(credential("workspace-two"));
  await store.save(credential("workspace-one"));
  const restarted = createDeviceCredentialStore({ directory, safeStorage });
  assert.deepEqual(await restarted.registeredWorkspaceIds(), ["workspace-one", "workspace-two"]);
  assert.equal((await readdir(directory)).length, 2);
  await store.remove("workspace-one");
  assert.deepEqual(await restarted.registeredWorkspaceIds(), ["workspace-two"]);
  await writeFile(join(directory, "unexpected.json"), "{}", { mode: 0o600 });
  await assert.rejects(restarted.registeredWorkspaceIds());
});
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shensi-credential-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "credentials"); const safeStorage = encryption();
  return { root, directory, safeStorage, store: createDeviceCredentialStore({ directory, safeStorage }) };
}

test("credentials encrypt the whole record, isolate workspaces, update bindings and survive restart", async (t) => {
  const { directory, safeStorage, store } = await fixture(t);
  assert.equal(await store.load("missing"), null);
  await Promise.all([store.save(credential()), store.save(credential("workspace-two"))]);
  await store.recordBinding("workspace-one", { accountId: "account-one", bindingGeneration: 2 });
  await store.recordBinding("workspace-one", { accountId: "account-two", bindingGeneration: 1 });
  const restarted = createDeviceCredentialStore({ directory, safeStorage });
  assert.deepEqual((await restarted.load("workspace-one"))?.bindings, [
    { accountId: "account-one", bindingGeneration: 2 }, { accountId: "account-two", bindingGeneration: 1 }
  ]);
  assert.deepEqual(await restarted.load("workspace-two"), credential("workspace-two"));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const files = await readdir(directory);
  assert.equal(files.length, 2);
  for (const file of files) {
    const path = join(directory, file); const text = await readFile(path, "utf8");
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["ciphertext", "version"]);
    for (const secret of ["workspace-", "account-", "A".repeat(43), "bindings"]) assert.ok(!text.includes(secret));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  await restarted.remove("workspace-one");
  assert.equal(await store.load("workspace-one"), null);
  assert.deepEqual(await store.load("workspace-two"), credential("workspace-two"));
});

test("credential validation refuses unsafe schemas and binding regression without changing ciphertext", async (t) => {
  const { directory, store } = await fixture(t);
  await store.save(credential());
  const path = join(directory, (await readdir(directory))[0]); const original = await readFile(path, "utf8");
  for (const value of [
    { ...credential(), deviceToken: "short" }, { ...credential(), protocolVersion: 2 },
    { ...credential(), accountHandle: "forbidden" }, { ...credential(), workspaceId: "" },
    { ...credential(), bindings: [...credential().bindings, ...credential().bindings] },
    { ...credential(), bindings: [{ accountId: "one", bindingGeneration: 0 }] },
    { ...credential(), bindings: [{ accountId: "one", bindingGeneration: 1, token: "forbidden" }] }
  ]) await assert.rejects(store.save(value as DesktopWorkspaceCredential));
  await assert.rejects(store.recordBinding("missing", { accountId: "one", bindingGeneration: 1 }));
  await store.recordBinding("workspace-one", { accountId: "account-one", bindingGeneration: 2 });
  await assert.rejects(store.recordBinding("workspace-one", { accountId: "account-one", bindingGeneration: 1 }));
  assert.notEqual(await readFile(path, "utf8"), original);
  assert.equal((await store.load("workspace-one"))?.bindings[0].bindingGeneration, 2);
});

test("credential reads reject corrupt, wrong-workspace and noncanonical plaintext plus envelope extra keys", async (t) => {
  const { directory, safeStorage, store } = await fixture(t);
  await store.save(credential()); const path = join(directory, (await readdir(directory))[0]);
  const original = await readFile(path, "utf8");
  for (const value of ["{", JSON.stringify({ ...JSON.parse(original), version: 2 }), JSON.stringify({ ...JSON.parse(original), token: "forbidden" }), JSON.stringify({ version: 1, ciphertext: "bad!" }), JSON.stringify({ version: 1, ciphertext: Buffer.from("corrupt").toString("base64") }),
    JSON.stringify({ version: 1, ciphertext: safeStorage.encryptString(JSON.stringify(credential("another-workspace"))).toString("base64") }),
    JSON.stringify({ version: 1, ciphertext: safeStorage.encryptString(JSON.stringify({ ...credential(), content: "forbidden" })).toString("base64") }),
    JSON.stringify({ version: 1, ciphertext: safeStorage.encryptString(JSON.stringify(credential(), null, 2)).toString("base64") })
  ]) { await writeFile(path, value); await assert.rejects(store.load("workspace-one")); }
});

test("credentials fail closed without safeStorage and refuse unsafe files/directories on read and replacement", async (t) => {
  const { root, directory, safeStorage, store } = await fixture(t);
  await store.save(credential()); const path = join(directory, (await readdir(directory))[0]);
  const original = await readFile(path, "utf8");
  const unavailable = createDeviceCredentialStore({ directory, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
  await assert.rejects(unavailable.save(credential())); await assert.rejects(unavailable.load("workspace-one"));
  const failing = createDeviceCredentialStore({ directory, safeStorage: { ...safeStorage, encryptString() { throw Error("seeded-sensitive-error"); } } });
  await assert.rejects(failing.save(credential()), (error: Error) => !error.message.includes("seeded-sensitive-error"));
  assert.equal(await readFile(path, "utf8"), original);
  await chmod(path, 0o640);
  await assert.rejects(store.load("workspace-one")); await assert.rejects(store.save(credential()));
  await chmod(path, 0o4600);
  await assert.rejects(store.load("workspace-one")); await assert.rejects(store.save(credential()));
  await chmod(path, 0o600); await chmod(directory, 0o750);
  await assert.rejects(store.load("workspace-one")); await chmod(directory, 0o700);
  await chmod(directory, 0o1700);
  await assert.rejects(store.load("workspace-one")); await chmod(directory, 0o700);
  const external = join(root, "external"); await writeFile(external, original, { mode: 0o600 });
  await rm(path); await symlink(external, path);
  await assert.rejects(store.load("workspace-one")); await assert.rejects(store.save(credential())); await assert.rejects(store.remove("workspace-one"));
  assert.equal(await readFile(external, "utf8"), original);
});
