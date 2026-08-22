import {
  FinancialFindingValidator,
  type AuthorizedFinancialCouncilSpecialistResult,
  type FinancialCouncilActionPolicyTemplate
} from "./financial-council-finding-validator.js";
import type { FinancialFormulaCatalogPolicy } from
  "./financial-council-formulas.js";
import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import type {
  FinancialCouncilModelPort,
  FinancialCouncilModelResult,
  FinancialCouncilAnalyzeOutput,
  FinancialCouncilRebutInput
} from "./financial-council-model-port.js";
import { buildFinancialCouncilModelContent } from
  "./financial-council-model-content.js";
import type {
  FinancialCouncilRepository,
  FinancialCouncilLeaseWrite,
  FinancialCouncilSpecialistResult,
  VerifiedFinancialCouncilRunSnapshot
} from "./financial-council-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { FinancialCouncilAgentRole } from "./growth-contract-types.js";

export const FINANCIAL_COUNCIL_SPECIALIST_ROLES = Object.freeze([
  "finance", "profit", "cost", "cashflow", "tax"
] as const satisfies readonly FinancialCouncilAgentRole[]);

export interface FinancialCouncilSpecialistPolicies {
  readonly formulaPolicy: FinancialFormulaCatalogPolicy;
  readonly actionPolicy: FinancialCouncilActionPolicyTemplate;
}

export interface FinancialCouncilSpecialistCoordinatorOptions {
  readonly repository: FinancialCouncilRepository;
  readonly model: FinancialCouncilModelPort;
  readonly resolvePolicy: (
    policyVersionId: string
  ) => Promise<FinancialCouncilSpecialistPolicies>
    | FinancialCouncilSpecialistPolicies;
  readonly now?: () => string;
}

export interface FinancialCouncilVerifiedSpecialistLoadOptions {
  readonly repository: FinancialCouncilRepository;
  readonly context: ActiveWorkspaceContext;
  readonly runId: string;
  readonly resolvePolicy: FinancialCouncilSpecialistCoordinatorOptions[
  "resolvePolicy"];
  readonly now?: () => string;
}

interface PreparedSpecialistAuthority {
  readonly verified: VerifiedFinancialCouncilRunSnapshot;
  readonly validator: FinancialFindingValidator;
  readonly results: readonly AuthorizedFinancialCouncilSpecialistResult[];
}

function invalid(code: string): never {
  throw financialCouncilError(code);
}

function instant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return invalid("financial_council_specialist_result_invalid");
  }
  return value;
}

function exactBinding(
  result: FinancialCouncilModelResult<FinancialCouncilAnalyzeOutput>,
  expected: {
    readonly runId: string;
    readonly snapshotId: string;
    readonly snapshotHash: `sha256:${string}`;
    readonly role: FinancialCouncilAgentRole;
    readonly contentHash: `sha256:${string}`;
    readonly promptHash: `sha256:${string}`;
    readonly schemaHash: `sha256:${string}`;
    readonly promptVersion: string;
    readonly schemaVersion: string;
  }
): void {
  const binding = result.binding;
  if (binding.runId !== expected.runId
    || binding.snapshotId !== expected.snapshotId
    || binding.snapshotHash !== expected.snapshotHash
    || binding.role !== expected.role
    || binding.phase !== "analyze"
    || binding.attempt !== 1
    || binding.contentHash !== expected.contentHash
    || binding.promptHash !== expected.promptHash
    || binding.schemaHash !== expected.schemaHash
    || binding.promptVersion !== expected.promptVersion
    || binding.schemaVersion !== expected.schemaVersion
    || binding.jobId !== `financial-council:${expected.runId}:`
      + `${expected.role}:analyze:1`) {
    invalid("financial_council_specialist_binding_invalid");
  }
}

async function prepareSpecialistAuthority(
  options: FinancialCouncilVerifiedSpecialistLoadOptions
): Promise<PreparedSpecialistAuthority> {
  const verified = await options.repository.getVerifiedRunSnapshot(
    options.context, options.runId
  );
  if (!verified) return invalid("financial_council_run_not_found");
  const policies = await options.resolvePolicy(verified.run.policyVersionId);
  const validator = new FinancialFindingValidator({
    run: verified.run,
    snapshot: verified.snapshot,
    formulaPolicy: policies.formulaPolicy,
    actionPolicy: policies.actionPolicy,
    now: options.now
  });
  const rawResults = await options.repository.listSpecialistResults(
    options.context, options.runId
  );
  const results = rawResults.map((result) =>
    validator.authorizeSpecialistResult(result));
  return Object.freeze({ verified, validator, results: Object.freeze(results) });
}

export async function loadVerifiedFinancialCouncilSpecialistResults(
  options: FinancialCouncilVerifiedSpecialistLoadOptions
): Promise<readonly AuthorizedFinancialCouncilSpecialistResult[]> {
  return (await prepareSpecialistAuthority(options)).results;
}

export class FinancialCouncilSpecialistCoordinator {
  readonly #repository: FinancialCouncilRepository;
  readonly #model: FinancialCouncilModelPort;
  readonly #resolvePolicy: FinancialCouncilSpecialistCoordinatorOptions[
  "resolvePolicy"];
  readonly #now: () => string;

  constructor(options: FinancialCouncilSpecialistCoordinatorOptions) {
    if (!options?.repository
      || typeof options.repository.getVerifiedRunSnapshot !== "function"
      || typeof options.repository.getSpecialistResult !== "function"
      || typeof options.repository.storeSpecialistResult !== "function"
      || typeof options.model?.analyze !== "function"
      || typeof options.model?.rebut !== "function"
      || typeof options.resolvePolicy !== "function") {
      throw new TypeError("invalid_financial_council_specialist_coordinator");
    }
    this.#repository = options.repository;
    this.#model = options.model;
    this.#resolvePolicy = options.resolvePolicy;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async runSpecialists(
    context: ActiveWorkspaceContext,
    runId: string
  ): Promise<readonly FinancialCouncilSpecialistResult[]> {
    if (!context || typeof context.workspaceId !== "string"
      || context.workspaceId.trim() === "" || context.workspaceId === "all"
      || typeof context.actorId !== "string" || context.actorId.trim() === ""
      || typeof context.teamId !== "string" || context.teamId.trim() === ""
      || typeof runId !== "string" || runId.trim() !== runId
      || runId.length < 1 || runId.length > 191) {
      return invalid("financial_council_specialist_context_invalid");
    }
    const prepared = await prepareSpecialistAuthority({
      repository: this.#repository, context, runId,
      resolvePolicy: this.#resolvePolicy, now: this.#now
    });
    const settled = await Promise.allSettled(
      FINANCIAL_COUNCIL_SPECIALIST_ROLES.map((role) =>
        this.#runPrepared(context, role, prepared))
    );
    const failed = settled.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return Object.freeze(settled.map((result) =>
      (result as PromiseFulfilledResult<FinancialCouncilSpecialistResult>)
        .value));
  }

  async inspectRole(
    context: ActiveWorkspaceContext,
    runId: string,
    role: FinancialCouncilAgentRole
  ): Promise<{
    readonly available: boolean;
    readonly gapCode?: "tax_input_missing";
    readonly hardConstraintDependency: boolean;
    readonly actionDependency: boolean;
  }> {
    const prepared = await prepareSpecialistAuthority({
      repository: this.#repository,
      context,
      runId,
      resolvePolicy: this.#resolvePolicy,
      now: this.#now
    });
    const projection = prepared.validator.project(role);
    const data = projection.businessData as {
      formulas: readonly { formulaId: string }[];
    };
    const requiredActionFormula = role === "profit"
      ? "loss_product_pricing_gap" : role === "cost"
        ? "verified_avoidable_cost" : role === "tax" ? "tax_risk" : null;
    const actionDependency = requiredActionFormula !== null
      && data.formulas.some((formula) =>
        formula.formulaId === requiredActionFormula);
    const available = role !== "tax" || data.formulas.some((formula) =>
      formula.formulaId === "tax_risk");
    return Object.freeze({
      available,
      ...(available ? {} : { gapCode: "tax_input_missing" as const }),
      hardConstraintDependency: role === "finance" || role === "cashflow",
      actionDependency
    });
  }

  async runRole(
    context: ActiveWorkspaceContext,
    runId: string,
    role: FinancialCouncilAgentRole,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilSpecialistResult> {
    const prepared = await prepareSpecialistAuthority({
      repository: this.#repository,
      context,
      runId,
      resolvePolicy: this.#resolvePolicy,
      now: this.#now
    });
    return this.#runPrepared(context, role, prepared, write);
  }

  async #runPrepared(
    context: ActiveWorkspaceContext,
    role: FinancialCouncilAgentRole,
    prepared: PreparedSpecialistAuthority,
    write?: FinancialCouncilLeaseWrite
  ): Promise<FinancialCouncilSpecialistResult> {
    const { verified, validator } = prepared;
    const existing = prepared.results.find((result) =>
      result.phase === "analyze" && result.role === role);
    if (existing) return existing;
    const projection = validator.project(role);
    const input = {
      ownerId: context.actorId,
      teamId: context.teamId,
      runId: verified.run.runId,
      snapshotId: verified.snapshot.snapshotId,
      snapshotHash: verified.snapshot.snapshotHash,
      role,
      attempt: 1,
      allowlist: projection.allowlist,
      businessData: projection.businessData
    };
    const content = buildFinancialCouncilModelContent("analyze", input);
    const modelResult = await this.#model.analyze(input);
    exactBinding(modelResult, {
      runId: verified.run.runId,
      snapshotId: verified.snapshot.snapshotId,
      snapshotHash: verified.snapshot.snapshotHash,
      role,
      contentHash: content.contentHash,
      promptHash: content.promptHash,
      schemaHash: content.schemaHash,
      promptVersion: content.promptVersion,
      schemaVersion: content.schemaVersion
    });
    const validated = validator.validate(role, modelResult.value);
    const createdAt = instant(this.#now());
    const resultId = financialCouncilCanonicalHash({
      workspaceId: verified.run.workspaceId,
      runId: verified.run.runId,
      snapshotId: verified.snapshot.snapshotId,
      snapshotHash: verified.snapshot.snapshotHash,
      role,
      phase: "analyze",
      attempt: 1,
      outputHash: validated.outputHash,
      modelJobId: modelResult.binding.jobId
    });
    const preimage = immutableFinancialCouncilValue({
      resultId,
      workspaceId: verified.run.workspaceId,
      runId: verified.run.runId,
      snapshotId: verified.snapshot.snapshotId,
      snapshotHash: verified.snapshot.snapshotHash,
      role,
      phase: "analyze" as const,
      attempt: 1,
      outputHash: validated.outputHash,
      modelBinding: modelResult.binding,
      repaired: modelResult.repaired,
      providerRequestId: modelResult.providerRequestId,
      findings: validated.findings,
      actions: validated.actions,
      createdAt
    });
    const result = validator.authorizeSpecialistResult(
      immutableFinancialCouncilValue({
        ...preimage,
        resultHash: financialCouncilCanonicalHash(preimage)
      })
    );
    return (await this.#repository.storeSpecialistResult(
      context, result,
      write ? { lease: write.lease, completedAt: instant(this.#now()) }
        : undefined
    )).value;
  }

  async rebuttalBaseInput(
    context: ActiveWorkspaceContext,
    runId: string,
    role: FinancialCouncilAgentRole,
    targetFindingId: string
  ): Promise<FinancialCouncilRebutInput> {
    const prepared = await prepareSpecialistAuthority({
      repository: this.#repository, context, runId,
      resolvePolicy: this.#resolvePolicy, now: this.#now
    });
    const projection = prepared.validator.project(role);
    if (!projection.allowlist.findingIds.includes(targetFindingId)) {
      return invalid("financial_council_rebuttal_invalid");
    }
    return immutableFinancialCouncilValue({
      ownerId: context.actorId,
      teamId: context.teamId,
      runId,
      snapshotId: prepared.verified.snapshot.snapshotId,
      snapshotHash: prepared.verified.snapshot.snapshotHash,
      role,
      attempt: 1,
      allowlist: projection.allowlist,
      businessData: projection.businessData,
      targetFindingId,
      conflictData: {}
    });
  }
}
