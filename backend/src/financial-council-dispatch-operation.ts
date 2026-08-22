import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import type { FinancialCouncilPortfolioKind } from
  "./growth-contract-types.js";

export type FinancialCouncilDispatchOperationStatus =
  | "queued" | "running" | "retry" | "succeeded" | "failed";

export interface FinancialCouncilDispatchOperation {
  readonly dispatchId: `sha256:${string}`;
  readonly dispatchHash: `sha256:${string}`;
  readonly workspaceId: string;
  readonly runId: string;
  readonly approvalId: `sha256:${string}`;
  readonly approvalHash: `sha256:${string}`;
  readonly portfolioRevision: number;
  readonly portfolioKind: FinancialCouncilPortfolioKind;
  readonly actionId: string;
  readonly actionHash: `sha256:${string}`;
  readonly resultHash: `sha256:${string}`;
  readonly portfolioOutputHash: `sha256:${string}`;
  readonly status: FinancialCouncilDispatchOperationStatus;
  readonly attempt: number;
  readonly leaseWorkerId: string | null;
  readonly leaseToken: string | null;
  readonly claimedAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly receiptId: `sha256:${string}` | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateFinancialCouncilDispatchOperationInput {
  readonly dispatchId: `sha256:${string}`;
  readonly workspaceId: string;
  readonly runId: string;
  readonly approvalId: `sha256:${string}`;
  readonly approvalHash: `sha256:${string}`;
  readonly portfolioRevision: number;
  readonly portfolioKind: FinancialCouncilPortfolioKind;
  readonly actionId: string;
  readonly actionHash: `sha256:${string}`;
  readonly resultHash: `sha256:${string}`;
  readonly portfolioOutputHash: `sha256:${string}`;
  readonly createdAt: string;
}

export interface FinancialCouncilDispatchLease {
  readonly dispatchId: `sha256:${string}`;
  readonly workspaceId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly attempt: number;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
}

export interface CompleteFinancialCouncilDispatchOperationInput {
  readonly workerId: string;
  readonly leaseToken: string;
  readonly attempt: number;
  readonly completedAt: string;
  readonly receiptId: `sha256:${string}`;
}

export interface FinancialCouncilDispatchReceipt {
  readonly receiptId: `sha256:${string}`;
  readonly dispatchId: `sha256:${string}`;
  readonly workspaceId: string;
  readonly dispatchHash: `sha256:${string}`;
  readonly resourceRefs: readonly { readonly kind: string; readonly id: string }[];
  readonly contentHash: `sha256:${string}`;
  readonly createdAt: string;
}

export interface ClaimFinancialCouncilDispatchOperationInput {
  readonly workerId: string;
  readonly leaseToken: string;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
}

const HASH = /^sha256:[0-9a-f]{64}$/u;
const LEASE_TOKEN = /^[0-9a-f]{64}$/u;
const KINDS = new Set<FinancialCouncilPortfolioKind>([
  "cash_first", "growth_first", "balanced"
]);

function invalid(code = "financial_council_dispatch_invalid"): never {
  throw financialCouncilError(code);
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value === ""
    || value.length > 255) invalid();
  return value;
}

function hash(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !HASH.test(value)) invalid();
  return value as `sha256:${string}`;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) invalid();
  return value;
}

function positive(value: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    invalid();
  }
  return Number(value);
}

function dispatchPreimage(input: Omit<FinancialCouncilDispatchOperation,
"dispatchHash" | "status" | "attempt" | "leaseWorkerId" | "leaseToken"
| "claimedAt" | "leaseExpiresAt" | "receiptId" | "lastErrorCode" | "updatedAt">): object {
  return {
    workspaceId: input.workspaceId,
    runId: input.runId,
    approvalId: input.approvalId,
    approvalHash: input.approvalHash,
    portfolioRevision: input.portfolioRevision,
    portfolioKind: input.portfolioKind,
    actionId: input.actionId,
    actionHash: input.actionHash,
    resultHash: input.resultHash,
    portfolioOutputHash: input.portfolioOutputHash
  };
}

export function financialCouncilDispatchHash(input:
Pick<FinancialCouncilDispatchOperation, "workspaceId" | "runId" | "approvalId"
| "approvalHash" | "portfolioRevision" | "portfolioKind" | "actionId"
| "actionHash" | "resultHash" | "portfolioOutputHash">): `sha256:${string}` {
  return financialCouncilCanonicalHash(dispatchPreimage({
    dispatchId: "sha256:" + "0".repeat(64) as `sha256:${string}`,
    ...input,
    createdAt: "1970-01-01T00:00:00.000Z"
  }));
}

export function createFinancialCouncilDispatchOperation(
  raw: CreateFinancialCouncilDispatchOperationInput
): FinancialCouncilDispatchOperation {
  const input = immutableFinancialCouncilInput(raw);
  const keys = Object.keys(input);
  const expected = ["dispatchId", "workspaceId", "runId", "approvalId",
    "approvalHash", "portfolioRevision", "portfolioKind", "actionId",
    "actionHash", "resultHash", "portfolioOutputHash", "createdAt"];
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(
    input, key)) || keys.some((key) => !expected.includes(key))) invalid();
  const value = {
    dispatchId: hash(input.dispatchId), workspaceId: identifier(input.workspaceId),
    runId: identifier(input.runId), approvalId: hash(input.approvalId),
    approvalHash: hash(input.approvalHash),
    portfolioRevision: positive(input.portfolioRevision),
    portfolioKind: input.portfolioKind,
    actionId: identifier(input.actionId), actionHash: hash(input.actionHash),
    resultHash: hash(input.resultHash),
    portfolioOutputHash: hash(input.portfolioOutputHash),
    createdAt: timestamp(input.createdAt)
  };
  if (typeof value.portfolioKind !== "string" || !KINDS.has(value.portfolioKind)) {
    invalid();
  }
  return immutableFinancialCouncilValue({
    ...value,
    dispatchHash: financialCouncilDispatchHash(value),
    status: "queued" as const,
    attempt: 0,
    leaseWorkerId: null,
    leaseToken: null,
    claimedAt: null,
    leaseExpiresAt: null,
    receiptId: null,
    lastErrorCode: null,
    updatedAt: value.createdAt
  });
}

export function claimFinancialCouncilDispatchOperation(
  operation: FinancialCouncilDispatchOperation,
  input: ClaimFinancialCouncilDispatchOperationInput
): { readonly operation: FinancialCouncilDispatchOperation;
  readonly lease: FinancialCouncilDispatchLease } | null {
  const claimedAt = timestamp(input.claimedAt);
  const leaseExpiresAt = timestamp(input.leaseExpiresAt);
  if (!input.workerId.trim() || !LEASE_TOKEN.test(input.leaseToken)
    || Date.parse(leaseExpiresAt) <= Date.parse(claimedAt)) invalid();
  const claimable = operation.status === "queued" || operation.status === "retry"
    || (operation.status === "running" && operation.leaseExpiresAt !== null
      && Date.parse(operation.leaseExpiresAt) <= Date.parse(claimedAt));
  if (!claimable) return null;
  const attempt = operation.attempt + 1;
  const next = immutableFinancialCouncilValue({
    ...operation, status: "running" as const, attempt,
    leaseWorkerId: input.workerId, leaseToken: input.leaseToken,
    claimedAt, leaseExpiresAt, updatedAt: claimedAt
  });
  return immutableFinancialCouncilValue({
    operation: next,
    lease: {
      dispatchId: next.dispatchId, workspaceId: next.workspaceId,
      workerId: next.leaseWorkerId!, leaseToken: next.leaseToken!, attempt,
      claimedAt, leaseExpiresAt
    }
  });
}

function assertLiveLease(
  operation: FinancialCouncilDispatchOperation,
  input: Pick<FinancialCouncilDispatchLease, "workerId" | "leaseToken" | "attempt">
  & { readonly completedAt: string }
): void {
  if (operation.status !== "running" || operation.leaseWorkerId !== input.workerId
    || operation.leaseToken !== input.leaseToken || operation.attempt !== input.attempt
    || operation.leaseExpiresAt === null
    || Date.parse(input.completedAt) >= Date.parse(operation.leaseExpiresAt)) {
    throw financialCouncilError("financial_council_dispatch_lease_stale");
  }
}

export function completeFinancialCouncilDispatchOperation(
  operation: FinancialCouncilDispatchOperation,
  input: CompleteFinancialCouncilDispatchOperationInput
): FinancialCouncilDispatchOperation {
  const completedAt = timestamp(input.completedAt);
  if (!LEASE_TOKEN.test(input.leaseToken) || !input.workerId.trim()
    || !HASH.test(input.receiptId) || !Number.isSafeInteger(input.attempt)
    || input.attempt < 1) invalid();
  assertLiveLease(operation, { ...input, completedAt });
  return immutableFinancialCouncilValue({
    ...operation, status: "succeeded" as const, receiptId: input.receiptId,
    lastErrorCode: null, updatedAt: completedAt
  });
}

export function failFinancialCouncilDispatchOperation(
  operation: FinancialCouncilDispatchOperation,
  input: Pick<CompleteFinancialCouncilDispatchOperationInput,
  "workerId" | "leaseToken" | "attempt" | "completedAt"> & {
    readonly errorCode: string;
    readonly retryable: boolean;
  }
): FinancialCouncilDispatchOperation {
  const completedAt = timestamp(input.completedAt);
  if (!LEASE_TOKEN.test(input.leaseToken) || !input.workerId.trim()
    || !Number.isSafeInteger(input.attempt) || input.attempt < 1
    || !/^[a-z0-9_]{3,96}$/u.test(input.errorCode)) invalid();
  assertLiveLease(operation, { ...input, completedAt });
  return immutableFinancialCouncilValue({
    ...operation, status: input.retryable ? "retry" as const : "failed" as const,
    leaseWorkerId: null, leaseToken: null, claimedAt: null, leaseExpiresAt: null,
    lastErrorCode: input.errorCode, updatedAt: completedAt
  });
}
