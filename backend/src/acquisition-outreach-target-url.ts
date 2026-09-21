import { createHash } from "node:crypto";

import { canonicalJsonStringify } from "./canonical-json.js";

export const DOUYIN_TARGET_URL_CANONICALIZER_VERSION =
  "douyin-target-url-v1" as const;

type OutreachKind = "comment" | "direct_message";

const PERCENT_TRIPLET = /%[0-9a-f]{2}/giu;
const MALFORMED_PERCENT = /%(?![0-9a-f]{2})/iu;
const RAW_C0 = /[\u0000-\u001f\u007f]/u;
const ENCODED_C0 = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu;
const ENCODED_SLASH = /%(?:2f|5c)/iu;

function invalid(): never {
  throw new TypeError("douyin_target_url_invalid");
}

function rawPathAndQuery(value: string) {
  const authority = /^https:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(?:#.*)?$/iu.exec(value);
  if (!authority) invalid();
  return { authority: authority[1]!, path: authority[2] || "/",
    query: authority[3]?.slice(1) ?? null };
}

function rejectAmbiguousComponents(path: string, query: string | null) {
  for (const segment of path.split("/")) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { invalid(); }
    if (decoded === "." || decoded === ".." || /%[0-9a-f]{2}/iu.test(decoded)) invalid();
  }
  if (query !== null) {
    for (const pair of query.split("&")) {
      for (const component of pair.split("=")) {
        let decoded: string;
        try { decoded = decodeURIComponent(component); } catch { invalid(); }
        if (/%[0-9a-f]{2}/iu.test(decoded)) invalid();
      }
    }
  }
}

export function canonicalizeDouyinOutreachTargetUrl(
  kind: OutreachKind,
  value: string
) {
  if ((kind !== "comment" && kind !== "direct_message")
    || typeof value !== "string" || value.length === 0 || value.length > 2_000
    || RAW_C0.test(value) || ENCODED_C0.test(value) || value.includes("\\")
    || ENCODED_SLASH.test(value) || MALFORMED_PERCENT.test(value)) invalid();
  const raw = rawPathAndQuery(value);
  if (/[^\x00-\x7f]/u.test(raw.authority)) invalid();
  rejectAmbiguousComponents(raw.path, raw.query);
  let parsed: URL;
  try { parsed = new URL(value); } catch { invalid(); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || parsed.hostname !== "www.douyin.com" || parsed.port) invalid();
  const expectedPrefix = kind === "comment" ? "video" : "user";
  let pathname = parsed.pathname;
  if (pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  if (!new RegExp(`^/${expectedPrefix}/[A-Za-z0-9_-]{1,300}$`, "u").test(pathname)) {
    invalid();
  }
  const explicitQuery = raw.query !== null;
  const search = parsed.search.replace(PERCENT_TRIPLET, (triplet) => triplet.toUpperCase());
  return `https://www.douyin.com${pathname}${search || (explicitQuery ? "?" : "")}`;
}

export function validateCanonicalDesktopOutreachTimestamp(value: string) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || new Date(value).toISOString() !== value) {
    throw new TypeError("desktop_outreach_timestamp_invalid");
  }
  return value;
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function desktopOutreachRequestHash(input: {
  account_handle: string;
  action_id: string;
  approved_content_hash: string;
  canonical_target_public_url: string;
  content: string;
  kind: OutreachKind;
  login_state_version: number;
}) {
  if (canonicalizeDouyinOutreachTargetUrl(input.kind,
    input.canonical_target_public_url) !== input.canonical_target_public_url) invalid();
  const canonicalJson = canonicalJsonStringify({
    account_handle: input.account_handle,
    action_id: input.action_id,
    approved_content_hash: input.approved_content_hash,
    canonical_target_public_url: input.canonical_target_public_url,
    content: input.content,
    kind: input.kind,
    login_state_version: input.login_state_version
  });
  return { canonicalJson, hash: digest(canonicalJson) };
}

export function desktopOutreachReceiptHash(input: {
  action_id: string;
  failure_code: string | null;
  occurred_at: string;
  platform_receipt_reference: string | null;
  state: "succeeded" | "failed";
}) {
  validateCanonicalDesktopOutreachTimestamp(input.occurred_at);
  const canonicalJson = canonicalJsonStringify({
    action_id: input.action_id,
    failure_code: input.failure_code,
    occurred_at: input.occurred_at,
    platform_receipt_reference: input.platform_receipt_reference,
    state: input.state
  });
  return { canonicalJson, hash: digest(canonicalJson) };
}
