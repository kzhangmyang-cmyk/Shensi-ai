import { createHash } from "node:crypto";

// Main-to-Sidecar private projection. Central credentials and fences are not part
// of this transport; only an already-authorized immutable action reaches it.
export interface LocalDouyinAction {
  actionId: string;
  accountHandle: string;
  loginStateVersion: number;
  observationLoginStateVersion?: number;
  kind: "comment" | "direct_message";
  canonicalTargetPublicUrl: string;
  content: string;
  approvedContentHash: string;
  taskRequestHash: string;
  deadlineAt: string;
}

const failures = ["action_unavailable", "action_rejected", "deadline_exceeded",
  "douyin_verification_required", "douyin_rate_limited", "douyin_account_warning",
  "douyin_account_identity_changed", "douyin_login_expired", "douyin_direct_message_unavailable",
  "douyin_action_control_missing", "douyin_action_control_ambiguous", "douyin_action_content_mismatch",
  "douyin_action_receipt_ambiguous", "douyin_action_timeout", "douyin_profile_busy"] as const;
export type LocalDouyinReceipt = {
  actionId: string; occurredAt: string;
} & ({ state: "succeeded"; platformReceiptReference: string; failureCode: null }
  | { state: "failed"; platformReceiptReference: null; failureCode: typeof failures[number] });

function invalid(): never { throw new TypeError("sidecar_action_protocol_invalid"); }
export function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) invalid();
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 255): string {
  if (typeof value !== "string" || !value.length || [...value].length > max
    || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}
export function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}
export function bareHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalid();
  return value;
}
export function actionIdentifier(value: unknown): string {
  const id = text(value);
  // IDs are always a single path segment, not URL navigation instructions.
  if (id === "." || id === ".." || /[/\\]/u.test(id)) invalid();
  return id;
}
export function accountHandle(value: unknown): string {
  if (typeof value !== "string" || !/^dyacct_[a-f0-9]{64}$/u.test(value)) invalid();
  return value;
}
export function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}

export function acknowledgementTimestamp(value: unknown): string {
  // Acknowledgement is not signed/hash input. Pydantic UTC datetimes emit zero
  // or six fractional digits; accept those without weakening receipt hashing.
  if (typeof value !== "string") invalid();
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/u.exec(value);
  if (!match) invalid();
  canonicalTimestamp(`${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`);
  return value;
}

// This only validates the central douyin-target-url-v1 serialization. It never
// normalizes or replaces the frozen target, including duplicate/empty query pairs.
function canonicalTarget(kind: LocalDouyinAction["kind"], value: unknown): string {
  if (kind !== "comment" && kind !== "direct_message") invalid();
  const url = text(value, 2000);
  const prefix = kind === "comment" ? "video" : "user";
  if (!new RegExp(`^https://www\\.douyin\\.com/${prefix}/[A-Za-z0-9_-]{1,300}(?:\\?[^#]*)?$`, "u").test(url)
    || /\\|%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c)|%(?![0-9A-F]{2})/iu.test(url)
    || (url.match(/%[0-9A-Fa-f]{2}/gu) ?? []).some((p) => p !== p.toUpperCase())) invalid();
  try {
    if (new URL(url).href !== url) invalid();
    const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    for (const component of query.split(/[&=]/u)) {
      if (/%[0-9a-f]{2}/iu.test(decodeURIComponent(component))) invalid();
    }
  } catch { invalid(); }
  return url;
}
function hash(value: object): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
export function actionWireRequest(input: LocalDouyinAction) {
  const canonical = {
    account_handle: accountHandle(input.accountHandle),
    action_id: actionIdentifier(input.actionId),
    approved_content_hash: input.approvedContentHash,
    canonical_target_public_url: canonicalTarget(input.kind, input.canonicalTargetPublicUrl),
    content: input.content,
    kind: input.kind,
    login_state_version: positiveVersion(input.loginStateVersion)
  };
  if (typeof input.content !== "string" || !input.content.length
    || typeof input.approvedContentHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.approvedContentHash)
    || hash(canonical) !== bareHash(input.taskRequestHash)) invalid();
  return { ...canonical, deadline_at: canonicalTimestamp(input.deadlineAt), request_hash: input.taskRequestHash };
}

export function mapActionReceipt(input: unknown, expectedActionId: string): { receipt: LocalDouyinReceipt; receiptHash: string } {
  const value = strictObject(input, ["action_id", "failure_code", "occurred_at", "platform_receipt_reference", "state"]);
  if (value.action_id !== expectedActionId) invalid();
  const occurredAt = canonicalTimestamp(value.occurred_at);
  let receipt: LocalDouyinReceipt;
  if (value.state === "succeeded" && value.failure_code === null) {
    receipt = { actionId: expectedActionId, state: "succeeded", occurredAt,
      platformReceiptReference: text(value.platform_receipt_reference), failureCode: null };
  } else if (value.state === "failed" && value.platform_receipt_reference === null
    && failures.includes(value.failure_code as typeof failures[number])) {
    receipt = { actionId: expectedActionId, state: "failed", occurredAt,
      platformReceiptReference: null, failureCode: value.failure_code as typeof failures[number] };
  } else invalid();
  const receiptHash = hash({ action_id: receipt.actionId, failure_code: receipt.failureCode,
    occurred_at: receipt.occurredAt, platform_receipt_reference: receipt.platformReceiptReference, state: receipt.state });
  return { receipt, receiptHash };
}
