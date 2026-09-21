import assert from "node:assert/strict";
import test from "node:test";
import { QuotePublicationRecoverySweeper } from "./quote-publication-recovery-sweeper.js";

test("sweeper start is idempotent and close waits for active jobs", async () => {
  let scans = 0;
  let runs = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const sweeper = new QuotePublicationRecoverySweeper({
    repository: {
      async listRecoverablePublications() {
        scans += 1;
        return scans === 1 ? [{ id: "publication-1" }] : [];
      }
    } as never,
    worker: {
      async runOne() { runs += 1; await pending; return { status: "succeeded" }; }
    } as never,
    intervalMs: 60_000
  });
  sweeper.start();
  sweeper.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scans, 1);
  assert.equal(runs, 1);
  let closed = false;
  const closing = sweeper.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await closing;
  await sweeper.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scans, 1);
});
