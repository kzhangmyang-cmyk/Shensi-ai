import type { components } from "../generated/ai-acquisition.js";
export type CentralSchemas = components["schemas"];
type Check = (value: unknown) => void;
export function invalid(): never { throw new Error("central_protocol_invalid"); }
export const literal = (expected: unknown): Check => (value) => { if (value !== expected) invalid(); };
export function string(value: unknown): asserts value is string { if (typeof value !== "string") invalid(); }
export const token: Check = (value) => { string(value); if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) invalid(); };
export const bareHash: Check = (value) => { string(value); if (!/^[a-f0-9]{64}$/u.test(value)) invalid(); };
export const safeId: Check = (value) => {
  string(value); if (!value.length || [...value].length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
};
export function object(value: unknown, fields: Record<string, Check>, optional: Record<string, Check> = {}): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !Object.hasOwn(fields, key) && !Object.hasOwn(optional, key))) invalid();
  for (const [key, check] of Object.entries(fields)) check(record[key]);
  for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(record, key)) check(record[key]);
}
export function registrationRequest(value: unknown): asserts value is CentralSchemas["DesktopRegistrationRequest"] {
  object(value, { protocolVersion: literal(1), installationId: token, enrollmentToken: token });
}
export function registrationResponse(value: unknown): asserts value is CentralSchemas["DesktopRegistrationResponse"] {
  object(value, { protocolVersion: literal(1), workspaceId: safeId, deviceToken: token });
}

const bool: Check = (value) => { if (typeof value !== "boolean") invalid(); };
const integer = (minimum: number): Check => (value) => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid();
};
const version = integer(1);
const handle: Check = (value) => { string(value); if (!/^dyacct_[a-f0-9]{64}$/u.test(value)) invalid(); };
const timestamp: Check = (value) => {
  string(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
};
const oneOf = (choices: readonly unknown[]): Check => (value) => { if (!choices.includes(value)) invalid(); };
const states = ["executing", "succeeded", "failed", "queued", "risk_paused", "reconciliation_required"] as const;
const accountFields = { accountId: safeId, accountHandle: handle, loginStateVersion: version, bindingGeneration: version };
const requestFields = { protocolVersion: literal(1), processInstanceId: token };
export function claimRequest(value: unknown): asserts value is CentralSchemas["DesktopOutreachClaimRequest"] {
  object(value, { ...requestFields, waitSeconds: literal(0), availableAccounts: (accounts) => {
    if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 100) invalid();
    const ids = new Set();
    for (const account of accounts) {
      object(account, accountFields);
      if (ids.has(account.accountId)) invalid();
      ids.add(account.accountId);
    }
  } });
}
const taskFields = { actionId: safeId, workspaceId: safeId, accountId: safeId,
  accountHandle: handle, loginStateVersion: version, executorBindingGeneration: version,
  kind: oneOf(["comment", "direct_message"]), canonicalTargetPublicUrl: (value: unknown) => {
    string(value); try { new URL(value); } catch { invalid(); }
  }, content: string, approvedContentHash: (value: unknown) => {
    string(value); if (!/^sha256:[a-f0-9]{64}$/u.test(value)) invalid();
  }, taskRequestHash: bareHash, deadlineAt: timestamp, leaseVersion: version };
export function claimResponse(value: unknown): asserts value is CentralSchemas["DesktopOutreachClaimResponse"] {
  const kind = discriminant(value, "kind");
  if (kind === "empty") {
    object(value, { kind: literal(kind), serverTime: timestamp, retryAfterMs: integer(0), replayed: bool });
  } else if (kind === "reconcile") {
    object(value, { kind: literal(kind), serverTime: timestamp, replayed: bool, taskToken: token,
      task: reconciliationTask });
  } else if (kind === "claimed") {
    object(value, { kind: literal(kind), serverTime: timestamp, replayed: bool, taskToken: token,
      task: (task) => object(task, { ...taskFields, leaseExpiresAt: timestamp,
        predecessorReceipt: (receipt) => { if (receipt !== null) string(receipt); } }) });
  } else invalid();
}
const failures = ["action_unavailable", "action_rejected", "deadline_exceeded", "douyin_verification_required",
  "douyin_rate_limited", "douyin_account_warning", "douyin_account_identity_changed", "douyin_login_expired",
  "douyin_direct_message_unavailable", "douyin_action_control_missing", "douyin_action_control_ambiguous",
  "douyin_action_content_mismatch", "douyin_action_receipt_ambiguous", "douyin_action_timeout", "douyin_profile_busy"] as const;
function receipt(value: unknown) {
  const state = discriminant(value, "state");
  const fields = { actionId: safeId, occurredAt: timestamp, state: literal(state) };
  if (state === "succeeded") {
    object(value, { ...fields, failureCode: literal(null), platformReceiptReference: (reference) => {
      string(reference); if (!reference.length || [...reference].length > 255) invalid();
    } });
  } else if (state === "failed") {
    object(value, { ...fields, platformReceiptReference: literal(null), failureCode: oneOf(failures) });
  } else invalid();
}
export function completeRequest(value: unknown): asserts value is CentralSchemas["DesktopOutreachCompleteRequest"] {
  object(value, { ...requestFields, bindingGeneration: version, command: (command) => {
    const event = discriminant(command, "event");
    const frozen = { event: literal(event), leaseVersion: version, loginStateVersion: version, taskRequestHash: bareHash };
    if (event === "started") object(command, { ...frozen, occurredAt: timestamp });
    else if (event === "receipt") {
      object(command, { ...frozen, reconciliation: bool, receipt });
      const receiptValue = command.receipt as Record<string, unknown>;
      if (command.reconciliation && receiptValue.failureCode !== null
        && receiptValue.failureCode !== "action_unavailable"
        && receiptValue.failureCode !== "douyin_action_receipt_ambiguous") invalid();
    } else invalid();
  } });
}
export function completionResponse(value: unknown): asserts value is CentralSchemas["DesktopOutreachCompletionResponse"] {
  object(value, { actionId: safeId, state: oneOf(states), replayed: bool, accountPaused: bool, occurredAt: timestamp });
}
export function reconcileRequest(value: unknown): asserts value is CentralSchemas["DesktopOutreachReconcileRequest"] {
  const phase = discriminant(value, "journalPhase");
  const fields = { ...requestFields, ...accountFields, originalLeaseVersion: version,
    taskRequestHash: bareHash, journalPhase: oneOf(["claimed", "central_started", "sidecar_completed"]) };
  object(value, phase === "sidecar_completed" ? { ...fields, receiptHash: bareHash } : fields);
}
export function reconcileResponse(value: unknown): asserts value is CentralSchemas["DesktopOutreachReconcileResponse"] {
  const kind = discriminant(value, "kind");
  const fields = { kind: literal(kind), replayed: bool };
  if (kind === "waiting") object(value, { ...fields, retryAfterMs: integer(0) });
  else if (kind === "released") object(value, { ...fields, actionId: safeId,
    taskRequestHash: bareHash, originalLeaseVersion: version });
  else if (kind === "terminal") object(value, { ...fields, status: oneOf(states), receiptHash: bareHash });
  else if (kind === "not_authorized") object(value, fields);
  else if (kind === "reconcile") object(value, { ...fields, taskToken: token, task: reconciliationTask });
  else invalid();
}
function reconciliationTask(task: unknown) {
  const rotated = typeof task === "object" && task !== null && "observationLoginStateVersion" in task;
  object(task, { ...taskFields, originalLeaseVersion: version,
    reconciliationGeneration: version, capability: literal("reconcile_only"),
    ...(rotated ? { observationLoginStateVersion: version } : {}) });
  if (rotated && Number(task.observationLoginStateVersion) <= Number(task.loginStateVersion)) invalid();
}
function discriminant(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return (value as Record<string, unknown>)[key];
}
