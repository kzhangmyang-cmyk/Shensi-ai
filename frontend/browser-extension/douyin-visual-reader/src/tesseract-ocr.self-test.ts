import { strict as assert } from "node:assert";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker as createRealWorker } from "tesseract.js";
import {
  createTesseractOcrPort,
  type TesseractWorkerFactory
} from "./tesseract-ocr";
import { characterRecall } from "./visual-pipeline";

const calls: Array<{ languages: unknown; options: Record<string, unknown> }> = [];
let recognizeCalls = 0;
const recognizeOutputs: unknown[] = [];
let terminateCalls = 0;
let scheduled: (() => void) | null = null;

const factory: TesseractWorkerFactory = async (languages, _oem, options) => {
  calls.push({ languages, options: options as Record<string, unknown> });
  return {
    async recognize(image, _options, output) {
      recognizeCalls += 1;
      recognizeOutputs.push(output);
      assert.ok(image instanceof Uint8Array);
      return {
        data: {
          text: "中文报价 128.50 元\n",
          confidence: 94,
          blocks: [{
            text: "中文报价 128.50 元",
            confidence: 95,
            bbox: { x0: 1, y0: 1, x1: 80, y1: 18 },
            paragraphs: [{
              text: "中文报价 128.50 元",
              confidence: 95,
              bbox: { x0: 1, y0: 1, x1: 80, y1: 18 },
              lines: [{
                text: "中文报价 128.50 元",
                confidence: 95,
                bbox: { x0: 1, y0: 1, x1: 80, y1: 18 },
                words: [
            { text: "中文报价", confidence: 96, bbox: { x0: 2, y0: 3, x1: 42, y1: 15 },
              symbols: [{ text: "中", confidence: 97, bbox: { x0: 2, y0: 3, x1: 12, y1: 15 } }] },
            { text: "128.50", confidence: 92, bbox: { x0: 45, y0: 3, x1: 79, y1: 15 } }
          ] }] }] }]
        }
      };
    },
    async terminate() { terminateCalls += 1; return { jobId: "terminated", data: null }; }
  };
};

const port = createTesseractOcrPort({
  createWorker: factory,
  assetBaseUrl: "chrome-extension://fixture/ocr",
  scheduleTimeout(callback, delay) {
    assert.equal(delay, 30_000);
    scheduled = callback;
    return callback;
  },
  cancelTimeout() { scheduled = null; }
});

const crop = {
  mediaType: "image/webp" as const,
  bytes: new Uint8Array([82, 73, 70, 70]),
  width: 80,
  height: 20
};
const first = await port.recognize(crop, ["chi_sim", "eng"]);
const second = await port.recognize(crop, ["chi_sim", "eng"]);
assert.equal(calls.length, 1);
assert.equal(recognizeCalls, 2);
assert.deepEqual(recognizeOutputs, [
  { text: true, blocks: true },
  { text: true, blocks: true }
], "the real worker must return word-level confidence and bounds");
assert.deepEqual(calls[0].languages, ["chi_sim", "eng"]);
assert.deepEqual(calls[0].options, {
  workerPath: "chrome-extension://fixture/ocr/worker.min.js",
  corePath: "chrome-extension://fixture/ocr/core",
  langPath: "chrome-extension://fixture/ocr/lang",
  cacheMethod: "none",
  workerBlobURL: false,
  gzip: false
});
assert.equal(first.text, "中文报价 128.50 元");
assert.equal(first.confidence, 0.94);
assert.deepEqual(first.words, [
  { text: "中文报价", confidence: 0.96, bounds: { x: 2, y: 3, width: 40, height: 12 } },
  { text: "128.50", confidence: 0.92, bounds: { x: 45, y: 3, width: 34, height: 12 } }
]);
assert.deepEqual(second, first);
const invokeScheduled = scheduled as (() => void) | null;
assert.ok(invokeScheduled);
invokeScheduled();
await Promise.resolve();
assert.equal(terminateCalls, 1);

await port.recognize(crop, ["chi_sim", "eng"]);
assert.equal(calls.length, 2);
await port.endSession();
assert.equal(terminateCalls, 2);

await assert.rejects(
  () => port.recognize(crop, ["eng", "chi_sim"] as unknown as ["chi_sim", "eng"]),
  /chi_sim\+eng/u
);

{
  let failedIdle: (() => void) | null = null;
  let failedTerminateCalls = 0;
  const failedPort = createTesseractOcrPort({
    assetBaseUrl: "chrome-extension://fixture/ocr",
    createWorker: async () => ({
      async recognize() { throw new Error("synthetic OCR failure"); },
      async terminate() { failedTerminateCalls += 1; }
    }),
    scheduleTimeout(callback) { failedIdle = callback; return callback; },
    cancelTimeout() { failedIdle = null; }
  });
  await assert.rejects(() => failedPort.recognize(crop, ["chi_sim", "eng"]), /synthetic OCR failure/u);
  const invokeFailedIdle = failedIdle as (() => void) | null;
  assert.ok(invokeFailedIdle, "a failed recognition still schedules bounded worker cleanup");
  invokeFailedIdle();
  await Promise.resolve();
  assert.equal(failedTerminateCalls, 1);
}

{
  let resolveFactory: ((worker: Awaited<ReturnType<TesseractWorkerFactory>>) => void) | null = null;
  let pendingTerminateCalls = 0;
  const pendingPort = createTesseractOcrPort({
    assetBaseUrl: "chrome-extension://fixture/ocr",
    initTimeoutMs: 100,
    createWorker: () => new Promise((resolve) => { resolveFactory = resolve; })
  });
  const recognition = pendingPort.recognize(crop, ["chi_sim", "eng"]);
  while (!resolveFactory) await Promise.resolve();
  await pendingPort.endSession();
  const finishFactory = resolveFactory as ((worker: Awaited<ReturnType<TesseractWorkerFactory>>) => void) | null;
  if (!finishFactory) throw new Error("missing pending factory resolver");
  finishFactory({
    async recognize() { throw new Error("stale worker must not recognize"); },
    async terminate() { pendingTerminateCalls += 1; }
  });
  await assert.rejects(recognition, /ended|cancelled/u,
    "a factory resolving after end cannot resurrect the session worker");
  assert.equal(pendingTerminateCalls, 1, "the late worker is terminated exactly once");
}

{
  let terminateCalls = 0;
  const timeoutPort = createTesseractOcrPort({
    assetBaseUrl: "chrome-extension://fixture/ocr",
    recognizeTimeoutMs: 5,
    createWorker: async () => ({
      recognize: () => new Promise(() => undefined),
      async terminate() { terminateCalls += 1; }
    })
  });
  await assert.rejects(timeoutPort.recognize(crop, ["chi_sim", "eng"]), /timed out/u,
    "a hung recognition is bounded");
  assert.equal(terminateCalls, 1, "recognition timeout terminates the worker");
}

{
  let resolveRecognition: ((result: {
    data: { text: string; confidence: number; blocks: unknown[] };
  }) => void) | null = null;
  let terminateCalls = 0;
  const endingPort = createTesseractOcrPort({
    assetBaseUrl: "chrome-extension://fixture/ocr",
    recognizeTimeoutMs: 100,
    createWorker: async () => ({
      recognize: () => new Promise((resolve) => { resolveRecognition = resolve; }),
      async terminate() { terminateCalls += 1; }
    })
  });
  const pending = endingPort.recognize(crop, ["chi_sim", "eng"]);
  while (!resolveRecognition) await Promise.resolve();
  await endingPort.endSession();
  assert.equal(terminateCalls, 1, "end terminates a worker during recognition without queueing");
  const finishRecognition = resolveRecognition as ((result: {
    data: { text: string; confidence: number; blocks: unknown[] };
  }) => void) | null;
  if (!finishRecognition) throw new Error("missing recognition resolver");
  finishRecognition({ data: { text: "stale", confidence: 99, blocks: [] } });
  await assert.rejects(pending, /ended|cancelled/u,
    "recognition cannot publish after the session generation is invalidated");
}

{
  const languageDirectory = await mkdtemp(join(tmpdir(), "goodjob-ocr-languages-"));
  let worker: Awaited<ReturnType<typeof createRealWorker>> | null = null;
  try {
    const modules = new URL("../../../node_modules/", import.meta.url);
    await Promise.all([
      copyFile(fileURLToPath(new URL(
        "@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz", modules
      )), join(languageDirectory, "chi_sim.traineddata.gz")),
      copyFile(fileURLToPath(new URL(
        "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", modules
      )), join(languageDirectory, "eng.traineddata.gz"))
    ]);
    worker = await createRealWorker(["chi_sim", "eng"], 1, {
      langPath: languageDirectory,
      cacheMethod: "none",
      gzip: true
    });
    const fixtureBytes = await readFile(new URL("../fixtures/chinese-low-contrast.webp", import.meta.url));
    const result = await worker.recognize(fixtureBytes, {}, { text: true, blocks: true });
    const recognized = result.data.text.normalize("NFC").trim();
    assert.ok(Array.isArray(result.data.blocks) && result.data.blocks.length > 0,
      "the pinned local worker returns word-level block geometry");
    assert.ok(characterRecall("中文报价 128.50 元", recognized) >= 0.9,
      `pinned local chi_sim+eng recall fell below 90%: ${JSON.stringify(recognized)}`);
    assert.match(recognized, /报\s*价/u);
    assert.match(recognized, /128[.,]50/u, "numeric/money evidence cannot be invented or altered");
    const truncatedFixture = await readFile(new URL("../fixtures/truncated-avatar.webp", import.meta.url));
    const truncatedRecognition = (await worker.recognize(truncatedFixture)).data;
    const truncatedResult = truncatedRecognition.text.normalize("NFC").trim();
    assert.match(truncatedResult, /长\s*评\s*论/u);
    assert.match(truncatedResult, /500/u);
    assert.ok(/128[.,]50/u.test(truncatedResult) || truncatedRecognition.confidence < 90,
      "an altered visible amount must fail the 90% confidence gate");
    assert.doesNotMatch(truncatedResult, /188[.,]50/u);
  } finally {
    await worker?.terminate();
    await rm(languageDirectory, { recursive: true, force: true });
  }
}

console.log("tesseract OCR self-test passed");
