import { isDeepStrictEqual } from "node:util";
import type {
  QuoteProjectedDocumentAction,
  QuoteProjectedDocumentAuthority,
  QuoteProjectedDocumentAuthorityValidator
} from "./commercial-authority-guard.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import type { QuoteRepository } from "./quote-repository.js";
import type { CrmStore } from "./store.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

function fail(): never {
  throw Object.assign(new Error("authoritative_quote_required"), {
    code: "authoritative_quote_required"
  });
}

function actionCapability(action: QuoteProjectedDocumentAction) {
  return action === "approve" ? "quote.confirm" as const
    : "quote.draft.create" as const;
}

export function createQuoteProjectedDocumentAuthorityValidator(options: {
  store: Pick<CrmStore, "tradeDocuments">;
  repository: Pick<QuoteRepository, "getVersion" | "findCurrentDealAuthority"
    | "listAuthorityEvents">;
}): QuoteProjectedDocumentAuthorityValidator {
  return Object.freeze({
    async assertAuthorized(context: ActiveWorkspaceContext, input: {
      documentId: string;
      action: QuoteProjectedDocumentAction;
      expectedDocumentRevision: number;
    }): Promise<QuoteProjectedDocumentAuthority> {
      const matches = options.store.tradeDocuments.filter((row) =>
        row.id === input.documentId && row.teamId === context.workspaceId);
      if (matches.length !== 1) fail();
      const document = matches[0]!;
      if (document.type !== "PI"
        || document.commercialAuthority !== "quote_projection"
        || document.revision !== input.expectedDocumentRevision
        || !document.dealId || !document.quoteCaseId || !document.quoteVersionId
        || !document.commercialAmountHash
        || !Number.isSafeInteger(document.dealAuthorityRevision)
        || Number(document.dealAuthorityRevision) < 1
        || !Number.isSafeInteger(document.quotedAmountMinor)
        || !document.quoteLineSnapshot
        || document.quotePackageSnapshot === undefined) fail();
      const version = await options.repository.getVersion(
        context.workspaceId,
        document.quoteVersionId
      );
      if (!version || version.versionKind !== "formal"
        || version.status !== "approved"
        || version.quoteCaseId !== document.quoteCaseId
        || version.commercialAmountHash !== document.commercialAmountHash
        || version.currency !== document.currency
        || version.quotedAmountMinor !== document.quotedAmountMinor
        || !isDeepStrictEqual(version.lineSnapshot,
          document.quoteLineSnapshot)
        || !isDeepStrictEqual(version.packageSnapshot ?? null,
          document.quotePackageSnapshot ?? null)) fail();
      const events = await options.repository.listAuthorityEvents(
        context.workspaceId,
        document.dealId
      );
      const authorityEvent = events.find((event) =>
        event.authorityRevision === document.dealAuthorityRevision
        && event.quoteCaseId === document.quoteCaseId
        && event.quoteVersionId === document.quoteVersionId
        && event.commercialAmountHash === document.commercialAmountHash
        && event.quotedAmountMinor === document.quotedAmountMinor
        && event.currency === document.currency
        && (event.eventType === "approved" || event.eventType === "quote_authorized"));
      if (!authorityEvent) fail();
      if (input.action !== "export") {
        const current = await options.repository.findCurrentDealAuthority(
          context.workspaceId,
          document.dealId
        );
        if (!current || document.projectionState !== "current"
          || current.openQuoteCaseId !== document.quoteCaseId
          || current.quoteVersionId !== document.quoteVersionId
          || current.commercialAmountHash !== document.commercialAmountHash
          || current.authorityRevision !== document.dealAuthorityRevision) fail();
      }
      requireGrowthCapabilities(context, [actionCapability(input.action)]);
      return Object.freeze({
        documentId: document.id, documentRevision: document.revision,
        dealId: document.dealId, quoteCaseId: document.quoteCaseId,
        quoteVersionId: document.quoteVersionId,
        commercialAmountHash: document.commercialAmountHash,
        dealAuthorityRevision: document.dealAuthorityRevision!
      });
    }
  });
}
