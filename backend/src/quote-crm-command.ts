import { createHash } from "node:crypto";
import type { CrmStore } from "./store.js";
import type { DealEvent, TradeDocument } from "./types.js";
import {
  assertGrowthTemporalBarrier,
  type GrowthTemporalBarrier,
  type GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import type { QuoteVersion } from "./quote-repository.js";
import type {
  DealCommercialDecisionPersistenceInput,
  DealCommercialDecisionPersistenceResult,
  QuoteRepository
} from "./quote-repository.js";

export interface DecideDealInput {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly dealId: string;
  readonly expectedAuthorityRevision: number;
  readonly input: DealCommercialDecisionPersistenceInput;
  readonly stableCommandHash: `sha256:${string}`;
  readonly requestHash: string;
}

export interface EnsurePiProjectionInput {
    workspaceId: string;
    dealId: string;
    quoteCaseId: string;
    quoteVersion: QuoteVersion;
    dealAuthorityRevision: number;
    commercialAmountHash: string;
    stableKey: string;
}

export interface PublishQuotedDealInput {
    workspaceId: string;
    dealId: string;
    quoteCaseId: string;
    quoteVersion: QuoteVersion;
    dealAuthorityRevision: number;
    commercialAmountHash: string;
    piDocumentId: string;
    actorId: string;
    stableKey: string;
}

export interface QuoteCrmCommand {
  ensurePiProjection(input: EnsurePiProjectionInput):
    Promise<{ piDocumentId: string }>;
  publishQuotedDeal(input: PublishQuotedDealInput):
    Promise<{ dealEventId: string }>;
  decideDeal(input: DecideDealInput):
    Promise<DealCommercialDecisionPersistenceResult>;
}

interface ProjectionBase {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly quoteCaseId: string;
  readonly quoteVersion: QuoteVersion;
  readonly dealAuthorityRevision: number;
  readonly commercialAmountHash: `sha256:${string}`;
  readonly stableKey: string;
  readonly recordedAt: string;
  readonly temporalSequence: number;
}

export type AuthoritativeQuoteProjectionMutation =
  | (ProjectionBase & { readonly kind: "pi"; readonly stableId: string })
  | (ProjectionBase & { readonly kind: "crm"; readonly stableId: string;
      readonly piDocumentId: string; readonly actorId: string });

export type AuthoritativeQuoteProjectionMutationResult =
  | { readonly kind: "pi"; readonly document: TradeDocument }
  | { readonly kind: "crm"; readonly event: DealEvent };

function publicationId(kind: "pi" | "event", stableKey: string) {
  return `quote-${kind}-${createHash("sha256").update(stableKey).digest("hex")
    .slice(0, 40)}`;
}

function amountHash(value: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw Object.assign(new Error("invalid_commercial_amount_hash"), {
      code: "invalid_commercial_amount_hash"
    });
  }
  return value as `sha256:${string}`;
}

export function createQuoteCrmCommand(options: {
  store: Pick<CrmStore, "mutateAuthoritativeQuoteProjection" | "deals"
    | "dealEvents">;
  temporalTransactions: GrowthTemporalTransactionRunner;
  temporalBarrier: GrowthTemporalBarrier;
  repository?: Pick<QuoteRepository,
    "findCurrentDealAuthority" | "decideDeal">;
}): QuoteCrmCommand {
  const temporalBarrier = assertGrowthTemporalBarrier(options.temporalBarrier);
  if (!options.store.mutateAuthoritativeQuoteProjection) {
    throw new Error("authoritative_quote_projection_store_required");
  }
  const mutate = async (
    input: Omit<ProjectionBase, "recordedAt" | "temporalSequence">,
    details: { kind: "pi"; stableId: string }
      | { kind: "crm"; stableId: string; piDocumentId: string; actorId: string }
  ) => options.temporalTransactions.run(async (tx) => {
    const stamp = await temporalBarrier.allocateAppend(tx, input.workspaceId);
    if (options.repository) {
      const authority = await options.repository.findCurrentDealAuthority(
        input.workspaceId,
        input.dealId
      );
      if (!authority
        || authority.authorityRevision !== input.dealAuthorityRevision
        || authority.openQuoteCaseId !== input.quoteCaseId
        || authority.quoteVersionId !== input.quoteVersion.id
        || authority.commercialAmountHash !== input.commercialAmountHash) {
        throw Object.assign(new Error("publication_authority_changed"), {
          code: "publication_authority_changed"
        });
      }
    }
    return options.store.mutateAuthoritativeQuoteProjection!({
      ...input,
      commercialAmountHash: amountHash(input.commercialAmountHash),
      ...details,
      ...stamp
    } as AuthoritativeQuoteProjectionMutation);
  });
  return Object.freeze({
    async ensurePiProjection(input: EnsurePiProjectionInput) {
      const result = await mutate(input as Omit<ProjectionBase,
        "recordedAt" | "temporalSequence">, {
        kind: "pi", stableId: publicationId("pi", input.stableKey)
      });
      if (result.kind !== "pi") throw new Error("invalid_pi_projection_result");
      return { piDocumentId: result.document.id };
    },
    async publishQuotedDeal(input: PublishQuotedDealInput) {
      const result = await mutate(input as Omit<ProjectionBase,
        "recordedAt" | "temporalSequence">, {
        kind: "crm", stableId: publicationId("event", input.stableKey),
        piDocumentId: input.piDocumentId, actorId: input.actorId
      });
      if (result.kind !== "crm") {
        throw new Error("invalid_crm_projection_result");
      }
      const binding = input.quoteVersion.commercialBindingSnapshot;
      if (!binding || typeof binding !== "object") {
        return { dealEventId: result.event.id };
      }
      const snapshot = binding as import("./commercial-binding-snapshot.js")
        .CommercialBindingSnapshot;
      const enriched = Object.freeze({ ...result.event,
        leadIdSnapshot: snapshot.leadId,
        handoffIdSnapshot: snapshot.handoffId,
        candidateIdSnapshot: snapshot.candidateId,
        customerIdSnapshot: snapshot.customerId,
        commercialBindingSnapshot: Object.freeze(structuredClone(snapshot)),
        commercialBindingEvidence: Object.freeze({
          candidateId: snapshot.candidateId,
          customerId: snapshot.customerId,
          dealId: snapshot.dealId,
          handoffContentHash: snapshot.handoffContentHash,
          dealContentHash: snapshot.dealContentHash,
          bindingHashSchemaVersion: snapshot.bindingHashSchemaVersion,
          bindingHash: snapshot.bindingHash
        })
      });
      const index = options.store.dealEvents.findIndex((event) =>
        event.id === enriched.id);
      if (index >= 0) options.store.dealEvents[index] = enriched;
      return { dealEventId: enriched.id };
    },
    async decideDeal(input: DecideDealInput) {
      if (!options.repository) throw new Error("quote_repository_required");
      return options.repository.decideDeal({ ...input, crm: {
        deals: options.store.deals, dealEvents: options.store.dealEvents
      } });
    }
  });
}
