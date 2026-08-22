import {
  resolveTrustedAcquisitionDealBinding
} from "./acquisition-deal-binding.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { CrmStore } from "./store.js";
import type { TradeDocument } from "./types.js";

export type CommercialAuthorityAction =
  | "deal_commercial_patch"
  | "deal_quote_event"
  | "deal_won"
  | "deal_lost"
  | "pi_create"
  | "pi_commercial_patch"
  | "pi_revision"
  | "pi_submit_approval"
  | "pi_approve"
  | "pi_send"
  | "pi_export";

export type QuoteProjectedDocumentAction =
  | "submit_approval"
  | "approve"
  | "send"
  | "export";

export interface QuoteProjectedDocumentAuthority {
  documentId: string;
  documentRevision: number;
  dealId: string;
  quoteCaseId: string;
  quoteVersionId: string;
  commercialAmountHash: `sha256:${string}`;
  dealAuthorityRevision: number;
}

export interface QuoteProjectedDocumentAuthorityValidator {
  assertAuthorized(
    context: ActiveWorkspaceContext,
    input: {
      documentId: string;
      action: QuoteProjectedDocumentAction;
      expectedDocumentRevision: number;
    }
  ): Promise<QuoteProjectedDocumentAuthority>;
}

export class CommercialAuthorityError extends Error {
  readonly status = 409;
  readonly code = "authoritative_quote_required";

  constructor(readonly action: CommercialAuthorityAction) {
    super("获客商机必须通过正式 QuoteVersion 执行商业变更");
  }
}

const documentActions = {
  pi_submit_approval: "submit_approval",
  pi_approve: "approve",
  pi_send: "send",
  pi_export: "export"
} as const;

function exactProjection(
  document: TradeDocument,
  authority: QuoteProjectedDocumentAuthority,
  dealId: string
) {
  return document.type === "PI"
    && document.dealId === dealId
    && authority.dealId === dealId
    && authority.documentId === document.id
    && authority.documentRevision === document.revision
    && authority.quoteCaseId === document.quoteCaseId
    && authority.quoteVersionId === document.quoteVersionId
    && authority.commercialAmountHash === document.commercialAmountHash
    && authority.dealAuthorityRevision === document.dealAuthorityRevision;
}

export async function assertLegacyCommercialWriteAllowed(
  store: Pick<CrmStore, "acquisitionCustomerHandoffs" | "leads">,
  context: ActiveWorkspaceContext,
  dealId: string,
  action: CommercialAuthorityAction,
  options: {
    document?: TradeDocument;
    projectedDocumentAuthority?: QuoteProjectedDocumentAuthorityValidator;
  } = {}
): Promise<void> {
  if (!resolveTrustedAcquisitionDealBinding(store, { dealId })) return;
  const projectedAction = documentActions[
    action as keyof typeof documentActions
  ];
  const document = options.document;
  if (projectedAction
    && document?.commercialAuthority === "quote_projection"
    && Boolean(document.quoteCaseId?.trim())
    && Boolean(document.quoteVersionId?.trim())
    && /^sha256:[0-9a-f]{64}$/.test(document.commercialAmountHash ?? "")
    && Number.isSafeInteger(document.dealAuthorityRevision)
    && Number(document.dealAuthorityRevision) > 0
    && options.projectedDocumentAuthority) {
    try {
      const verified = await options.projectedDocumentAuthority.assertAuthorized(
        context,
        {
          documentId: document.id,
          expectedDocumentRevision: document.revision,
          action: projectedAction
        }
      );
      if (exactProjection(document, verified, dealId)) return;
    } catch {
      // The legacy route always fails closed with the Foundation error below.
    }
  }
  throw new CommercialAuthorityError(action);
}
