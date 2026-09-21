import { randomUUID } from "node:crypto";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  FINANCIAL_COUNCIL_MODEL_ROLES,
  FinancialCouncilModelRoutingError,
  createFinancialCouncilModelRoutingPolicyVersion,
  financialCouncilModelRoutingCanonicalJson,
  normalizeFinancialCouncilModelRoutingPolicyInput,
  selectFinancialCouncilModelRoute,
  type FinancialCouncilModelRoutingPolicyInput,
  type FinancialCouncilModelRoutingPolicyVersion
} from "./financial-council-model-routing.js";
import type { FinancialCouncilModelRoutingRepository } from
  "./financial-council-model-routing-repository.js";
import type { FinancialCouncilModelRoutingRuntimeState } from
  "./model-providers/runtime.js";
import type { ModelConnection } from "./model-providers/types.js";

export interface PublicFinancialCouncilModelConnection {
  readonly connectionId: string;
  readonly provider: string;
  readonly model: string;
  readonly displayName: string;
}

export interface PublicFinancialCouncilModelRoutePreview {
  readonly role: (typeof FINANCIAL_COUNCIL_MODEL_ROLES)[number];
  readonly orderedConnections: readonly PublicFinancialCouncilModelConnection[];
  readonly selectedConnection: PublicFinancialCouncilModelConnection | null;
  readonly reasonCodes: readonly string[];
  readonly missingCapabilities: readonly string[];
}

function scoped(connection: ModelConnection, context: ActiveWorkspaceContext) {
  return context.kind === "team"
    ? connection.teamId === context.workspaceId
    : connection.ownerId === context.actorId && connection.teamId === context.teamId;
}

function publicConnection(connection: ModelConnection):
PublicFinancialCouncilModelConnection {
  const reflected = connection as ModelConnection & { name?: unknown };
  return Object.freeze({
    connectionId: connection.id,
    provider: connection.provider,
    model: connection.model,
    displayName: typeof reflected.name === "string" && reflected.name.trim()
      ? reflected.name : connection.model
  });
}

export class FinancialCouncilModelRoutingService {
  private readonly now: () => string;
  private readonly ids: { next(): string };
  constructor(private readonly dependencies: {
    readonly repository: FinancialCouncilModelRoutingRepository;
    readonly runtimeState: () => FinancialCouncilModelRoutingRuntimeState;
    readonly now?: () => string;
    readonly ids?: { next(): string };
  }) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.ids = dependencies.ids ?? { next: () => randomUUID() };
  }

  async getCurrent(context: ActiveWorkspaceContext) {
    requireGrowthCapabilities(context, ["finance.council.run"]);
    const current = await this.dependencies.repository.getCurrent(context);
    if (!current) throw new FinancialCouncilModelRoutingError(
      "financial_council_model_routing_policy_not_found");
    return current;
  }

  async getVersion(context: ActiveWorkspaceContext, id: string) {
    requireGrowthCapabilities(context, ["finance.council.run"]);
    const value = await this.dependencies.repository.getVersion(context, id);
    if (!value) throw new FinancialCouncilModelRoutingError(
      "financial_council_model_routing_policy_not_found");
    return value;
  }

  async preview(context: ActiveWorkspaceContext): Promise<
  readonly PublicFinancialCouncilModelRoutePreview[]> {
    requireGrowthCapabilities(context, ["finance.council.run"]);
    const policy = await this.getCurrent(context);
    const state = this.dependencies.runtimeState();
    const byId = new Map(state.connections.filter((item) => scoped(item, context))
      .map((item) => [item.id, item]));
    return Object.freeze(FINANCIAL_COUNCIL_MODEL_ROLES.map((role) => {
      const route = selectFinancialCouncilModelRoute({ role, policy,
        connections: state.connections, recentCalls: state.recentCalls,
        prices: [], activeWorkspace: context });
      const orderedConnections = Object.freeze(route.orderedConnectionIds
        .map((id) => byId.get(id)).filter((item): item is ModelConnection => !!item)
        .map(publicConnection));
      return Object.freeze({ role, orderedConnections,
        selectedConnection: orderedConnections[0] ?? null,
        reasonCodes: Object.freeze([...route.reasonCodes]),
        missingCapabilities: Object.freeze([...route.missingCapabilities]) });
    }));
  }

  async put(command: CommandContext, raw: FinancialCouncilModelRoutingPolicyInput) {
    requireGrowthCapabilities(command.workspace,
      ["finance.council.policy.manage"]);
    if (command.actorId !== command.workspace.actorId) {
      throw new FinancialCouncilModelRoutingError(
        "financial_council_model_routing_context_invalid");
    }
    const input = normalizeFinancialCouncilModelRoutingPolicyInput(raw);
    const current = await this.dependencies.repository.getCurrent(command.workspace);
    const expected = current?.revision ?? null;
    if (command.expectedRevision !== expected) {
      throw new FinancialCouncilModelRoutingError(
        "financial_council_model_routing_revision_conflict");
    }
    const state = this.dependencies.runtimeState();
    const eligible = new Set(state.connections.filter((item) => scoped(item,
      command.workspace) && item.status === "active"
      && item.capabilitySnapshot.structuredOutput === true
      && /^sha256:[0-9a-f]{64}$/u.test(item.capabilityCertificationHash ?? ""))
      .map((item) => item.id));
    for (const role of FINANCIAL_COUNCIL_MODEL_ROLES) {
      const route = input.roles[role];
      if (route.mode === "pinned"
        && ![route.primaryConnectionId!, ...route.fallbackConnectionIds]
          .every((id) => eligible.has(id))) {
        throw new FinancialCouncilModelRoutingError(
          "financial_council_model_connection_ineligible");
      }
    }
    const version = createFinancialCouncilModelRoutingPolicyVersion({
      policyVersionId: this.ids.next(),
      workspaceId: command.workspace.workspaceId,
      revision: (expected ?? 0) + 1, status: "active", input,
      createdBy: command.actorId, createdAt: this.now()
    });
    return this.dependencies.repository.put({
      workspace: command.workspace, actorId: command.actorId,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash,
      expectedRevision: command.expectedRevision
    }, version);
  }
}

export function projectFinancialCouncilModelRoutingPolicy(
  value: FinancialCouncilModelRoutingPolicyVersion
) {
  return Object.freeze({ policyVersionId: value.policyVersionId,
    revision: value.revision, roles: value.roles,
    maxRunBudgetMinor: value.maxRunBudgetMinor,
    maxRoleBudgetMinor: value.maxRoleBudgetMinor,
    requestTimeoutMs: value.requestTimeoutMs, createdAt: value.createdAt });
}
