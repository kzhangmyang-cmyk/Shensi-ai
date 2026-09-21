import { relaxedSimd, simd } from "wasm-feature-detect";

declare const importScripts: (...urls: string[]) => void;

export async function getLocalTesseractCore(
  lstmOnly: boolean,
  corePath: string,
  response: { progress(value: { status: string; progress: number }): void }
): Promise<unknown> {
  const scope = globalThis as typeof globalThis & {
    TesseractCore?: unknown;
    TesseractCoreWASM?: unknown;
  };
  if (scope.TesseractCore !== undefined) return scope.TesseractCore;
  if (!lstmOnly || !corePath || /^https?:/iu.test(corePath)) {
    throw new Error("Tesseract core must be a local extension LSTM asset");
  }
  response.progress({ status: "loading tesseract core", progress: 0 });
  const base = corePath.replace(/\/+$/u, "");
  const relaxed = await relaxedSimd();
  const regular = relaxed ? false : await simd();
  const filename = relaxed
    ? "tesseract-core-relaxedsimd-lstm.wasm.js"
    : regular
      ? "tesseract-core-simd-lstm.wasm.js"
      : "tesseract-core-lstm.wasm.js";
  importScripts(`${base}/${filename}`);
  if (scope.TesseractCore === undefined && scope.TesseractCoreWASM !== undefined
    && typeof WebAssembly === "object") scope.TesseractCore = scope.TesseractCoreWASM;
  if (scope.TesseractCore === undefined) throw new Error("Local Tesseract core failed to load");
  response.progress({ status: "loading tesseract core", progress: 1 });
  return scope.TesseractCore;
}
