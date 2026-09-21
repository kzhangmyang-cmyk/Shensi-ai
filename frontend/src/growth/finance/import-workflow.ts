import type {
  FinanceApi,
  FinanceDocumentInspection,
  FinanceImportMapping,
  FinanceImportOperation,
  FinanceImportPreview
} from "./api";
import { GrowthApiError } from "../http";

export type FinanceImportState =
  | { kind: "idle" }
  | { kind: "inspecting"; readWithModel: boolean }
  | { kind: "document_ready"; document: FinanceDocumentInspection }
  | { kind: "uploading" }
  | { kind: "preview_ready"; preview: FinanceImportPreview }
  | { kind: "committing" }
  | { kind: "polling"; operationId: string }
  | { kind: "partial_success"; operation: FinanceImportOperation }
  | { kind: "succeeded"; operation: FinanceImportOperation }
  | { kind: "failed"; message: string };

export interface FinanceImportWorkflow {
  inspect(file: Blob, filename: string, readWithModel: boolean, signal?: AbortSignal): Promise<FinanceImportState>;
  preview(
    kind: "acquisition_cost" | "financial_fact",
    file: Blob,
    filename: string,
    idempotencyKey: string,
    signal?: AbortSignal,
    mapping?: FinanceImportMapping
  ): Promise<FinanceImportState>;
  commit(previewId: string, idempotencyKey: string, signal?: AbortSignal): Promise<FinanceImportState>;
  poll(
    operationId: string,
    signal?: AbortSignal
  ): Promise<FinanceImportState>;
}

const POLL_MAX_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 1_000;
const DOCUMENT_READ_ERRORS: Readonly<Record<string, string>> = {
  finance_document_text_unavailable: "没有读取到可用文字，请提供可复制文字的 PDF/DOCX；扫描件或图片请先进行 OCR 文字识别后再上传。",
  finance_document_password_required: "文件已加密，请先解除密码保护，再上传可读取的副本。",
  finance_document_encrypted: "文件已加密，请先解除密码保护，再上传可读取的副本。",
  finance_document_format_unsupported: "文件格式暂不支持，请另存为 CSV、XLS、XLSX、含文字的 PDF 或 DOCX 后上传。",
  finance_document_format_invalid: "文件格式不符合要求或内容已损坏，请重新导出 PDF/DOCX 后重试。",
  finance_document_artifact_invalid: "文件格式不符合要求或内容已损坏，请重新导出 PDF/DOCX 后重试。",
  finance_document_limit_exceeded: "文件大小或内容超出读取限制，请拆分资料后重试。",
  finance_document_timeout: "资料读取超时，请拆分较大的文件后重试。"
};

export function importErrorMessage(error: unknown): string {
  if (error instanceof GrowthApiError) {
    if (error.code === "IMPORT_ARTIFACT_INVALID") return "无法解析文件，请检查实际格式、编码或加密状态。XLS 支持旧版 Excel、静态 HTML 表格和 Excel XML；修改后缀不能转换格式。";
    if (error.code === "IMPORT_LIMIT_EXCEEDED" || error.status === 413) return "文件超出导入限制：最多 5 MB、10 个工作表、5000 行、100 列，请拆分后重试。";
    if (error.status === 401) return "登录已失效，请重新登录后再导入。";
    if (error.status === 403) return "当前工作区没有导入权限，请联系管理员。";
    if (error.status === 429) return "本分钟读取次数较多，请稍后重试此文件；其他成功文件已保留。";
    return "服务端未能完成导入，请检查文件后重试。";
  }
  if (error instanceof DOMException && error.name === "AbortError") return "导入已取消，请重新选择文件。";
  if (error instanceof TypeError) return "无法连接导入服务，请检查网络后重试。";
  return error instanceof Error ? error.message : "导入失败，请重新选择文件后重试。";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
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
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
        controller.signal.throwIfAborted();
        const response = await api.getImport(operationId, controller.signal);
        controller.signal.throwIfAborted();
        const operation = response.body;
        if (operation.status === "succeeded") {
          return { kind: "succeeded", operation };
        }
        if (operation.status === "failed") {
          return { kind: "failed", message: "服务端导入失败，请检查文件后重试。" };
        }
        if (operation.status === "requires_review"
          || operation.status === "previewed") {
          return { kind: "partial_success", operation };
        }
        await sleep(POLL_INTERVAL_MS, controller.signal);
      }
      return { kind: "failed", message: "导入仍在处理中，请稍后刷新台账确认结果，避免重复提交。" };
    } catch (error) {
      return {
        kind: "failed",
        message: importErrorMessage(error)
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (activePoll === controller) activePoll = null;
    }
  };
  const workflow: FinanceImportWorkflow = {
    async inspect(file, filename, readWithModel, signal) {
      try {
        const response = await api.inspectDocument(file, filename, readWithModel, signal);
        signal?.throwIfAborted();
        return { kind: "document_ready", document: response.body };
      } catch (error) {
        return { kind: "failed", message: signal?.aborted ? "资料读取已取消。"
          : error instanceof GrowthApiError && Object.prototype.hasOwnProperty.call(DOCUMENT_READ_ERRORS, error.code)
            ? DOCUMENT_READ_ERRORS[error.code]!
            : "资料读取未完成，请检查文件或服务连接后重试。原文件未入账。" };
      }
    },
    async preview(
      kind,
      file,
      filename,
      idempotencyKey,
      signal,
      mapping
    ) {
      try {
        const response = await api.previewImport(
          kind, file, filename, idempotencyKey, signal, mapping
        );
        return { kind: "preview_ready", preview: response.body };
      } catch (error) {
        return {
          kind: "failed",
          message: importErrorMessage(error)
        };
      }
    },
    async commit(previewId: string, idempotencyKey: string, signal?: AbortSignal) {
      try {
        const response = await api.commitImport(previewId, idempotencyKey, signal);
        return poll(response.body.id, signal);
      } catch (error) {
        return {
          kind: "failed",
          message: importErrorMessage(error)
        };
      }
    },
    poll
  };
  return Object.freeze(workflow);
}
