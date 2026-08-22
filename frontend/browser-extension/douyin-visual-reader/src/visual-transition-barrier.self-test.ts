import { strict as assert } from "node:assert";
import { createVisualTransitionBarrier } from "./visual-transition-barrier";

{
  const barrier = createVisualTransitionBarrier();
  let storedSession = "old:reading";
  let currentSession: string | null = null;
  let releaseOldPersist: (() => void) | null = null;
  let releaseOldEnd: (() => void) | null = null;

  const oldSettlement = barrier.schedule(async () => {
    await new Promise<void>((resolve) => { releaseOldPersist = resolve; });
    storedSession = "old:aborted";
    await new Promise<void>((resolve) => { releaseOldEnd = resolve; });
  });
  const newStart = barrier.schedule(async () => {
    currentSession = "new";
    storedSession = "new:authorized";
  });

  await Promise.resolve();
  assert.equal(currentSession, null,
    "a replacement start waits for the old coordinator persistence and offscreen end settlement");
  const finishPersist = releaseOldPersist as (() => void) | null;
  if (!finishPersist) throw new Error("missing deferred old persist resolver");
  finishPersist();
  while (!releaseOldEnd) await Promise.resolve();
  assert.equal(currentSession, null);
  const finishEnd = releaseOldEnd as (() => void) | null;
  if (!finishEnd) throw new Error("missing deferred old end resolver");
  finishEnd();
  await Promise.all([oldSettlement, newStart]);
  assert.equal(currentSession, "new");
  assert.equal(storedSession, "new:authorized",
    "old terminal persistence cannot overwrite a replacement session");
}

{
  const barrier = createVisualTransitionBarrier();
  let releaseLongTransition: (() => void) | null = null;
  let installedSession: string | null = null;
  let storedSession = "old:reading";

  const longTransition = barrier.schedule(async () => {
    await new Promise<void>((resolve) => { releaseLongTransition = resolve; });
    storedSession = "old:aborted";
  });
  const queuedStartRevision = barrier.invalidatePending();
  const queuedStart = barrier.schedule(async () => {
    if (!barrier.isCurrent(queuedStartRevision)) return false;
    installedSession = "new";
    storedSession = "new:authorized";
    return true;
  });

  barrier.invalidatePending();
  const queuedAbort = barrier.schedule(async () => {
    storedSession = "old:aborted";
  });
  await Promise.resolve();
  const release = releaseLongTransition as (() => void) | null;
  if (!release) throw new Error("missing long transition resolver");
  release();

  assert.equal(await queuedStart, false,
    "an abort received after a queued start synchronously revokes that start");
  await Promise.all([longTransition, queuedAbort]);
  assert.equal(installedSession, null);
  assert.equal(storedSession, "old:aborted",
    "a revoked queued start cannot overwrite terminal storage");
}

console.log("visual transition barrier self-test passed");
