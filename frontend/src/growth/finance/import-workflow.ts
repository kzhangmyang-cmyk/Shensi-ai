import type {
  FinanceApi,
  FinanceImportOperation,
  FinanceImportPreview
} from "./api";

export type FinanceImportState =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "preview_ready"; preview: FinanceImportPreview }
  | { kind: "committing" }
  | { kind: "polling"; operationId: string }
  | { kind: "partial_success"; operation: FinanceImportOperation }
  | { kind: "succeeded"; operation: FinanceImportOperation }
  | { kind: "failed"; message: string };

export interface FinanceImportWorkflow {
  preview(
    kind: "acquisition_cost" | "financial_fact",
    file: Blob,
    filename: string,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<FinanceImportState>;
  commit(previewId: string, idempotencyKey: string): Promise<FinanceImportState>;
  poll(
    operationId: string,
    signal?: AbortSignal
  ): Promise<FinanceImportState>;
}

const POLL_MAX_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 1_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

export function createFinanceImportWorkflow(
  api: FinanceApi
): FinanceImportWorkflow {
  let activePoll: AbortController | null = null;
  const poll = async (
    operationId: string,
    signal?: AbortSignal
  ): Promise<FinanceImportState> => {
    activePoll?.abort();
    const controller = new AbortController();
    activePoll = controller;
    const combined = signal;
    try {
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
        const response = await api.getImport(operationId, controller.signal);
        const operation = response.body;
        if (operation.status === "succeeded") {
          return { kind: "succeeded", operation };
        }
        if (operation.status === "failed") {
          return { kind: "failed", message: "import_failed" };
        }
        if (operation.status === "requires_review"
          || operation.status === "previewed") {
          return { kind: "partial_success", operation };
        }
        await sleep(POLL_INTERVAL_MS, combined ?? controller.signal);
      }
      return { kind: "failed", message: "import_poll_timeout" };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return { kind: "failed", message: "import_poll_aborted" };
      }
      return {
        kind: "failed",
        message: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (activePoll === controller) activePoll = null;
    }
  };
  const workflow: FinanceImportWorkflow = {
    async preview(
      kind,
      file,
      filename,
      idempotencyKey,
      signal
    ) {
      try {
        const response = await api.previewImport(
          kind, file, filename, idempotencyKey, signal
        );
        return { kind: "preview_ready", preview: response.body };
      } catch (error) {
        return {
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        };
      }
    },
    async commit(previewId: string, idempotencyKey: string) {
      try {
        const response = await api.commitImport(previewId, idempotencyKey);
        return poll(response.body.id);
      } catch (error) {
        return {
          kind: "failed",
          message: error instanceof Error ? error.message : String(error)
        };
      }
    },
    poll
  };
  return Object.freeze(workflow);
}
