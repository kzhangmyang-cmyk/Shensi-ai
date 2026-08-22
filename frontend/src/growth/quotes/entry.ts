import { growthHash } from "../router";

export interface QuoteEntryContext {
  quoteCaseId?: string;
  candidateId?: string;
  customerId?: string;
  dealId?: string;
}

export function quoteEntryHash(context: QuoteEntryContext): string {
  return growthHash({
    name: "quote",
    quoteCaseId: context.quoteCaseId,
    candidateId: context.candidateId,
    dealId: context.dealId
  });
}

export function openQuoteWorkbench(context: QuoteEntryContext): void {
  window.location.hash = quoteEntryHash(context);
}

export function dispatchQuoteWorkbenchRequested(
  context: QuoteEntryContext
): void {
  window.dispatchEvent(new CustomEvent<QuoteEntryContext>(
    "goodjob:quote-workbench-requested",
    { detail: Object.freeze({ ...context }) }
  ));
}
