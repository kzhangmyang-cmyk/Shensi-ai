export type PublicDouyinUrlResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

export interface PublicLeadImportRowError {
  sheetName: string;
  rowNumber: number;
  code: string;
  message: string;
}

export interface PublicLeadImportOutcome {
  acceptedRowCount: number | null;
  evidenceCount: number | null;
  candidateCount: number | null;
  candidateIds: string[];
  rowErrors: PublicLeadImportRowError[];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value)
    ? `"${value.replace(/"/gu, '""')}"`
    : value;
}

export function publicDouyinUrl(value: string): PublicDouyinUrlResult {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, message: "链接格式无效" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, message: "仅支持 HTTPS 公开链接" };
  }
  if (url.username || url.password || (url.port && url.port !== "443")) {
    return { ok: false, message: "链接不得包含凭据或非标准端口" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  const isDouyin = host === "douyin.com"
    || host.endsWith(".douyin.com")
    || host === "iesdouyin.com"
    || host.endsWith(".iesdouyin.com");
  if (!isDouyin) {
    return { ok: false, message: "仅支持抖音公开域名链接" };
  }
  return { ok: true, value: url.toString() };
}

export function publicUrlsCsv(urls: readonly string[]): ArrayBuffer {
  const rows = [
    "标题,摘要,平台,链接",
    ...urls.map((url) => [
      "用户导入的公开抖音链接",
      "用户提交公开链接，主体待核验",
      "douyin",
      url
    ].map(csvCell).join(","))
  ];
  const encoded = new TextEncoder().encode(rows.join("\r\n"));
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength
  ) as ArrayBuffer;
}

export function importOperationStatus(value: unknown): string | null {
  const status = recordValue(value).status;
  return typeof status === "string" ? status : null;
}

export function importOperationIsActive(value: unknown): boolean {
  return ["queued", "running"].includes(importOperationStatus(value) ?? "");
}

export function importItemStatus(value: unknown):
  | "queued"
  | "running"
  | "succeeded"
  | "failed" {
  const status = importOperationStatus(value);
  if (status === "running") return "running";
  if (status === "succeeded" || status === "partial_success") {
    return "succeeded";
  }
  if (status === "failed") return "failed";
  return "queued";
}

export function importOutcomeFromOperation(
  value: unknown
): PublicLeadImportOutcome {
  const record = recordValue(value);
  const rowErrors = Array.isArray(record.errorRows)
    ? record.errorRows.flatMap((item) => {
        const error = recordValue(item);
        const rowNumber = optionalNonNegativeInteger(error.rowNumber);
        if (
          rowNumber === null
          || rowNumber < 1
          || typeof error.sheetName !== "string"
          || typeof error.code !== "string"
          || typeof error.message !== "string"
        ) return [];
        return [{
          sheetName: error.sheetName,
          rowNumber,
          code: error.code,
          message: error.message
        }];
      })
    : [];
  return {
    acceptedRowCount: optionalNonNegativeInteger(record.acceptedRowCount),
    evidenceCount: optionalNonNegativeInteger(record.evidenceCount),
    candidateCount: optionalNonNegativeInteger(record.candidateCount),
    candidateIds: Array.isArray(record.candidateIds)
      ? record.candidateIds.filter((id): id is string =>
          typeof id === "string" && id.trim().length > 0)
      : [],
    rowErrors
  };
}
