import type { Role } from "./types.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export const GROWTH_CAPABILITY_REGISTRY_VERSION =
  "growth-capabilities.v1" as const;

export const GROWTH_CAPABILITIES = [
  "catalog.read",
  "catalog.manage",
  "pricing.sensitive.read",
  "quote.draft.create",
  "quote.confirm",
  "quote.exception.discount.approve",
  "quote.exception.margin.approve",
  "quote.exception.payment_terms.approve",
  "quote.exception.gift.approve",
  "quote.exception.credit.approve",
  "quote.exception.manual.approve",
  "ledger.pending.create",
  "ledger.verify",
  "finance.council.run",
  "finance.council.approve",
  "finance.council.policy.manage",
  "roi.close",
  "growth.performance.team.read",
  "growth.performance.workspace.read",
  "acquisition.outcome.reconcile.internal"
] as const;

export type GrowthCapability = typeof GROWTH_CAPABILITIES[number];

const HUMAN_GRANTS: Record<Role, readonly GrowthCapability[]> = {
  sales: ["catalog.read", "quote.draft.create"],
  manager: [
    "catalog.read",
    "pricing.sensitive.read",
    "quote.draft.create",
    "quote.confirm",
    "quote.exception.discount.approve",
    "quote.exception.margin.approve",
    "quote.exception.payment_terms.approve",
    "quote.exception.gift.approve",
    "quote.exception.credit.approve",
    "quote.exception.manual.approve",
    "ledger.pending.create",
    "growth.performance.team.read"
  ],
  admin: GROWTH_CAPABILITIES.filter((capability) =>
    capability !== "acquisition.outcome.reconcile.internal"),
  super_admin: GROWTH_CAPABILITIES.filter((capability) =>
    capability !== "acquisition.outcome.reconcile.internal")
};

export class GrowthAuthorizationError extends Error {
  readonly code = "capability_forbidden" as const;

  constructor(message = "当前工作区能力不足") {
    super(message);
    this.name = "GrowthAuthorizationError";
  }
}

export function capabilitiesForHumanRole(
  role: Role
): readonly GrowthCapability[] {
  return Object.freeze([...HUMAN_GRANTS[role]]);
}

export function requireGrowthCapabilities(
  context: ActiveWorkspaceContext,
  required: readonly GrowthCapability[]
): void {
  const granted = new Set(context.capabilities);
  if (required.some((capability) => !granted.has(capability))) {
    throw new GrowthAuthorizationError();
  }
}
