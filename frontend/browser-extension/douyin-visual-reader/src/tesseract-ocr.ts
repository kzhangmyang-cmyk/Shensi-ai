import type {
  VisualOcrCrop,
  VisualOcrLanguages,
  VisualOcrPort,
  VisualOcrResult,
  VisualOcrWord
} from "./ocr-port";
import createWorker from "tesseract.js/src/createWorker.js";

interface TesseractWordLike {
  text?: unknown;
  confidence?: unknown;
  bbox?: { x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown };
}

export interface TesseractWorkerLike {
  recognize(image: Uint8Array, options: Record<string, unknown>, output: {
    text: true;
    blocks: true;
  }): Promise<{ data: {
    text?: unknown;
    confidence?: unknown;
    blocks?: unknown;
  } }>;
  terminate(): Promise<unknown>;
}

export type TesseractWorkerFactory = (
  languages: string[],
  oem: number,
  options: Record<string, unknown>
) => Promise<TesseractWorkerLike>;

async function defaultWorkerFactory(languages: string[], oem: number,
  options: Record<string, unknown>): Promise<TesseractWorkerLike> {
  return createWorker(languages, oem, options) as unknown as Promise<TesseractWorkerLike>;
}

function confidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value / 100));
}

function appendWord(value: unknown, output: VisualOcrWord[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const candidate = value as TesseractWordLike;
  if (typeof candidate.text === "string" && candidate.text.trim()
    && candidate.bbox && typeof candidate.bbox === "object") {
    const { x0, y0, x1, y1 } = candidate.bbox;
    if ([x0, y0, x1, y1].every((coordinate) => typeof coordinate === "number"
      && Number.isFinite(coordinate))) {
      const left = Math.max(0, Math.floor(x0 as number));
      const top = Math.max(0, Math.floor(y0 as number));
      const right = Math.max(left, Math.ceil(x1 as number));
      const bottom = Math.max(top, Math.ceil(y1 as number));
      if (right > left && bottom > top) output.push({
        text: candidate.text.trim(),
        confidence: confidence(candidate.confidence),
        bounds: { x: left, y: top, width: right - left, height: bottom - top }
      });
    }
  }
}

function collectWords(blocks: unknown, output: VisualOcrWord[]): void {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const paragraphs = (block as Record<string, unknown>).paragraphs;
    if (!Array.isArray(paragraphs)) continue;
    for (const paragraph of paragraphs) {
      if (!paragraph || typeof paragraph !== "object" || Array.isArray(paragraph)) continue;
      const lines = (paragraph as Record<string, unknown>).lines;
      if (!Array.isArray(lines)) continue;
      for (const line of lines) {
        if (!line || typeof line !== "object" || Array.isArray(line)) continue;
        const words = (line as Record<string, unknown>).words;
        if (!Array.isArray(words)) continue;
        for (const word of words) appendWord(word, output);
      }
    }
  }
}

export function createTesseractOcrPort(options: {
  createWorker?: TesseractWorkerFactory;
  assetBaseUrl: string;
  initTimeoutMs?: number;
  recognizeTimeoutMs?: number;
  scheduleTimeout?: (callback: () => void, delay: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
}): VisualOcrPort & { endSession(): Promise<void> } {
  const createWorker = options.createWorker ?? defaultWorkerFactory;
  const base = options.assetBaseUrl.replace(/\/+$/u, "");
  if (!base || /^https?:/iu.test(base)) throw new Error("OCR assets must use a local extension URL");
  const scheduleTimeout = options.scheduleTimeout
    ?? ((callback: () => void, delay: number) => globalThis.setTimeout(callback, delay));
  const cancelTimeout = options.cancelTimeout
    ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const initTimeoutMs = options.initTimeoutMs ?? 20_000;
  const recognizeTimeoutMs = options.recognizeTimeoutMs ?? 20_000;
  if (!Number.isSafeInteger(initTimeoutMs) || initTimeoutMs < 1 || initTimeoutMs > 60_000
    || !Number.isSafeInteger(recognizeTimeoutMs) || recognizeTimeoutMs < 1
    || recognizeTimeoutMs > 60_000) throw new Error("invalid OCR timeout");
  let worker: TesseractWorkerLike | null = null;
  let workerPromise: Promise<TesseractWorkerLike> | null = null;
  let idleHandle: unknown = null;
  let generation = 0;
  let sessionAbort = new AbortController();
  const terminated = new WeakSet<TesseractWorkerLike>();

  function cancelled(): Error {
    return new Error("OCR session ended or cancelled");
  }

  async function terminateOnce(target: TesseractWorkerLike): Promise<void> {
    if (terminated.has(target)) return;
    terminated.add(target);
    await target.terminate();
  }

  function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string,
    signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(cancelled());
        return;
      }
      const timer = globalThis.setTimeout(() => {
        signal.removeEventListener("abort", abort);
        reject(new Error(`${label} timed out`));
      }, timeoutMs);
      const abort = () => {
        globalThis.clearTimeout(timer);
        reject(cancelled());
      };
      signal.addEventListener("abort", abort, { once: true });
      promise.then((value) => {
        globalThis.clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(value);
      }, (error) => {
        globalThis.clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(error);
      });
    });
  }

  function clearIdle(): void {
    if (idleHandle !== null) cancelTimeout(idleHandle);
    idleHandle = null;
  }

  async function terminateCurrent(): Promise<void> {
    clearIdle();
    const current = worker;
    worker = null;
    workerPromise = null;
    generation += 1;
    sessionAbort.abort();
    if (current) await terminateOnce(current);
  }

  function scheduleIdleTermination(): void {
    clearIdle();
    idleHandle = scheduleTimeout(() => {
      idleHandle = null;
      void terminateCurrent().catch(() => undefined);
    }, 30_000);
  }

  async function currentWorker(expectedGeneration: number): Promise<TesseractWorkerLike> {
    if (expectedGeneration !== generation) throw cancelled();
    if (worker) return worker;
    if (!workerPromise) {
      const pendingGeneration = generation;
      const raw = createWorker(["chi_sim", "eng"], 1, {
        workerPath: `${base}/worker.min.js`,
        corePath: `${base}/core`,
        langPath: `${base}/lang`,
        cacheMethod: "none",
        workerBlobURL: false,
        gzip: false
      });
      const pending = raw.then(async (created) => {
        if (generation !== pendingGeneration) {
          await terminateOnce(created);
          throw cancelled();
        }
        worker = created;
        return created;
      }, (error) => {
        throw error;
      });
      workerPromise = pending;
      void raw.then((created) => {
        if (generation !== pendingGeneration && worker !== created) {
          void terminateOnce(created).catch(() => undefined);
        }
      }, () => undefined);
      void pending.catch(() => undefined).finally(() => {
        if (workerPromise === pending && worker === null) workerPromise = null;
      });
    }
    return workerPromise;
  }

  return {
    async recognize(crop: VisualOcrCrop, languages: VisualOcrLanguages): Promise<VisualOcrResult> {
      if (languages[0] !== "chi_sim" || languages[1] !== "eng" || languages.length !== 2) {
        throw new Error("OCR languages must be chi_sim+eng");
      }
      if (crop.mediaType !== "image/webp" || !(crop.bytes instanceof Uint8Array)
        || crop.bytes.byteLength < 1 || crop.bytes.byteLength > 262_144
        || !Number.isSafeInteger(crop.width) || crop.width < 1
        || !Number.isSafeInteger(crop.height) || crop.height < 1) {
        throw new Error("invalid redacted OCR crop");
      }
      if (sessionAbort.signal.aborted) sessionAbort = new AbortController();
      const operationAbort = sessionAbort;
      const operationGeneration = generation;
      clearIdle();
      let result: Awaited<ReturnType<TesseractWorkerLike["recognize"]>>;
      let activeWorker: TesseractWorkerLike | null = null;
      try {
        activeWorker = await bounded(currentWorker(operationGeneration), initTimeoutMs,
          "OCR initialization", operationAbort.signal);
        result = await bounded(activeWorker.recognize(crop.bytes, {}, { text: true, blocks: true }),
          recognizeTimeoutMs, "OCR recognition", operationAbort.signal);
        if (generation !== operationGeneration || operationAbort.signal.aborted) throw cancelled();
      } catch (error) {
        if (operationAbort.signal.aborted
          || (error instanceof Error && /timed out/u.test(error.message))) {
          if (activeWorker && worker === activeWorker) worker = null;
          workerPromise = null;
          if (generation === operationGeneration) generation += 1;
          if (activeWorker) void terminateOnce(activeWorker).catch(() => undefined);
        }
        throw error;
      } finally {
        if (worker && generation === operationGeneration && !operationAbort.signal.aborted) {
          scheduleIdleTermination();
        }
      }
      const words: VisualOcrWord[] = [];
      collectWords(result.data.blocks, words);
      return {
        text: typeof result.data.text === "string" ? result.data.text.normalize("NFC").trim() : "",
        confidence: confidence(result.data.confidence),
        words
      };
    },
    endSession: terminateCurrent
  };
}
