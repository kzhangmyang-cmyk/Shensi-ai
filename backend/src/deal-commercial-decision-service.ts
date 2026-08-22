import { createHash, randomUUID } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { requireExpectedRevision,
  type CommandContext } from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import { executeGrowthIdempotentCommand } from
  "./growth-http-idempotency-repository.js";
import type { QuoteCommandExecution } from "./quote-case-service.js";
import type { QuoteCrmCommand } from "./quote-crm-command.js";
import type {
  DealCommercialDecisionPersistenceInput,
  DealCommercialDecisionPersistenceResult,
  QuoteRepository
} from "./quote-repository.js";

export type DealCommercialDecisionInput =
  DealCommercialDecisionPersistenceInput;
export interface DealCommercialDecisionResult {
  readonly deal: DealCommercialDecisionPersistenceResult["deal"];
  readonly event: Readonly<{
    id: string;
    dealId: string;
    type: "won" | "lost";
    commercialAuthority: "quote_projection" | "pre_quote_disqualified";
    quoteCaseIdSnapshot: string | null;
    quoteVersionIdSnapshot: string | null;
    commercialAmountHash: `sha256:${string}` | null;
    amountMinorSnapshot: number | null;
    currencySnapshot: string | null;
    reasonCode: string | null;
    reasonText: string | null;
    occurredAt: string;
    recordedAt: string;
    authorityRevision: number;
  }>;
  readonly quoteCase: DealCommercialDecisionPersistenceResult["quoteCase"];
  readonly authorityRevision: number;
  readonly cancelledPublicationOperationIds: readonly string[];
}

export class DealCommercialDecisionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DealCommercialDecisionError";
  }
}

function fail(code: string): never {
  throw new DealCommercialDecisionError(code);
}

function exactInstant(value: string) {
  let normalized = "";
  try { normalized = new Date(value).toISOString(); } catch { /* invalid */ }
  if (!value || normalized !== value) {
    fail("invalid_deal_decision_occurred_at");
  }
  return value;
}

function text(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function stableHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "")
    .digest("hex")}`;
}

export interface DealCommercialDecisionServiceOptions {
  readonly repository: QuoteRepository;
  readonly crm: QuoteCrmCommand;
  readonly foundation: Pick<GrowthFoundationServices, "httpIdempotency">;
  readonly now?: () => string;
  readonly executionId?: () => string;
}

export class DealCommercialDecisionService {
  readonly #now: () => string;
  readonly #executionId: () => string;

  constructor(private readonly options: DealCommercialDecisionServiceOptions) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#executionId = options.executionId
      ?? (() => `deal-decision-${randomUUID()}`);
  }

  async decide(
    command: CommandContext,
    dealId: string,
    rawInput: DealCommercialDecisionInput
  ): Promise<QuoteCommandExecution<DealCommercialDecisionResult>> {
    requireGrowthCapabilities(command.workspace, ["quote.confirm"]);
    if (command.actorId !== command.workspace.actorId) {
      fail("growth_actor_context_mismatch");
    }
    const normalizedDealId = dealId.trim();
    if (!normalizedDealId) fail("invalid_deal_id");
    const expectedAuthorityRevision = requireExpectedRevision(command);
    const input = rawInput.type === "pre_quote_disqualified"
      ? Object.freeze({ type: rawInput.type,
          reasonCode: rawInput.reasonCode.trim(),
          reasonText: text(rawInput.reasonText),
          occurredAt: exactInstant(rawInput.occurredAt) })
      : Object.freeze({ type: rawInput.type,
          quoteVersionId: rawInput.quoteVersionId.trim(),
          commercialAmountHash: rawInput.commercialAmountHash,
          reasonCode: text(rawInput.reasonCode),
          reasonText: text(rawInput.reasonText),
          occurredAt: exactInstant(rawInput.occurredAt) });
    if (input.type === "pre_quote_disqualified" && !input.reasonCode) {
      fail("pre_quote_disqualification_reason_required");
    }
    if (input.type !== "pre_quote_disqualified"
      && (!input.quoteVersionId
        || !/^sha256:[0-9a-f]{64}$/u.test(input.commercialAmountHash))) {
      fail("invalid_deal_decision_input");
    }
    const stableCommandHash = stableHash({
      schemaVersion: "deal-commercial-decision.v1",
      workspaceId: command.workspace.workspaceId,
      actorId: command.actorId,
      dealId: normalizedDealId,
      expectedAuthorityRevision,
      input,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash
    });
    const persistence = Object.freeze({
      workspaceId: command.workspace.workspaceId,
      actorId: command.actorId,
      dealId: normalizedDealId,
      expectedAuthorityRevision,
      input,
      stableCommandHash,
      requestHash: command.requestHash
    });
    const execution = await executeGrowthIdempotentCommand({
      repository: this.options.foundation.httpIdempotency,
      reservation: {
        workspaceId: command.workspace.workspaceId,
        actorId: command.actorId,
        method: "POST",
        canonicalPath: "/api/v1/quotes/deals/:dealId/decision",
        key: command.idempotencyKey,
        requestHash: command.requestHash,
        attemptedAt: this.#now(),
        leaseOwner: this.#executionId(),
        leaseDurationMs: 30_000
      }
    }, async (resourceId) => {
      const result = await this.options.crm.decideDeal(persistence);
      if (resourceId !== result.event.id) {
        fail("idempotency_reference_invalid");
      }
      return result;
    }, async () => {
      const committed = await this.options.repository
        .findDealDecisionByStableCommandHash(
          command.workspace.workspaceId, stableCommandHash
        );
      const result = committed ?? await this.options.crm.decideDeal(persistence);
      return { resourceId: result.event.id, operationId: null };
    });
    const persisted = execution.value;
    const event = persisted.event;
    return Object.freeze({ value: Object.freeze({
      deal: persisted.deal,
      event: Object.freeze({
        id: event.id, dealId: event.dealId,
        type: event.type as "won" | "lost",
        commercialAuthority: event.commercialAuthority as
          "quote_projection" | "pre_quote_disqualified",
        quoteCaseIdSnapshot: event.quoteCaseIdSnapshot ?? null,
        quoteVersionIdSnapshot: event.quoteVersionIdSnapshot ?? null,
        commercialAmountHash: event.commercialAmountHash ?? null,
        amountMinorSnapshot: event.amountMinorSnapshot,
        currencySnapshot: event.currencySnapshot,
        reasonCode: event.reasonCode ?? null,
        reasonText: event.reasonText ?? null,
        occurredAt: event.occurredAt!,
        recordedAt: event.recordedAt!,
        authorityRevision: event.authorityRevision!
      }),
      quoteCase: persisted.quoteCase,
      authorityRevision: persisted.authorityRevision,
      cancelledPublicationOperationIds:
        persisted.cancelledPublicationOperationIds
    }), replayed: execution.replayed });
  }
}
