import { GrowthApiError } from "../http";
import type {
  QuoteApi,
  QuotePreviewInput,
  QuotePreviewResult,
  QuoteVersion
} from "./api";

export interface QuoteCaseRow {
  id: string;
  revision: number;
  status: string;
  candidateId: string | null;
  customerId: string | null;
  dealId: string | null;
}

export interface QuoteVersionRow {
  id: string;
  version: number;
  status: string;
  lifecycleRevision: number;
  quotedAmountMinor?: number;
}

function toCaseRow(value: QuoteCaseRow | unknown): QuoteCaseRow {
  const record = value as unknown as Record<string, unknown>;
  return Object.freeze({
    id: String(record.id),
    revision: Number(record.revision),
    status: String(record.status),
    candidateId: record.candidateId === null
      ? null : String(record.candidateId ?? ""),
    customerId: record.customerId === null
      ? null : String(record.customerId ?? ""),
    dealId: record.dealId === null ? null : String(record.dealId ?? "")
  });
}

function toVersionRow(version: QuoteVersion): QuoteVersionRow {
  const record = version as unknown as Record<string, unknown>;
  return Object.freeze({
    id: String(record.id),
    version: Number(record.version ?? 0),
    status: String(record.status ?? ""),
    lifecycleRevision: Number(record.lifecycleRevision ?? 0),
    quotedAmountMinor: Number.isSafeInteger(record.quotedAmountMinor)
      ? Number(record.quotedAmountMinor) : undefined
  });
}

export type QuoteWorkbenchState =
  | { kind: "loading_case" }
  | {
      kind: "editing";
      case: QuoteCaseRow;
      versions: readonly QuoteVersionRow[];
    }
  | {
      kind: "previewing";
      case: QuoteCaseRow;
      input: QuotePreviewInput;
    }
  | {
      kind: "preview_ready";
      case: QuoteCaseRow;
      input: QuotePreviewInput;
      preview: Extract<
        QuotePreviewResult,
        { amountState: "actionable" }
      >;
      versions: readonly QuoteVersionRow[];
    }
  | { kind: "saving" }
  | { kind: "draft_saved"; version: QuoteVersionRow }
  | { kind: "submitting" }
  | { kind: "submitted"; version: QuoteVersionRow }
  | {
      kind: "hard_blocked";
      diagnostic: Extract<
        QuotePreviewResult,
        { amountState: "non_positive_diagnostic" }
      >;
    }
  | { kind: "conflict"; message: string }
  | {
      kind: "publication_pending";
      operationId: string;
    }
  | {
      kind: "publication_failed";
      operationId: string;
      errorCode: string;
    }
  | { kind: "error"; message: string };

export interface QuoteControllerOptions {
  api: QuoteApi;
  hasFeature: (feature: string) => boolean;
  hasCapability: (capability: string) => boolean;
  idFactory?: () => string;
}

export interface QuoteController {
  loadCase(
    caseId: string,
    signal?: AbortSignal
  ): Promise<QuoteWorkbenchState>;
  preview(
    caseId: string,
    input: QuotePreviewInput,
    etag: string,
    signal?: AbortSignal
  ): Promise<QuoteWorkbenchState>;
  submit(
    versionId: string,
    etag: string
  ): Promise<QuoteWorkbenchState>;
  approve(
    versionId: string,
    etag: string
  ): Promise<QuoteWorkbenchState>;
  reject(
    versionId: string,
    etag: string
  ): Promise<QuoteWorkbenchState>;
  nextIdempotencyKey(action: string): string;
}

function asError(error: unknown, kind: "conflict" | "error"): QuoteWorkbenchState {
  if (error instanceof GrowthApiError
    && (error.status === 409 || error.status === 412)) {
    return { kind: "conflict", message: error.code };
  }
  return {
    kind,
    message: error instanceof Error ? error.message : String(error)
  };
}

function actionablePreview(
  result: QuotePreviewResult
): Extract<QuotePreviewResult, { amountState: "actionable" }> | null {
  return result && "amountState" in result
    && result.amountState === "actionable"
    ? result as Extract<QuotePreviewResult, { amountState: "actionable" }>
    : null;
}

function diagnosticPreview(
  result: QuotePreviewResult
): Extract<QuotePreviewResult, { amountState: "non_positive_diagnostic" }> | null {
  return result && "amountState" in result
    && result.amountState === "non_positive_diagnostic"
    ? result as Extract<
        QuotePreviewResult,
        { amountState: "non_positive_diagnostic" }
      >
    : null;
}

export function createQuoteController(
  options: QuoteControllerOptions
): QuoteController {
  const idFactory = options.idFactory
    ?? (() => `quote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let previewSequence = 0;
  const controller: QuoteController = {
    nextIdempotencyKey(action: string) {
      return `${action}:${idFactory()}`;
    },
    async loadCase(caseId, signal) {
      if (!options.hasFeature("quotes")
        || !options.hasCapability("catalog.read")) {
        return { kind: "error", message: "quote_forbidden" };
      }
      try {
        const [caseResponse, versionsResponse] = await Promise.all([
          options.api.getCase(caseId, signal),
          options.api.listVersions(caseId, { limit: 100, signal })
        ]);
        return {
          kind: "editing",
          case: toCaseRow(caseResponse.body),
          versions: Object.freeze(
            (versionsResponse.body.items ?? []).map(toVersionRow)
          )
        };
      } catch (error) {
        return asError(error, "error");
      }
    },
    async preview(caseId, input, etag, signal) {
      const sequence = ++previewSequence;
      try {
        const response = await options.api.previewQuote(
          caseId, input, etag,
          `quote-preview:${idFactory()}`,
          signal
        );
        if (sequence !== previewSequence) {
          return { kind: "conflict", message: "stale_preview" };
        }
        const result = response.body;
        const actionable = actionablePreview(result);
        if (actionable) {
          const caseResponse = await options.api.getCase(caseId);
          const versionsResponse = await options.api.listVersions(
            caseId, { limit: 100 }
          );
          return {
            kind: "preview_ready",
            case: toCaseRow(caseResponse.body),
            input: Object.freeze({ ...input }),
            preview: actionable,
            versions: Object.freeze(
              (versionsResponse.body.items ?? []).map(toVersionRow)
            )
          };
        }
        const blocked = diagnosticPreview(result);
        if (blocked) {
          return { kind: "hard_blocked", diagnostic: blocked };
        }
        return { kind: "error", message: "quote_preview_invalid" };
      } catch (error) {
        return asError(error, "error");
      }
    },
    async submit(versionId, etag) {
      try {
        const response = await options.api.submitVersion(
          versionId, etag, `quote-submit:${idFactory()}`
        );
        return { kind: "submitted", version: toVersionRow(response.body) };
      } catch (error) {
        return asError(error, "error");
      }
    },
    async approve(versionId, etag) {
      try {
        await options.api.approveVersion(
          versionId, etag, `quote-approve:${idFactory()}`
        );
        return {
          kind: "publication_pending",
          operationId: versionId
        };
      } catch (error) {
        return asError(error, "error");
      }
    },
    async reject(versionId, etag) {
      try {
        await options.api.rejectVersion(
          versionId, etag, `quote-reject:${idFactory()}`
        );
        return { kind: "conflict", message: "quote_rejected" };
      } catch (error) {
        return asError(error, "error");
      }
    }
  };
  return Object.freeze(controller);
}
