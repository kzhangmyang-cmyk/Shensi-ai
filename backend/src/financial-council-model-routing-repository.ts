import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import { growthHttpIdempotencyKeyHash } from
  "./growth-http-idempotency-repository.js";
import {
  FinancialCouncilModelRoutingError,
  assertFinancialCouncilModelRoutingPolicyVersion,
  immutableFinancialCouncilModelRoutingPolicyVersion,
  withFinancialCouncilModelRoutingPolicyStatus,
  type FinancialCouncilModelRoutingPolicyVersion
} from "./financial-council-model-routing.js";

export interface PutFinancialCouncilModelRoutingPolicyCommand {
  readonly workspace: ActiveWorkspaceContext;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly expectedRevision: number | null;
}

export interface FinancialCouncilModelRoutingPolicyCommandResult {
  readonly value: FinancialCouncilModelRoutingPolicyVersion;
  readonly replayed: boolean;
}

export interface FinancialCouncilModelRoutingRepository {
  getCurrent(context: ActiveWorkspaceContext): Promise<
    FinancialCouncilModelRoutingPolicyVersion | null
  >;
  getVersion(
    context: ActiveWorkspaceContext,
    policyVersionId: string
  ): Promise<FinancialCouncilModelRoutingPolicyVersion | null>;
  put(
    command: PutFinancialCouncilModelRoutingPolicyCommand,
    policy: FinancialCouncilModelRoutingPolicyVersion
  ): Promise<FinancialCouncilModelRoutingPolicyCommandResult>;
}

interface IdempotencyBinding {
  readonly requestHash: string;
  readonly response: FinancialCouncilModelRoutingPolicyVersion;
}

function fail(code: string): never {
  throw new FinancialCouncilModelRoutingError(code);
}

export function financialCouncilModelRoutingWorkspaceId(
  context: ActiveWorkspaceContext
): string {
  const value = context?.workspaceId;
  if (typeof value !== "string" || value.trim() !== value || !value
    || value === "all" || !/^[!-~]+$/u.test(value) || value.length > 160) {
    fail("financial_council_model_routing_context_invalid");
  }
  return value;
}

export function financialCouncilModelRoutingPolicyId(value: string): string {
  if (typeof value !== "string" || value.trim() !== value || !value
    || !/^[!-~]+$/u.test(value) || value.length > 160) {
    fail("financial_council_model_routing_context_invalid");
  }
  return value;
}

export function financialCouncilModelRoutingCommandIdentity(
  command: PutFinancialCouncilModelRoutingPolicyCommand
) {
  const workspaceId = financialCouncilModelRoutingWorkspaceId(
    command?.workspace
  );
  if (command.actorId !== command.workspace.actorId
    || typeof command.actorId !== "string"
    || command.actorId.trim() !== command.actorId || !command.actorId
    || !/^[!-~]+$/u.test(command.actorId) || command.actorId.length > 160
    || !/^sha256:[0-9a-f]{64}$/u.test(command.requestHash)) {
    fail("financial_council_model_routing_context_invalid");
  }
  let keyHash: string;
  try { keyHash = growthHttpIdempotencyKeyHash(command.idempotencyKey); }
  catch { fail("financial_council_model_routing_context_invalid"); }
  return Object.freeze({ workspaceId, actorId: command.actorId, keyHash });
}

function copy(value: FinancialCouncilModelRoutingPolicyVersion) {
  return immutableFinancialCouncilModelRoutingPolicyVersion(value);
}

export class InMemoryFinancialCouncilModelRoutingRepository
implements FinancialCouncilModelRoutingRepository {
  private readonly versions = new Map<string,
    Map<string, FinancialCouncilModelRoutingPolicyVersion>>();
  private readonly current = new Map<string, string>();
  private readonly idempotency = new Map<string, IdempotencyBinding>();

  async getCurrent(context: ActiveWorkspaceContext) {
    const workspaceId = financialCouncilModelRoutingWorkspaceId(context);
    const id = this.current.get(workspaceId);
    if (!id) return null;
    const value = this.versions.get(workspaceId)?.get(id);
    if (!value || value.status !== "active") {
      fail("financial_council_model_routing_integrity");
    }
    return copy(value);
  }

  async getVersion(context: ActiveWorkspaceContext, policyVersionId: string) {
    const workspaceId = financialCouncilModelRoutingWorkspaceId(context);
    const value = this.versions.get(workspaceId)?.get(
      financialCouncilModelRoutingPolicyId(policyVersionId)
    );
    return value ? copy(value) : null;
  }

  async put(
    command: PutFinancialCouncilModelRoutingPolicyCommand,
    policy: FinancialCouncilModelRoutingPolicyVersion
  ): Promise<FinancialCouncilModelRoutingPolicyCommandResult> {
    const identity = financialCouncilModelRoutingCommandIdentity(command);
    const scope = `${identity.workspaceId}\u0000${identity.actorId}\u0000${identity.keyHash}`;
    const existing = this.idempotency.get(scope);
    if (existing) {
      if (existing.requestHash !== command.requestHash) {
        fail("financial_council_model_routing_idempotency_conflict");
      }
      return Object.freeze({ value: copy(existing.response), replayed: true });
    }
    try { assertFinancialCouncilModelRoutingPolicyVersion(policy); }
    catch { fail("financial_council_model_routing_integrity"); }
    if (policy.workspaceId !== identity.workspaceId
      || policy.createdBy !== identity.actorId) {
      fail("financial_council_model_routing_workspace_mismatch");
    }
    if (policy.status !== "active") {
      fail("financial_council_model_routing_integrity");
    }
    const workspaceVersions = this.versions.get(identity.workspaceId)
      ?? new Map<string, FinancialCouncilModelRoutingPolicyVersion>();
    const currentId = this.current.get(identity.workspaceId);
    const current = currentId ? workspaceVersions.get(currentId) : undefined;
    const expectedRevision = current?.revision ?? null;
    if (command.expectedRevision !== expectedRevision
      || policy.revision !== (expectedRevision ?? 0) + 1) {
      fail("financial_council_model_routing_revision_conflict");
    }
    if (workspaceVersions.has(policy.policyVersionId)
      || [...workspaceVersions.values()].some((item) =>
        item.revision === policy.revision)) {
      fail("financial_council_model_routing_revision_conflict");
    }
    if (current) {
      workspaceVersions.set(current.policyVersionId,
        withFinancialCouncilModelRoutingPolicyStatus(current, "superseded"));
    }
    const stored = copy(policy);
    workspaceVersions.set(stored.policyVersionId, stored);
    this.versions.set(identity.workspaceId, workspaceVersions);
    this.current.set(identity.workspaceId, stored.policyVersionId);
    this.idempotency.set(scope, Object.freeze({
      requestHash: command.requestHash,
      response: copy(stored)
    }));
    return Object.freeze({ value: copy(stored), replayed: false });
  }
}
