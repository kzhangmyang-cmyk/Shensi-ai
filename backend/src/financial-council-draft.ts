import type { FinancialCouncilActionKind } from "./growth-contract-types.js";
import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";

export type FinancialCouncilDraftKind =
  | "budget_adjustment_draft"
  | "finance_todo"
  | "tax_review_task"
  | "data_completion_plan";

export interface DraftBudgetLine {
  readonly scenario: "conservative" | "base" | "optimistic";
  readonly amountMinor: number;
}

/** Exact frozen Growth reference; it authorizes navigation only, never a write. */
export interface FinancialDataGapRef {
  readonly code: "unverified_cost" | "unverified_financial_fact"
    | "missing_cogs" | "unmatched_payment" | "missing_commercial_binding"
    | "import_requires_review";
  readonly sourceType: "cost_entry" | "financial_fact" | "finance_import"
    | "commercial_binding";
  readonly sourceId: string;
  readonly sourceSnapshotHash: `sha256:${string}`;
  readonly cohortId: string | null;
  readonly currency: string;
  readonly asOf: string;
}

interface DraftBase {
  readonly draftId: `sha256:${string}`;
  readonly workspaceId: string;
  readonly runId: string;
  readonly portfolioRevision: number;
  readonly actionId: string;
  readonly actionKind: FinancialCouncilActionKind;
  readonly approvalId: string;
  readonly approvalHash: `sha256:${string}`;
  readonly portfolioOutputHash: `sha256:${string}`;
  readonly snapshotHash: `sha256:${string}`;
  readonly policyHash: `sha256:${string}`;
  readonly approvedAt: string;
  readonly createdAt: string;
  readonly schemaVersion: "financial-council-draft.v1";
  readonly contentHash: `sha256:${string}`;
}

export type FinancialCouncilDraft = DraftBase & (
  | {
      readonly kind: "budget_adjustment_draft";
      readonly lines: readonly DraftBudgetLine[];
    }
  | {
      readonly kind: "finance_todo";
      readonly assigneeId: string | null;
      readonly dueAt: string;
    }
  | {
      readonly kind: "tax_review_task";
      readonly disclaimer: "需专业人员复核";
    }
  | {
      readonly kind: "data_completion_plan";
      readonly targetRef: FinancialDataGapRef;
    }
);

export interface FinancialCouncilDraftCreateInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly portfolioRevision: number;
  readonly actionId: string;
  readonly actionKind: FinancialCouncilActionKind;
  readonly kind: FinancialCouncilDraftKind;
  readonly approvalId: string;
  readonly approvalHash: `sha256:${string}`;
  readonly portfolioOutputHash: `sha256:${string}`;
  readonly snapshotHash: `sha256:${string}`;
  readonly policyHash: `sha256:${string}`;
  readonly approvedAt: string;
  readonly createdAt: string;
  readonly lines?: readonly DraftBudgetLine[];
  readonly assigneeId?: string | null;
  readonly dueAt?: string;
  readonly disclaimer?: string;
  readonly targetRef?: FinancialDataGapRef;
}

const HASH = /^sha256:[0-9a-f]{64}$/u;
const DRAFT_KINDS = new Set<FinancialCouncilDraftKind>([
  "budget_adjustment_draft", "finance_todo", "tax_review_task",
  "data_completion_plan"
]);
const ACTION_KINDS = new Set<FinancialCouncilActionKind>([
  "collect_receivable", "review_loss_product_pricing", "reduce_cost_anomaly",
  "prepare_cash_reserve_budget", "complete_financial_data",
  "schedule_tax_review"
]);

function invalid(): never {
  throw financialCouncilError("financial_council_draft_invalid");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")
    || required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => typeof key === "string"
      && !required.includes(key) && !optional.includes(key))) invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
  }
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 255) {
    return invalid();
  }
  return value;
}

function hash(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !HASH.test(value)) return invalid();
  return value as `sha256:${string}`;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") return invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return invalid();
  }
  return value;
}

function draftKind(value: unknown): FinancialCouncilDraftKind {
  if (typeof value !== "string" || !DRAFT_KINDS.has(value as FinancialCouncilDraftKind)) {
    return invalid();
  }
  return value as FinancialCouncilDraftKind;
}

function actionKind(value: unknown): FinancialCouncilActionKind {
  if (typeof value !== "string" || !ACTION_KINDS.has(value as FinancialCouncilActionKind)) {
    return invalid();
  }
  return value as FinancialCouncilActionKind;
}

function validateLines(value: unknown): readonly DraftBudgetLine[] {
  if (!Array.isArray(value) || value.length !== 3) return invalid();
  const expected = ["conservative", "base", "optimistic"] as const;
  const lines = value.map((candidate, index) => {
    exactObject(candidate, ["scenario", "amountMinor"]);
    if (candidate.scenario !== expected[index]
      || !Number.isSafeInteger(candidate.amountMinor)
      || Number(candidate.amountMinor) < 0) return invalid();
    return Object.freeze({
      scenario: candidate.scenario,
      amountMinor: candidate.amountMinor as number
    });
  });
  return Object.freeze(lines) as readonly DraftBudgetLine[];
}

function validateGapRef(value: unknown): FinancialDataGapRef {
  exactObject(value, ["code", "sourceType", "sourceId", "sourceSnapshotHash",
    "cohortId", "currency", "asOf"]);
  const codes = new Set<FinancialDataGapRef["code"]>([
    "unverified_cost", "unverified_financial_fact", "missing_cogs",
    "unmatched_payment", "missing_commercial_binding", "import_requires_review"
  ]);
  const sources = new Set<FinancialDataGapRef["sourceType"]>([
    "cost_entry", "financial_fact", "finance_import", "commercial_binding"
  ]);
  if (!codes.has(value.code as FinancialDataGapRef["code"])
    || !sources.has(value.sourceType as FinancialDataGapRef["sourceType"])
    || (value.cohortId !== null && typeof value.cohortId !== "string")) {
    return invalid();
  }
  const currency = identifier(value.currency);
  if (!/^[A-Z]{3}$/u.test(currency)) return invalid();
  return Object.freeze({
    code: value.code as FinancialDataGapRef["code"],
    sourceType: value.sourceType as FinancialDataGapRef["sourceType"],
    sourceId: identifier(value.sourceId), sourceSnapshotHash: hash(value.sourceSnapshotHash),
    cohortId: value.cohortId as string | null, currency, asOf: timestamp(value.asOf)
  });
}

export function financialCouncilDraftId(input: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly portfolioRevision: number;
  readonly actionId: string;
  readonly kind: FinancialCouncilDraftKind;
  readonly approvalHash: `sha256:${string}`;
  readonly portfolioOutputHash: `sha256:${string}`;
}): `sha256:${string}` {
  return financialCouncilCanonicalHash({
    workspaceId: identifier(input.workspaceId), runId: identifier(input.runId),
    portfolioRevision: positiveInteger(input.portfolioRevision),
    actionId: hash(input.actionId), kind: draftKind(input.kind),
    approvalHash: hash(input.approvalHash),
    portfolioOutputHash: hash(input.portfolioOutputHash)
  });
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return invalid();
  return value as number;
}

function common(value: Record<string, unknown>) {
  return {
    workspaceId: identifier(value.workspaceId), runId: identifier(value.runId),
    portfolioRevision: positiveInteger(value.portfolioRevision),
    actionId: hash(value.actionId), actionKind: actionKind(value.actionKind),
    approvalId: identifier(value.approvalId), approvalHash: hash(value.approvalHash),
    portfolioOutputHash: hash(value.portfolioOutputHash),
    snapshotHash: hash(value.snapshotHash), policyHash: hash(value.policyHash),
    approvedAt: timestamp(value.approvedAt), createdAt: timestamp(value.createdAt)
  };
}

function contentHash(value: object): `sha256:${string}` {
  const { draftId: _draftId, contentHash: _contentHash,
    createdAt: _createdAt, ...semantic } = value as Record<string, unknown>;
  return financialCouncilCanonicalHash(semantic);
}

/** Creates a council-owned, non-authoritative artifact. It has no execution
 * surface and rejects every key outside its closed representation. */
export function createFinancialCouncilDraft(
  raw: FinancialCouncilDraftCreateInput
): FinancialCouncilDraft {
  try {
    const value = immutableFinancialCouncilInput(raw) as unknown;
    exactObject(value, ["workspaceId", "runId", "portfolioRevision", "actionId",
      "actionKind", "kind", "approvalId", "approvalHash", "portfolioOutputHash",
      "snapshotHash", "policyHash", "approvedAt", "createdAt"], [
      "lines", "assigneeId", "dueAt", "disclaimer", "targetRef"
    ]);
    const base = common(value);
    const kind = draftKind(value.kind);
    const draftId = financialCouncilDraftId({ ...base, kind });
    const commonDraft = { ...base, draftId,
      schemaVersion: "financial-council-draft.v1" as const };
    if (kind === "budget_adjustment_draft") {
      if (base.actionKind !== "prepare_cash_reserve_budget") return invalid();
      const draft = { ...commonDraft, kind, lines: validateLines(value.lines) };
      return immutableFinancialCouncilValue({
        ...draft, contentHash: contentHash(draft)
      }) as FinancialCouncilDraft;
    }
    if (kind === "finance_todo") {
      if (!["collect_receivable", "review_loss_product_pricing",
        "reduce_cost_anomaly"].includes(base.actionKind)
        || (value.assigneeId !== null && value.assigneeId !== undefined
          && typeof value.assigneeId !== "string")) return invalid();
      const draft = { ...commonDraft, kind,
        assigneeId: value.assigneeId === undefined ? null : value.assigneeId,
        dueAt: timestamp(value.dueAt) };
      return immutableFinancialCouncilValue({
        ...draft, contentHash: contentHash(draft)
      }) as FinancialCouncilDraft;
    }
    if (kind === "tax_review_task") {
      if (base.actionKind !== "schedule_tax_review"
        || value.disclaimer !== "需专业人员复核") return invalid();
      const draft = { ...commonDraft, kind,
        disclaimer: "需专业人员复核" as const };
      return immutableFinancialCouncilValue({
        ...draft, contentHash: contentHash(draft)
      }) as FinancialCouncilDraft;
    }
    if (base.actionKind !== "complete_financial_data") return invalid();
    const draft = { ...commonDraft, kind,
      targetRef: validateGapRef(value.targetRef) };
    return immutableFinancialCouncilValue({
      ...draft, contentHash: contentHash(draft)
    }) as FinancialCouncilDraft;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code
      === "financial_council_draft_invalid") throw error;
    return invalid();
  }
}
