import worker from "tesseract.js/src/worker-script/index.js";
import { getLocalTesseractCore } from "./local-tesseract-core";

declare const postMessage: (message: unknown) => void;

worker.setAdapter({
  getCore: getLocalTesseractCore,
  gunzip: () => { throw new Error("Compressed OCR language data is disabled"); },
  fetch: () => { throw new Error("Remote OCR fetch is disabled"); },
  readCache: async () => undefined,
  writeCache: async () => undefined,
  deleteCache: async () => undefined,
  checkCache: async () => false
});

globalThis.addEventListener("message", (event: MessageEvent) => {
  worker.dispatchHandlers(event.data, (response) => postMessage(response));
});
