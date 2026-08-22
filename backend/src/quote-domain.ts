import type {
  GiftPolicy,
  PricingPolicyVersion
} from "./catalog-domain.js";
import type { PackageCostSnapshot } from "./catalog-repository.js";
import type { GrowthCapability } from "./growth-capabilities.js";

export interface QuoteGiftInput {
  catalogItemId: string;
  quantityMicros: number;
}

export interface QuoteSurchargeContext {
  region: string | null;
  deliveryMethod: string | null;
}

export interface QuoteCalculationInput {
  workspaceId: string;
  catalogItemId: string;
  pricingPolicyVersionId: string;
  quantityMicros: number;
  offeredUnitPriceMinor: number;
  orderDiscountMinor: number;
  paymentTermDays: number;
  giftItems: readonly QuoteGiftInput[];
  surchargeContext: QuoteSurchargeContext;
  customerTargetPriceMinor: number | null;
  creditRiskBps: number | null;
  manualEscalation: boolean;
}

export type FrozenGiftPolicy = Readonly<GiftPolicy>;

export interface QuoteCalculationDependencies {
  giftPolicies: readonly FrozenGiftPolicy[];
  packageSnapshot: PackageCostSnapshot | null;
}

export type QuoteApprovalReasonCode =
  | "quoted_amount_not_positive"
  | "net_product_amount_not_positive"
  | "absolute_floor_breached"
  | "minimum_margin_breached"
  | "absolute_discount_limit_exceeded"
  | "absolute_payment_term_exceeded"
  | "gift_policy_missing"
  | "absolute_gift_quantity_exceeded"
  | "absolute_gift_cost_exceeded"
  | "standard_discount_limit_exceeded"
  | "target_gross_margin_breached"
  | "standard_payment_term_exceeded"
  | "standard_gift_quantity_exceeded"
  | "standard_gift_cost_exceeded"
  | "credit_risk_threshold_exceeded"
  | "manual_escalation_requested";

export interface QuoteApprovalReason {
  code: QuoteApprovalReasonCode;
}

export type QuoteGate = Readonly<{
  status:
    | "hard_blocked"
    | "confirmation_required"
    | "exception_approval_required";
  reasons: readonly QuoteApprovalReason[];
  requiredCapabilities: readonly GrowthCapability[];
}>;

export interface FrozenQuoteLineSnapshot {
  catalogItemId: string;
  pricingPolicyVersionId: string;
  packageVersionId: string | null;
  quantityMicros: number;
  offeredUnitPriceMinor: number;
  offeredLineAmountMinor: number;
  lineStandardCostMinor: number;
}

export interface FrozenQuoteGiftSnapshot {
  catalogItemId: string;
  quantityMicros: number;
  unitStandardCostMinor: number;
  standardCostMinor: number;
  policy: FrozenGiftPolicy | null;
}

export interface QuotePreviewIdentity {
  inputSnapshotHash: `sha256:${string}`;
  calculationHash: `sha256:${string}`;
  pricingPolicyVersionId: string;
  pricingPolicyRevision: number;
  packageVersionId: string | null;
  formulaVersion: "quote-calculation.v1";
}

interface QuoteCalculationCommon {
  currency: string;
  listAmountMinor: number;
  offeredLineAmountMinor: number;
  diagnosticNetProductAmountMinor: number;
  diagnosticQuotedAmountMinor: number;
  requiredSurchargeMinor: number;
  surchargeMinor: number;
  absoluteFloorAmountMinor: number;
  lineStandardCostMinor: number;
  giftCostMinor: number;
  estimatedFulfillmentCostMinor: number;
  estimatedSalesCostMinor: number;
  estimatedServiceCostMinor: number;
  estimatedGrossProfitMinor: number;
  estimatedContributionMinor: number;
  discountBps: number;
  minimumMarginPriceMinor: number;
  minimumAllowedQuotedAmountMinor: number;
  recommendedOpeningQuotedAmountMinor: number;
  gate: QuoteGate;
  lineSnapshot: Readonly<FrozenQuoteLineSnapshot>;
  packageSnapshot: PackageCostSnapshot | null;
  giftSnapshots: readonly Readonly<FrozenQuoteGiftSnapshot>[];
  giftPolicySnapshots: readonly FrozenGiftPolicy[];
  pricingPolicySnapshot: Readonly<PricingPolicyVersion>;
  inputSnapshot: Readonly<QuoteCalculationInput>;
  inputSnapshotHash: `sha256:${string}`;
  calculationHash: `sha256:${string}`;
  previewIdentity: Readonly<QuotePreviewIdentity>;
}

export interface ActionableQuoteCalculationResult extends QuoteCalculationCommon {
  amountState: "actionable";
  netProductAmountMinor: number;
  quotedAmountMinor: number;
  grossMarginBps: number;
  commercialAmountHash: `sha256:${string}`;
}

export interface NonPositiveDiagnosticQuoteCalculationResult
extends QuoteCalculationCommon {
  amountState: "non_positive_diagnostic";
  grossMarginBps: null;
  commercialAmountHash: null;
}

export type QuoteCalculationResult =
  | ActionableQuoteCalculationResult
  | NonPositiveDiagnosticQuoteCalculationResult;

export class QuoteCalculationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "QuoteCalculationError";
  }
}
