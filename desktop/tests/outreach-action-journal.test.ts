import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createOutreachActionJournalStore, type OutreachActionRecoveryRecord } from "../src/main/outreach-action-journal.ts";

const record = (accountId = "account-one", actionId = "action-one"): OutreachActionRecoveryRecord => ({
  version: 1, actionId, workspaceId: "workspace-one", accountId, requestHash: "a".repeat(64),
  leaseVersion: 1, bindingGeneration: 1, loginStateVersion: 1, phase: "claimed", receiptHash: null,
  updatedAt: "2026-09-05T00:00:00.000Z"
});
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shensi-journal-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "journal");
  return { root, directory, store: createOutreachActionJournalStore(directory) };
}

test("journal permits two independent account lanes, refuses competing actions and third lanes across restart", async (t) => {
  const { directory, store } = await fixture(t);
  assert.deepEqual(await store.list(), []);
  const attempts = await Promise.allSettled([store.save(record()), createOutreachActionJournalStore(directory).save(record("account-two", "action-two")), store.save(record("account-three", "action-three"))]);
  assert.equal(attempts.filter((value) => value.status === "fulfilled").length, 2);
  const restarted = createOutreachActionJournalStore(directory);
  assert.equal((await restarted.list()).length, 2);
  await assert.rejects(restarted.save(record("account-one", "different-action")));
  await assert.rejects(restarted.save(record("account-three", "action-three")));
  const paths = await readdir(directory);
  assert.equal(paths.length, 2);
  for (const filename of paths) {
    assert.match(filename, /^[a-f0-9]{64}\.json$/u);
    assert.equal((await stat(join(directory, filename))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test("journal advances only monotonically with an immutable fence and retains exact receipt until fenced cleanup", async (t) => {
  const { directory, store } = await fixture(t);
  await store.save(record());
  const started = { ...record(), phase: "central_started" as const };
  await store.save(started);
  await assert.rejects(store.save(record()));
  for (const change of [{ actionId: "changed" }, { workspaceId: "changed" }, { requestHash: "b".repeat(64) }, { leaseVersion: 2 }, { bindingGeneration: 2 }, { loginStateVersion: 2 }, { updatedAt: "2026-09-04T00:00:00.000Z" }]) {
    await assert.rejects(store.save({ ...started, ...change }));
  }
  const completed = { ...started, phase: "sidecar_completed" as const, receiptHash: "c".repeat(64) };
  await store.save(completed); await store.save(completed);
  await assert.rejects(store.save({ ...completed, receiptHash: "d".repeat(64) }));
  const restarted = createOutreachActionJournalStore(directory);
  assert.deepEqual(await restarted.load("account-one"), completed);
  await assert.rejects(restarted.remove("account-one", { actionId: "action-one", requestHash: "a".repeat(64), receiptHash: "d".repeat(64) }));
  assert.deepEqual(await restarted.load("account-one"), completed);
  await restarted.remove("account-one", { actionId: "action-one", requestHash: "a".repeat(64), receiptHash: "c".repeat(64) });
  assert.equal(await restarted.load("account-one"), null);
  await restarted.save(record("account-one", "next-action"));
  await assert.rejects(restarted.remove("account-one", { actionId: "next-action", requestHash: "a".repeat(64), receiptHash: "c".repeat(64) }));
});

test("unstarted release removes only the exact claimed lease and cannot clear started or another lane", async (t) => {
  const { directory, store } = await fixture(t);
  await store.save(record()); await store.save(record("account-two", "action-two"));
  const fence = { actionId: "action-one", requestHash: "a".repeat(64), leaseVersion: 1 };
  for (const change of [{ actionId: "other" }, { requestHash: "b".repeat(64) },
    { leaseVersion: 2 }, { leaseVersion: 0 }, { receiptHash: "b".repeat(64) }]) {
    await assert.rejects(store.releaseUnstarted("account-one", { ...fence, ...change }));
  }
  assert.deepEqual(await store.load("account-one"), record());
  const restarted = createOutreachActionJournalStore(directory);
  await restarted.releaseUnstarted("account-one", fence);
  await restarted.releaseUnstarted("account-one", fence);
  assert.equal(await store.load("account-one"), null);
  assert.deepEqual(await store.load("account-two"), record("account-two", "action-two"));
  await store.save({ ...record(), leaseVersion: 2 });
  await assert.rejects(restarted.releaseUnstarted("account-one", fence));
  await store.save({ ...record(), leaseVersion: 2, phase: "central_started" });
  await assert.rejects(store.releaseUnstarted("account-one", { ...fence, leaseVersion: 2 }));
  await store.save({ ...record(), leaseVersion: 2, phase: "sidecar_completed", receiptHash: "c".repeat(64) });
  await assert.rejects(store.releaseUnstarted("account-one", { ...fence, leaseVersion: 2 }));
});

test("journal rejects secrets, malformed persisted records, wrong filenames and duplicate actions across lanes", async (t) => {
  const { directory, store } = await fixture(t);
  await store.save(record());
  for (const field of ["content", "targetUrl", "accountHandle", "processInstanceId", "deviceToken", "taskToken", "cookie", "profilePath", "platformMessage"]) {
    await assert.rejects(store.save({ ...record(), [field]: "forbidden" }));
  }
  for (const change of [{ version: 2 }, { phase: "unknown" }, { phase: "sidecar_completed" }, { receiptHash: "c".repeat(64) }, { leaseVersion: 0 }, { bindingGeneration: 1.5 }, { requestHash: "A".repeat(64) }, { updatedAt: "not-a-date" }]) {
    await assert.rejects(store.save({ ...record(), ...change } as OutreachActionRecoveryRecord));
  }
  await assert.rejects(store.save(record("account-two", "action-one")));
  const path = join(directory, (await readdir(directory))[0]);
  await writeFile(path, JSON.stringify({ ...record(), content: "forbidden" }));
  await assert.rejects(createOutreachActionJournalStore(directory).list());
  await assert.rejects(store.load("account-one"));
  await writeFile(path, JSON.stringify(record()));
  await copyFile(path, join(directory, `${"f".repeat(64)}.json`));
  await assert.rejects(createOutreachActionJournalStore(directory).list());
  await assert.rejects(store.save(record("account-two", "action-two")));
});

test("journal restart refuses an already persisted third lane and symlinked records", async (t) => {
  const { root, directory, store } = await fixture(t);
  await store.save(record()); await store.save(record("account-two", "action-two"));
  const another = join(root, "other-journal");
  await createOutreachActionJournalStore(another).save(record("account-three", "action-three"));
  const thirdName = (await readdir(another))[0];
  await copyFile(join(another, thirdName), join(directory, thirdName));
  await assert.rejects(createOutreachActionJournalStore(directory).list());
  await rm(join(directory, thirdName));
  const firstPath = join(directory, (await readdir(directory))[0]);
  const original = await readFile(firstPath, "utf8"); const external = join(root, "external");
  await writeFile(external, original, { mode: 0o600 }); await rm(firstPath); await symlink(external, firstPath);
  await assert.rejects(store.list());
  assert.equal(await readFile(external, "utf8"), original);
});

test("journal reload rejects unknown files and corrupt JSON before allowing any account to claim", async (t) => {
  const { directory, store } = await fixture(t);
  await store.save(record());
  const path = join(directory, (await readdir(directory))[0]);
  const unknown = join(directory, "unexpected.json");
  await writeFile(unknown, "{}", { mode: 0o600 });
  await assert.rejects(createOutreachActionJournalStore(directory).load("account-two"));
  await assert.rejects(store.save(record("account-two", "action-two")));
  await rm(unknown); await writeFile(path, "{");
  await assert.rejects(createOutreachActionJournalStore(directory).list());
  await assert.rejects(store.load("account-one"));
});
