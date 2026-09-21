import type {
  AcquisitionProviderConnectionSnapshot
} from "./acquisition-plan-run-repository.js";

export const ACQUISITION_SEARCH_PROVIDER_IDS = Object.freeze([
  "baidu_ai_search",
  "tencent_web_search",
  "serper",
  "brave",
  "serpapi",
  "tavily"
] as const);

export const ACQUISITION_CONTENT_FETCH_PROVIDER = Object.freeze({
  id: "controlled_public_content",
  kind: "content_fetch" as const,
  displayName: "受控公开网页解析",
  capabilities: [
    "https_public_content",
    "ssrf_protection",
    "redirect_guard",
    "content_hash",
    "access_restriction_detection"
  ]
});

export const ACQUISITION_IMPORT_PROVIDER = Object.freeze({
  id: "authorized_file_import",
  kind: "import" as const,
  displayName: "客户授权 CSV/XLSX 导入",
  capabilities: [
    "csv_utf8",
    "xlsx",
    "artifact_hash",
    "row_provenance",
    "encrypted_artifact"
  ]
});

export const ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS = Object.freeze({
  contentFetch: Object.freeze({
    connectionId: "system:controlled_public_content:v1",
    providerId: ACQUISITION_CONTENT_FETCH_PROVIDER.id,
    kind: "content_fetch",
    status: "active",
    credentialVersion: 1
  } satisfies AcquisitionProviderConnectionSnapshot),
  import: Object.freeze({
    connectionId: "system:authorized_file_import:v1",
    providerId: ACQUISITION_IMPORT_PROVIDER.id,
    kind: "import",
    status: "active",
    credentialVersion: 1
  } satisfies AcquisitionProviderConnectionSnapshot)
});

export function isTrustedAcquisitionSystemConnection(
  snapshot: AcquisitionProviderConnectionSnapshot
) {
  const expected = snapshot.kind === "content_fetch"
    ? ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS.contentFetch
    : snapshot.kind === "import"
      ? ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS.import
      : null;
  return Boolean(expected)
    && snapshot.connectionId === expected!.connectionId
    && snapshot.providerId === expected!.providerId
    && snapshot.status === expected!.status
    && snapshot.credentialVersion === expected!.credentialVersion;
}
