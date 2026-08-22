import { createHash } from "node:crypto";
import type {
  BusinessCurrency,
  BusinessReportInput
} from "./business-advisor/domain.js";
import type {
  ConsensusReport,
  FinancialCouncilActionPortfolio,
  FinancialCouncilApproval,
  FinancialCouncilRunStatus
} from "./growth-contract-types.js";

export const FINANCIAL_COUNCIL_RUN_STATUSES = Object.freeze([
  "created",
  "snapshot_frozen",
  "analyzing",
  "auditing",
  "synthesizing",
  "optimizing",
  "awaiting_approval",
  "approved",
  "rejected",
  "stale",
  "expired",
  "failed",
  "not_computable"
] as const satisfies readonly FinancialCouncilRunStatus[]);

export type FinancialCouncilTransitionKind = Exclude<
  FinancialCouncilRunStatus,
  "created"
>;

export interface FinancialCouncilRun {
  readonly runId: string;
  readonly workspaceId: string;
  readonly creationKeyHash: `sha256:${string}`;
  readonly requestHash: `sha256:${string}`;
  readonly currency: BusinessCurrency;
  readonly status: FinancialCouncilRunStatus;
  readonly revision: number;
  readonly dataAsOf: string;
  readonly businessReport: BusinessReportInput;
  readonly policyVersionId: string;
  readonly snapshotId: string | null;
  readonly snapshotHash: `sha256:${string}` | null;
  readonly consensusReport: ConsensusReport | null;
  readonly portfolios: readonly FinancialCouncilActionPortfolio[];
  readonly latestPortfolioRevision: number | null;
  readonly approval: FinancialCouncilApproval | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

export interface FinancialCouncilTransitionInput {
  readonly kind: FinancialCouncilTransitionKind;
  readonly occurredAt: string;
  readonly actorId: string;
}

export interface FinancialCouncilRunEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly fromStatus: FinancialCouncilRunStatus | null;
  readonly toStatus: FinancialCouncilRunStatus;
  readonly reasonCode: string | null;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly aggregateSnapshotHash: `sha256:${string}`;
  readonly aggregateSnapshot: FinancialCouncilRun;
}

export interface FinancialSnapshotRecord {
  readonly snapshotId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

const PROGRESSIVE_TRANSITIONS: Readonly<
  Partial<Record<FinancialCouncilRunStatus, FinancialCouncilRunStatus>>
> = Object.freeze({
  created: "snapshot_frozen",
  snapshot_frozen: "analyzing",
  analyzing: "auditing",
  auditing: "synthesizing",
  synthesizing: "optimizing",
  optimizing: "awaiting_approval"
});

const TERMINAL_STATUSES = new Set<FinancialCouncilRunStatus>([
  "approved", "rejected", "stale", "expired", "failed", "not_computable"
]);

const FINANCIAL_COUNCIL_ERRORS = new WeakSet<object>();

export class FinancialCouncilError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FinancialCouncilError";
    FINANCIAL_COUNCIL_ERRORS.add(this);
  }
}

export function financialCouncilError(code: string): FinancialCouncilError {
  return new FinancialCouncilError(code);
}

export function isFinancialCouncilError(
  value: unknown
): value is FinancialCouncilError {
  return !!value && typeof value === "object"
    && FINANCIAL_COUNCIL_ERRORS.has(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function materializeJsonValue(
  value: unknown,
  ancestors: WeakSet<object>
): unknown {
  if (value === null || typeof value === "string"
    || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidJson();
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) invalidJson();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor)
        || lengthDescriptor.enumerable
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0) invalidJson();
      const length = lengthDescriptor.value as number;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1
        || keys.some((key) => typeof key !== "string"
          || (key !== "length" && (!/^(0|[1-9][0-9]*)$/u.test(key)
            || Number(key) >= length)))) invalidJson();
      const copy: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) invalidJson();
        copy.push(materializeJsonValue(descriptor.value, ancestors));
      }
      return Object.freeze(copy);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) invalidJson();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) invalidJson();
    const copy: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) invalidJson();
      Object.defineProperty(copy, key, {
        value: materializeJsonValue(descriptor.value, ancestors),
        enumerable: true,
        configurable: false,
        writable: false
      });
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

export function immutableFinancialCouncilInput<T>(value: T): T {
  try {
    return materializeJsonValue(value, new WeakSet()) as T;
  } catch (error) {
    if ((error as { code?: unknown }).code === "financial_council_input_invalid") {
      throw error;
    }
    invalidJson();
  }
}

export function immutableFinancialCouncilValue<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export function financialCouncilCanonicalHash(
  value: unknown
): `sha256:${string}` {
  const encoded = financialCouncilCanonicalJson(value);
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

function invalidJson(): never {
  throw financialCouncilError("financial_council_input_invalid");
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodeCanonicalJson(
  value: unknown,
  ancestors: WeakSet<object>
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidJson();
    return JSON.stringify(value);
  }
  if (typeof value !== "object") invalidJson();
  if (ancestors.has(value)) invalidJson();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length
        || keys.some((key, index) => key !== String(index))) {
        invalidJson();
      }
      return `[${value.map((item) =>
        encodeCanonicalJson(item, ancestors)).join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) invalidJson();
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) invalidJson();
    const keys = (ownKeys as string[]).sort(codeUnitCompare);
    const entries: string[] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) invalidJson();
      entries.push(`${JSON.stringify(key)}:${
        encodeCanonicalJson(descriptor.value, ancestors)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function financialCouncilCanonicalJson(value: unknown): string {
  return encodeCanonicalJson(
    immutableFinancialCouncilInput(value),
    new WeakSet()
  );
}

export function financialCouncilAggregateHash(
  aggregate: FinancialCouncilRun
): `sha256:${string}` {
  return financialCouncilCanonicalHash(aggregate);
}

export function applyFinancialCouncilTransition(
  current: FinancialCouncilRun,
  input: FinancialCouncilTransitionInput
): FinancialCouncilRun {
  if (!financialCouncilTransitionIsAllowed(current.status, input.kind)) {
    throw financialCouncilError("financial_council_transition_invalid");
  }
  return immutableFinancialCouncilValue({
    ...current,
    status: input.kind,
    revision: current.revision + 1,
    updatedAt: input.occurredAt
  });
}

export function financialCouncilTransitionIsAllowed(
  from: FinancialCouncilRunStatus,
  to: FinancialCouncilTransitionKind
): boolean {
  if (TERMINAL_STATUSES.has(from)) return false;
  const progressive = PROGRESSIVE_TRANSITIONS[from];
  return to === progressive
    || (from === "awaiting_approval"
      && ["approved", "rejected", "stale", "expired"].includes(to))
    || to === "failed"
    || to === "not_computable";
}

export function createFinancialCouncilRunEvent(
  aggregate: FinancialCouncilRun,
  input: {
    readonly fromStatus: FinancialCouncilRunStatus | null;
    readonly reasonCode: string | null;
    readonly occurredAt: string;
    readonly actorId: string;
  }
): FinancialCouncilRunEvent {
  return immutableFinancialCouncilValue({
    eventId: `${aggregate.runId}:${aggregate.revision}`,
    runId: aggregate.runId,
    workspaceId: aggregate.workspaceId,
    revision: aggregate.revision,
    fromStatus: input.fromStatus,
    toStatus: aggregate.status,
    reasonCode: input.reasonCode,
    occurredAt: input.occurredAt,
    actorId: input.actorId,
    aggregateSnapshotHash: financialCouncilAggregateHash(aggregate),
    aggregateSnapshot: aggregate
  });
}
