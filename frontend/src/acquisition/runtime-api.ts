import type {
  AcquisitionTaskOverview,
  AcquisitionTaskSummary
} from "./runtime-model";
import { csrfFromCookie } from "./csrf";
import type { AuthorizedVisualReaderProjection } from "./visual-reader-controller";

export interface AcquisitionTaskPlan {
  id?: string;
  status?: string;
  version?: number;
  currentVersionId?: string;
  approvedVersionId?: string | null;
  payload?: {
    targetPlatform?: "douyin" | "web";
    douyinPublicCommentSample?: {
      enabled: boolean;
      maxVideosPerRun: number;
      maxCommentsPerVideo: number;
      maxPagesPerVideo: number;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AcquisitionTaskDetail {
  task: AcquisitionTaskSummary;
  plan: AcquisitionTaskPlan;
  latestRun: (AcquisitionTaskSummary["latestRun"] & {
    etag?: string;
    planVersionId?: string;
    planVersion?: number;
    revision?: number;
    budgetSnapshot?: {
      billingCurrency: string;
      maxRequests: number;
      maxResults: number;
      maxAmountMinor: number;
      maxDurationSeconds: number;
    };
    modelSnapshotRef?: Record<string, unknown>;
  }) | null;
  shards: Array<Record<string, unknown>>;
  presentation: {
    candidateEvents: Array<Record<string, unknown>>;
    providers: Array<Record<string, unknown>>;
    automationSteps?: Array<Record<string, unknown>>;
    commentSignals?: Array<Record<string, unknown>>;
    authorizedVisualReader?: AuthorizedVisualReaderProjection;
    hasMore?: boolean;
    nextAfter?: string | null;
    summary?: Record<string, unknown> | null;
  } | null;
}

export interface AcquisitionRuntimeApi {
  getOverview(): Promise<AcquisitionTaskOverview>;
  getTask(planId: string): Promise<AcquisitionTaskDetail>;
  createImportOperation(
    input: AcquisitionImportOperationCreateInput,
    idempotencyKey: string
  ): Promise<AcquisitionImportOperation>;
  getImportOperation(id: string): Promise<AcquisitionImportOperation>;
}

export interface AcquisitionRuntimeApiOptions {
  cookie?: string;
  cookieSource?: () => string;
}

export interface AcquisitionImportOperation {
  id: string;
  status: string;
  acceptedRowCount?: number;
  evidenceCount?: number;
  candidateCount?: number;
  candidateIds?: string[];
  errorRows?: Array<{
    sheetName: string;
    rowNumber: number;
    code: string;
    message: string;
  }>;
}

export interface AcquisitionImportOperationCreateInput {
  fileName: string;
  mediaType: "text/csv" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  content: ArrayBuffer;
  subjectChannel: "organization" | "individual";
  mapping: {
    sourceTitle: string;
    sourceSnippet: string;
    sourcePlatform?: string;
    sourceUrl?: string;
    publishedAt?: string;
    locale?: string;
  };
}

interface ErrorBody {
  message?: unknown;
  error?: {
    message?: unknown;
  };
}

function errorMessage(body: ErrorBody, status: number): string {
  const nested = body.error?.message;
  if (typeof nested === "string" && nested.trim()) return nested;
  if (typeof body.message === "string" && body.message.trim()) {
    return body.message;
  }
  return `请求失败（HTTP ${status}）`;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function defaultCookieSource(): string {
  return typeof document === "undefined" ? "" : document.cookie;
}

function validIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error("幂等键必须为 1 到 200 个字符");
  }
  return normalized;
}

export function createAcquisitionApi(
  fetchImpl: typeof fetch = fetch,
  options: AcquisitionRuntimeApiOptions = {}
): AcquisitionRuntimeApi {
  const cookieSource = options.cookieSource
    ?? (options.cookie === undefined
      ? defaultCookieSource
      : () => options.cookie ?? "");

  async function request<T>(path: string): Promise<T> {
    const response = await fetchImpl(path, {
      method: "GET",
      credentials: "same-origin",
      headers: {
        accept: "application/json"
      }
    });
    const body = await response.json().catch(() => ({})) as T & ErrorBody;
    if (!response.ok) throw new Error(errorMessage(body, response.status));
    return body;
  }

  return {
    getOverview() {
      return request<AcquisitionTaskOverview>(
        "/api/v1/acquisition/overview?platform=douyin"
      );
    },
    getTask(planId: string) {
      return request<AcquisitionTaskDetail>(
        `/api/v1/acquisition/tasks/${segment(planId)}`
      );
    },
    async createImportOperation(input, idempotencyKey) {
      const query = new URLSearchParams({
        fileName: input.fileName,
        subjectChannel: input.subjectChannel,
        mapping: JSON.stringify(input.mapping)
      });
      const response = await fetchImpl(
        `/api/v1/acquisition/import-operations?${query}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "Content-Type": input.mediaType,
            "Idempotency-Key": validIdempotencyKey(idempotencyKey),
            "X-CSRF-Token": csrfFromCookie(cookieSource())
          },
          body: input.content
        }
      );
      const body = await response.json().catch(() => ({})) as
        AcquisitionImportOperation & ErrorBody;
      if (!response.ok) throw new Error(errorMessage(body, response.status));
      return body;
    },
    getImportOperation(id: string) {
      return request<AcquisitionImportOperation>(
        `/api/v1/acquisition/import-operations/${segment(id)}`
      );
    }
  };
}
