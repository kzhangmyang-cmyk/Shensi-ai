import {
  createFinancialCouncilDraft,
  type FinancialCouncilDraft
} from "./financial-council-draft.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export interface FinancialCouncilDraftCommandResult<T> {
  readonly value: T;
  readonly replayed: boolean;
}

/** Redacted result consumed by the fenced dispatch receipt. */
export interface FinancialCouncilDraftDispatchResult {
  readonly resourceRefs: readonly [{
    readonly kind: "financial_council_draft";
    readonly id: string;
  }];
  readonly contentHash: `sha256:${string}`;
}

export interface FinancialCouncilDraftRepository {
  create(
    draft: FinancialCouncilDraft
  ): Promise<FinancialCouncilDraftCommandResult<FinancialCouncilDraft>>;
  findById(
    context: ActiveWorkspaceContext,
    draftId: string
  ): Promise<FinancialCouncilDraft | null>;
  /** Task 4 probes a persisted dispatch result before attempting any write. */
  probeByDispatchHash(
    context: ActiveWorkspaceContext,
    dispatchHash: `sha256:${string}`
  ): Promise<FinancialCouncilDraftDispatchResult | null>;
  /** The dispatch hash, rather than a caller supplied idempotency key, owns
   * replay of an approved council dispatch. */
  createFromApprovedDispatch(input: {
    readonly dispatchHash: `sha256:${string}`;
    readonly draft: FinancialCouncilDraft;
  }): Promise<FinancialCouncilDraftCommandResult<FinancialCouncilDraftDispatchResult>>;
}

function draftConflict(): Error & { code: string } {
  return Object.assign(new Error("financial_council_draft_conflict"), {
    code: "financial_council_draft_conflict"
  });
}

function assertDispatchHash(value: string): asserts value is `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw Object.assign(new Error("financial_council_draft_invalid"), {
      code: "financial_council_draft_invalid"
    });
  }
}

function stableDraft(value: FinancialCouncilDraft): FinancialCouncilDraft {
  return createFinancialCouncilDraft({
    workspaceId: value.workspaceId, runId: value.runId,
    portfolioRevision: value.portfolioRevision, actionId: value.actionId,
    actionKind: value.actionKind, kind: value.kind,
    approvalId: value.approvalId, approvalHash: value.approvalHash,
    portfolioOutputHash: value.portfolioOutputHash,
    snapshotHash: value.snapshotHash, policyHash: value.policyHash,
    approvedAt: value.approvedAt, createdAt: value.createdAt,
    ...(value.kind === "budget_adjustment_draft" ? { lines: value.lines }
      : value.kind === "finance_todo"
        ? { assigneeId: value.assigneeId, dueAt: value.dueAt }
        : value.kind === "tax_review_task"
          ? { disclaimer: value.disclaimer }
          : { targetRef: value.targetRef })
  });
}

export function financialCouncilDraftDispatchResult(
  draft: FinancialCouncilDraft
): FinancialCouncilDraftDispatchResult {
  return Object.freeze({
    resourceRefs: Object.freeze([Object.freeze({
      kind: "financial_council_draft" as const, id: draft.draftId
    })] as const),
    contentHash: draft.contentHash
  });
}

/** In-memory reference implementation. The stable draft id is the semantic
 * idempotency boundary; records are never interpreted as financial writes. */
export class InMemoryFinancialCouncilDraftRepository
implements FinancialCouncilDraftRepository {
  private readonly drafts = new Map<string, FinancialCouncilDraft>();
  private readonly dispatches = new Map<string, string>();
  private readonly draftDispatches = new Map<string, `sha256:${string}`>();

  async create(
    raw: FinancialCouncilDraft
  ): Promise<FinancialCouncilDraftCommandResult<FinancialCouncilDraft>> {
    const draft = stableDraft(raw);
    const key = `${draft.workspaceId}\u0000${draft.draftId}`;
    const existing = this.drafts.get(key);
    if (existing) {
      if (existing.contentHash !== draft.contentHash) throw draftConflict();
      return { value: existing, replayed: true };
    }
    this.drafts.set(key, draft);
    return { value: draft, replayed: false };
  }

  async findById(
    context: ActiveWorkspaceContext,
    draftId: string
  ): Promise<FinancialCouncilDraft | null> {
    return this.drafts.get(`${context.workspaceId}\u0000${draftId}`) ?? null;
  }

  async probeByDispatchHash(
    context: ActiveWorkspaceContext,
    dispatchHash: `sha256:${string}`
  ): Promise<FinancialCouncilDraftDispatchResult | null> {
    assertDispatchHash(dispatchHash);
    const draftKey = this.dispatches.get(
      `${context.workspaceId}\u0000${dispatchHash}`
    );
    const draft = draftKey ? this.drafts.get(draftKey) ?? null : null;
    return draft ? financialCouncilDraftDispatchResult(draft) : null;
  }

  async createFromApprovedDispatch(input: {
    readonly dispatchHash: `sha256:${string}`;
    readonly draft: FinancialCouncilDraft;
  }): Promise<FinancialCouncilDraftCommandResult<FinancialCouncilDraftDispatchResult>> {
    assertDispatchHash(input.dispatchHash);
    const draft = stableDraft(input.draft);
    const draftKey = `${draft.workspaceId}\u0000${draft.draftId}`;
    const dispatchKey = `${draft.workspaceId}\u0000${input.dispatchHash}`;
    const existingDispatchKey = this.dispatches.get(dispatchKey);
    if (existingDispatchKey) {
      const existing = this.drafts.get(existingDispatchKey);
      if (!existing || existing.contentHash !== draft.contentHash) throw draftConflict();
      return { value: financialCouncilDraftDispatchResult(existing), replayed: true };
    }
    const existing = this.drafts.get(draftKey);
    if (existing && existing.contentHash !== draft.contentHash) throw draftConflict();
    const existingDispatch = this.draftDispatches.get(draftKey);
    if (existingDispatch && existingDispatch !== input.dispatchHash) throw draftConflict();
    const value = existing ?? draft;
    this.drafts.set(draftKey, value);
    this.dispatches.set(dispatchKey, draftKey);
    this.draftDispatches.set(draftKey, input.dispatchHash);
    return {
      value: financialCouncilDraftDispatchResult(value), replayed: Boolean(existing)
    };
  }
}
