import type { FinancialCouncilPolicyVersion } from
  "./growth-contract-types.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { growthHttpIdempotencyKeyHash } from
  "./growth-http-idempotency-repository.js";
import {
  financialCouncilError,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import { assertFinancialCouncilPolicyVersion } from
  "./financial-council-policy.js";

export interface FinancialCouncilPolicyCommandResult {
  readonly value: FinancialCouncilPolicyVersion;
  readonly replayed: boolean;
}

export interface FinancialCouncilPolicyRepository {
  findActive(
    context: ActiveWorkspaceContext
  ): Promise<FinancialCouncilPolicyVersion | null>;
  findVersion(
    context: ActiveWorkspaceContext,
    policyVersionId: string
  ): Promise<FinancialCouncilPolicyVersion | null>;
  getOrCreateActive(
    context: ActiveWorkspaceContext,
    serverDefault: FinancialCouncilPolicyVersion
  ): Promise<FinancialCouncilPolicyVersion>;
  createVersion(
    command: CommandContext,
    policy: FinancialCouncilPolicyVersion
  ): Promise<FinancialCouncilPolicyCommandResult>;
}

interface PolicyCommandBinding {
  readonly requestHash: string;
  readonly policyVersionId: string;
}

function fail(code: string): never {
  throw financialCouncilError(code);
}

function contextWorkspace(context: ActiveWorkspaceContext): string {
  const value = context?.workspaceId;
  if (typeof value !== "string" || !value.trim() || value === "all") {
    fail("financial_council_policy_context_invalid");
  }
  return value;
}

function policyId(value: string): string {
  if (typeof value !== "string" || value.trim() !== value || !value
    || [...value].length > 255) {
    fail("financial_council_policy_input_invalid");
  }
  return value;
}

function commandScope(command: CommandContext): string {
  const workspaceId = contextWorkspace(command?.workspace);
  if (command.actorId !== command.workspace.actorId
    || typeof command.actorId !== "string" || !command.actorId.trim()
    || !/^sha256:[0-9a-f]{64}$/u.test(command.requestHash)) {
    fail("financial_council_policy_context_invalid");
  }
  let keyHash: string;
  try {
    keyHash = growthHttpIdempotencyKeyHash(command.idempotencyKey);
  } catch {
    fail("financial_council_policy_context_invalid");
  }
  return `${workspaceId}\u0000${command.actorId}\u0000${keyHash}`;
}

function copy(policy: FinancialCouncilPolicyVersion):
FinancialCouncilPolicyVersion {
  return immutableFinancialCouncilValue(policy);
}

export class InMemoryFinancialCouncilPolicyRepository
implements FinancialCouncilPolicyRepository {
  private readonly versions = new Map<string,
  Map<string, FinancialCouncilPolicyVersion>>();
  private readonly active = new Map<string, string>();
  private readonly commands = new Map<string, PolicyCommandBinding>();

  async findActive(context: ActiveWorkspaceContext) {
    const workspaceId = contextWorkspace(context);
    const activeId = this.active.get(workspaceId);
    if (!activeId) return null;
    const value = this.versions.get(workspaceId)?.get(activeId);
    if (!value) fail("financial_council_policy_integrity");
    return copy(value);
  }

  async findVersion(
    context: ActiveWorkspaceContext,
    requestedPolicyId: string
  ) {
    const workspaceId = contextWorkspace(context);
    const value = this.versions.get(workspaceId)?.get(policyId(
      requestedPolicyId
    ));
    return value ? copy(value) : null;
  }

  async getOrCreateActive(
    context: ActiveWorkspaceContext,
    serverDefault: FinancialCouncilPolicyVersion
  ) {
    const workspaceId = contextWorkspace(context);
    assertFinancialCouncilPolicyVersion(serverDefault);
    if (serverDefault.workspaceId !== workspaceId) {
      fail("financial_council_policy_workspace_mismatch");
    }
    if (serverDefault.policyVersionId !== "financial-council-policy.v1"
      || serverDefault.version !== 1 || serverDefault.revision !== 1) {
      fail("financial_council_policy_default_invalid");
    }
    const existing = await this.findActive(context);
    if (existing) return existing;
    const workspaceVersions = this.versions.get(workspaceId)
      ?? new Map<string, FinancialCouncilPolicyVersion>();
    if (workspaceVersions.size !== 0) {
      fail("financial_council_policy_integrity");
    }
    const stored = copy(serverDefault);
    workspaceVersions.set(stored.policyVersionId, stored);
    this.versions.set(workspaceId, workspaceVersions);
    this.active.set(workspaceId, stored.policyVersionId);
    return copy(stored);
  }

  async createVersion(
    command: CommandContext,
    policy: FinancialCouncilPolicyVersion
  ): Promise<FinancialCouncilPolicyCommandResult> {
    const workspaceId = contextWorkspace(command?.workspace);
    assertFinancialCouncilPolicyVersion(policy);
    if (policy.workspaceId !== workspaceId) {
      fail("financial_council_policy_workspace_mismatch");
    }
    const scope = commandScope(command);
    const binding = this.commands.get(scope);
    if (binding) {
      if (binding.requestHash !== command.requestHash) {
        fail("financial_council_policy_idempotency_conflict");
      }
      const replay = this.versions.get(workspaceId)?.get(
        binding.policyVersionId
      );
      if (!replay) fail("financial_council_policy_integrity");
      return Object.freeze({ value: copy(replay), replayed: true });
    }
    const currentId = this.active.get(workspaceId);
    const current = currentId
      ? this.versions.get(workspaceId)?.get(currentId) : undefined;
    if (!current) fail("financial_council_policy_integrity");
    if (!Number.isSafeInteger(command.expectedRevision)
      || command.expectedRevision !== current.revision
      || policy.version !== current.version + 1
      || policy.revision !== current.revision + 1) {
      fail("financial_council_policy_revision_conflict");
    }
    const workspaceVersions = this.versions.get(workspaceId)!;
    if (workspaceVersions.has(policy.policyVersionId)
      || [...workspaceVersions.values()].some((version) =>
        version.version === policy.version || version.revision === policy.revision)) {
      fail("financial_council_policy_version_conflict");
    }
    const stored = copy(policy);
    workspaceVersions.set(stored.policyVersionId, stored);
    this.active.set(workspaceId, stored.policyVersionId);
    this.commands.set(scope, Object.freeze({
      requestHash: command.requestHash,
      policyVersionId: stored.policyVersionId
    }));
    return Object.freeze({ value: copy(stored), replayed: false });
  }
}
