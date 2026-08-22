import { createFinancialCouncilPolicyVersion } from
  "./financial-council-policy.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export const POLICY_TEST_NOW = "2026-08-16T08:01:00.000Z";

export function policyInput(overrides: Record<string, unknown> = {}) {
  return {
    currency: "CNY",
    balancedWeightsBps: {
      cash: 3_000, profit: 3_000, risk: 2_000, strategic: 2_000
    },
    minimumCashReserveMinor: 100_000,
    dueDebtMinor: 20_000,
    necessaryOutflowMinor: 30_000,
    budgetLimitMinor: 50_000,
    capacityLimitUnits: 20,
    durationLimitDays: 90,
    minimumActionConfidenceBps: 6_000,
    actionCoefficientVersion: "financial-council-actions.v1",
    ...overrides
  };
}

export function policyVersion(
  workspaceId = "ws-1",
  version = 1,
  overrides: Record<string, unknown> = {}
) {
  return createFinancialCouncilPolicyVersion({
    policyVersionId: version === 1
      ? "financial-council-policy.v1" : `policy-${version}`,
    workspaceId,
    version,
    revision: version,
    input: policyInput(),
    createdAt: POLICY_TEST_NOW,
    ...overrides
  } as never);
}

export function policyWorkspace(
  workspaceId = "ws-1",
  actorId = "admin-1"
): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId, kind: "team" as const, actorId, role: "admin" as const,
    teamId: workspaceId,
    capabilities: Object.freeze([
      "finance.council.run" as const,
      "catalog.manage" as const,
      "pricing.sensitive.read" as const
    ]),
    capabilityRegistryVersion: "growth-capabilities.v1" as const
  });
}

export function policyCommand(input: {
  workspaceId?: string;
  actorId?: string;
  key?: string;
  requestHash?: string;
  expectedRevision?: number;
} = {}): CommandContext {
  const workspace = policyWorkspace(input.workspaceId, input.actorId);
  return Object.freeze({
    workspace, actorId: workspace.actorId,
    idempotencyKey: input.key ?? "policy-key-1",
    requestHash: input.requestHash ?? `sha256:${"a".repeat(64)}`,
    expectedRevision: input.expectedRevision ?? 1
  });
}
