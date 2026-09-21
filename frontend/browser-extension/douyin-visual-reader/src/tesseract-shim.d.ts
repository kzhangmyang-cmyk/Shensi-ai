declare module "tesseract.js/src/createWorker.js" {
  const createWorker: (
    languages?: string | string[],
    oem?: number,
    options?: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => Promise<unknown>;
  export default createWorker;
}

declare module "tesseract.js/src/worker-script/index.js" {
  const worker: {
    dispatchHandlers(packet: unknown, callback: (response: unknown) => void): void;
    setAdapter(adapter: Record<string, unknown>): void;
  };
  export default worker;
}
