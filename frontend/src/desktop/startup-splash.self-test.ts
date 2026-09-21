import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { installStartupSplash } from "./startup-splash";

const { document } = parseHTML("<html><body><main id='app'>app</main></body></html>");
const scheduled: Array<() => void> = [];
const delays: number[] = [];
let now = 1_000;
const controller = installStartupSplash({
  document,
  enabled: true,
  minimumDurationMs: 8_800,
  now: () => now,
  schedule(callback, delayMs) {
    scheduled.push(callback);
    delays.push(delayMs);
    return scheduled.length;
  },
  cancel() {}
});

assert.ok(controller, "desktop startup installs one in-renderer splash");
assert.equal(document.querySelectorAll("[data-startup-splash]").length, 1);
assert.equal(document.querySelectorAll("[data-startup-atom]").length, 3);
assert.equal(document.querySelector("[data-startup-logo]")?.tagName.toLowerCase(), "svg");
assert.equal(document.querySelector("[data-startup-logo] image")?.getAttribute("href"), "/assets/shensi-logo.png");
assert.ok(document.querySelector("#startup-remove-white feColorMatrix"), "the exact archived logo is keyed onto transparency at render time");

now = 3_400;
let finished = false;
controller?.finished.then(() => { finished = true; });
controller?.complete();
assert.equal(scheduled.length, 1, "completion waits for the minimum brand motion");
assert.equal(delays.shift(), 6_400, "business initialization and brand motion run in parallel");
scheduled.shift()?.();
assert.equal(document.querySelector("[data-startup-splash]")?.classList.contains("is-ready"), true);
await Promise.resolve();
assert.equal(finished, false, "greeting readiness waits for the exit transition, not only the ready class");
scheduled.shift()?.();
assert.equal(document.querySelector("[data-startup-splash]"), null, "ready splash is removed after the exit transition");
await controller?.finished;
assert.equal(finished, true);

const retryDocument = parseHTML("<html><body></body></html>").document;
let retries = 0;
const retryController = installStartupSplash({
  document: retryDocument,
  enabled: true,
  schedule(callback) {
    scheduled.push(callback);
    return scheduled.length;
  },
  cancel() {}
});
retryController?.fail(() => { retries += 1; });
assert.equal(retryDocument.querySelector("[data-startup-splash]")?.classList.contains("is-failed"), true);
retryDocument.querySelector<HTMLButtonElement>("[data-startup-retry]")?.click();
assert.equal(retries, 1, "retry delegates to the current app bootstrap");
assert.equal(retryDocument.querySelector("[data-startup-splash]")?.classList.contains("is-failed"), false);

assert.equal(installStartupSplash({ document: retryDocument, enabled: false }), null);

const reducedDocument = parseHTML("<html><body></body></html>").document;
const reducedDelays: number[] = [];
let reducedNow = 10;
const reducedController = installStartupSplash({
  document: reducedDocument,
  enabled: true,
  reducedMotion: true,
  now: () => reducedNow,
  schedule(callback, delayMs) {
    reducedDelays.push(delayMs);
    scheduled.push(callback);
    return scheduled.length;
  },
  cancel() {}
});
reducedNow = 410;
reducedController?.complete();
assert.equal(reducedDelays[0], 700, "reduced motion uses its shortened remaining duration");
