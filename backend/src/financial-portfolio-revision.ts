import {
  optimizeFinancialActions,
  type FinancialActionOptimizerInput,
  type FinancialActionPortfolio
} from "./financial-action-optimizer.js";
import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import type {
  FinancialCouncilAgentRole,
  FinancialCouncilCandidateAction,
  FinancialCouncilPortfolioKind
} from "./growth-contract-types.js";
import type { CommandContext } from "./growth-command-context.js";
import type { FinancialCouncilPolicyRepository } from
  "./financial-council-policy-repository.js";
import {
  createFinancialCouncilPortfolioRevision,
  financialCouncilPortfolioCommandKeyHash,
  financialCouncilOptimizationRunHash,
  selectFinancialCouncilOptimizationCandidates,
  type FinancialCouncilRepository
} from "./financial-council-repository.js";
import {
  createFinancialActionOptimizerInput,
  projectFinancialActionPortfolios
} from "./financial-council-optimization-worker.js";

const PORTFOLIO_KINDS = new Set<FinancialCouncilPortfolioKind>([
  "balanced", "cash_first", "growth_first"
]);
const OWNER_ROLES = new Set<FinancialCouncilAgentRole>([
  "finance", "profit", "cost", "cashflow", "tax"
]);

export type FinancialPortfolioEditOperation =
  | { readonly kind: "select_portfolio";
      readonly portfolioKind: FinancialCouncilPortfolioKind }
  | { readonly kind: "remove_action"; readonly actionId: string }
  | { readonly kind: "restore_action"; readonly actionId: string }
  | { readonly kind: "replace_action_parameters";
      readonly actionId: string;
      readonly parameters: {
        readonly ownerRole?: FinancialCouncilAgentRole;
        readonly durationDays?: number;
      } };

function invalid(code = "financial_council_portfolio_operation_invalid"): never {
  throw financialCouncilError(code);
}

function exactKeys(value: unknown, allowed: readonly string[]):
asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const keys = Object.keys(value as object).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])) invalid();
}

function actionId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === ""
    || [...value].length > 255) invalid();
  return value;
}

function canonicalOperation(raw: unknown): FinancialPortfolioEditOperation {
  const operation = immutableFinancialCouncilInput(raw);
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    return invalid();
  }
  const kind = Reflect.get(operation, "kind");
  if (kind === "select_portfolio") {
    exactKeys(operation, ["kind", "portfolioKind"]);
    const portfolioKind = Reflect.get(operation, "portfolioKind");
    if (!PORTFOLIO_KINDS.has(portfolioKind as FinancialCouncilPortfolioKind)) {
      return invalid();
    }
    return Object.freeze({ kind, portfolioKind }) as FinancialPortfolioEditOperation;
  }
  if (kind === "remove_action" || kind === "restore_action") {
    exactKeys(operation, ["kind", "actionId"]);
    return Object.freeze({ kind, actionId: actionId(
      Reflect.get(operation, "actionId")
    ) });
  }
  if (kind === "replace_action_parameters") {
    exactKeys(operation, ["kind", "actionId", "parameters"]);
    const parameters = Reflect.get(operation, "parameters");
    if (!parameters || typeof parameters !== "object"
      || Array.isArray(parameters)) return invalid();
    const keys = Object.keys(parameters);
    if (keys.length === 0 || keys.some((key) =>
      key !== "ownerRole" && key !== "durationDays")) return invalid();
    const ownerRole = Reflect.get(parameters, "ownerRole");
    const durationDays = Reflect.get(parameters, "durationDays");
    if (ownerRole !== undefined
      && !OWNER_ROLES.has(ownerRole as FinancialCouncilAgentRole)) invalid();
    if (durationDays !== undefined
      && (!Number.isSafeInteger(durationDays) || Number(durationDays) < 1
        || Number(durationDays) > 365)) invalid();
    return immutableFinancialCouncilValue({
      kind,
      actionId: actionId(Reflect.get(operation, "actionId")),
      parameters: {
        ...(ownerRole === undefined ? {} : { ownerRole }),
        ...(durationDays === undefined ? {} : { durationDays })
      }
    }) as FinancialPortfolioEditOperation;
  }
  return invalid();
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function applyFinancialPortfolioOperations(input: {
  readonly originalActions: readonly FinancialCouncilCandidateAction[];
  readonly basePortfolios: readonly Pick<FinancialActionPortfolio,
    "kind" | "actionIds">[];
  readonly startingActionIds?: readonly string[];
  readonly operations: readonly FinancialPortfolioEditOperation[];
}): readonly FinancialCouncilCandidateAction[] {
  const originalActions = immutableFinancialCouncilInput(input.originalActions);
  const basePortfolios = immutableFinancialCouncilInput(input.basePortfolios);
  if (!Array.isArray(originalActions) || !Array.isArray(basePortfolios)
    || !Array.isArray(input.operations) || input.operations.length === 0
    || input.operations.length > 100) invalid();
  const originals = new Map<string, FinancialCouncilCandidateAction>();
  for (const candidate of originalActions) {
    const id = actionId(candidate?.actionId);
    if (originals.has(id)) invalid();
    originals.set(id, candidate);
  }
  const operations = input.operations.map(canonicalOperation);
  const identities = new Set<string>();
  for (const operation of operations) {
    const identity = operation.kind === "select_portfolio"
      ? operation.kind : `${operation.kind}\u0000${operation.actionId}`;
    if (identities.has(identity)) {
      invalid("financial_council_portfolio_operation_duplicate");
    }
    identities.add(identity);
    if (operation.kind !== "select_portfolio"
      && !originals.has(operation.actionId)) {
      invalid("financial_council_portfolio_action_not_found");
    }
  }

  if (input.startingActionIds?.some((id: string) => !originals.has(id))) invalid();
  let selected = new Set(input.startingActionIds ?? originals.keys());
  const replacements = new Map<string, Readonly<{
    ownerRole?: FinancialCouncilAgentRole; durationDays?: number }>>();
  for (const operation of operations) {
    if (operation.kind === "select_portfolio") {
      const portfolio = basePortfolios.find((row) =>
        row.kind === operation.portfolioKind);
      if (!portfolio) invalid();
      if (portfolio.actionIds.some((id: string) => !originals.has(id))) invalid();
      selected = new Set(portfolio.actionIds);
    } else if (operation.kind === "remove_action") {
      selected.delete(operation.actionId);
    } else if (operation.kind === "restore_action") {
      selected.add(operation.actionId);
    } else {
      replacements.set(operation.actionId, operation.parameters);
    }
  }
  return immutableFinancialCouncilValue([...selected]
    .sort(compareUtf8)
    .map((id) => {
      const original = originals.get(id)!;
      const replacement = replacements.get(id);
      return replacement ? {
        ...original,
        ...(replacement.ownerRole === undefined ? {}
          : { ownerRole: replacement.ownerRole }),
        ...(replacement.durationDays === undefined ? {}
          : { durationDays: replacement.durationDays })
      } : original;
    }));
}

/** Rebuilds optimizer input from validated candidates; no prior score is read. */
export function recomputeEditedFinancialPortfolios(input: {
  readonly optimizerInput: FinancialActionOptimizerInput;
  readonly basePortfolios: readonly FinancialActionPortfolio[];
  readonly operations: readonly FinancialPortfolioEditOperation[];
  readonly optimize?: typeof optimizeFinancialActions;
}): readonly FinancialActionPortfolio[] {
  const stable = immutableFinancialCouncilInput(input.optimizerInput);
  const actions = applyFinancialPortfolioOperations({
    originalActions: stable.actions,
    basePortfolios: input.basePortfolios,
    operations: input.operations
  });
  return (input.optimize ?? optimizeFinancialActions)(
    immutableFinancialCouncilValue({ ...stable, actions })
  );
}

export interface ReviseFinancialPortfolioInput {
  readonly runId: string;
  readonly baseRevision: number;
  readonly operations: readonly FinancialPortfolioEditOperation[];
}

export class FinancialPortfolioRevisionService {
  readonly #now: () => string;
  readonly #optimize: typeof optimizeFinancialActions;

  constructor(private readonly dependencies: {
    readonly repository: FinancialCouncilRepository;
    readonly policyRepository: FinancialCouncilPolicyRepository;
    readonly now?: () => string;
    readonly optimize?: typeof optimizeFinancialActions;
  }) {
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#optimize = dependencies.optimize ?? optimizeFinancialActions;
  }

  async revisePortfolio(
    command: CommandContext,
    rawInput: ReviseFinancialPortfolioInput
  ) {
    const input = immutableFinancialCouncilInput(rawInput);
    if (!command || command.actorId !== command.workspace.actorId
      || !Number.isSafeInteger(command.expectedRevision)
      || typeof input.runId !== "string" || !input.runId.trim()
      || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1
      || !Array.isArray(input.operations) || input.operations.length === 0) {
      invalid();
    }
    const run = await this.dependencies.repository.findRun(
      command.workspace, input.runId
    );
    if (!run) throw financialCouncilError("financial_council_run_not_found");
    if (run.status !== "awaiting_approval") {
      throw financialCouncilError("financial_council_portfolio_state_invalid");
    }
    const operationsHash = financialCouncilCanonicalHash(input.operations);
    const commandKeyHash = financialCouncilPortfolioCommandKeyHash(command);
    const targetRevision = input.baseRevision + 1;
    const existing = await this.dependencies.repository.getPortfolioRevision(
      command.workspace, input.runId, targetRevision
    );
    if (existing) {
      if (existing.commandKeyHash === commandKeyHash
        && existing.commandRequestHash === command.requestHash
        && existing.operationsHash === operationsHash) {
        return { value: existing, replayed: true };
      }
      if (existing.commandKeyHash === commandKeyHash) {
        throw financialCouncilError("financial_council_idempotency_conflict");
      }
      throw financialCouncilError("financial_council_portfolio_revision_conflict");
    }
    if (run.revision !== command.expectedRevision) {
      throw financialCouncilError("financial_council_revision_conflict");
    }
    if (run.latestPortfolioRevision !== input.baseRevision) {
      throw financialCouncilError("financial_council_portfolio_revision_conflict");
    }
    const [verified, graph, consensus, results, baseRevision, firstRevision,
      policy] = await Promise.all([
      this.dependencies.repository.getVerifiedRunSnapshot(
        command.workspace, input.runId),
      this.dependencies.repository.getAuditGraph(command.workspace, input.runId),
      this.dependencies.repository.getConsensus(command.workspace, input.runId),
      this.dependencies.repository.listSpecialistResults(
        command.workspace, input.runId),
      this.dependencies.repository.getPortfolioRevision(
        command.workspace, input.runId, input.baseRevision),
      this.dependencies.repository.getPortfolioRevision(
        command.workspace, input.runId, 1),
      this.dependencies.policyRepository.findVersion(
        command.workspace, run.policyVersionId)
    ]);
    if (!verified || !graph || !consensus || !baseRevision || !firstRevision
      || !policy) throw financialCouncilError("financial_council_integrity");
    const originals = selectFinancialCouncilOptimizationCandidates(
      consensus, results
    );
    const currentById = new Map(baseRevision.portfolios.flatMap((portfolio) =>
      portfolio.actions).map((action) => [action.actionId, action] as const));
    const editableOriginals = originals.map((action) =>
      currentById.get(action.actionId) ?? action);
    const startingActionIds = [...new Set(baseRevision.portfolios.flatMap(
      (portfolio) => portfolio.actionIds
    ))];
    const actions = applyFinancialPortfolioOperations({
      originalActions: editableOriginals,
      basePortfolios: baseRevision.portfolios as unknown as readonly Pick<
        FinancialActionPortfolio, "kind" | "actionIds">[],
      startingActionIds,
      operations: input.operations
    });
    const rows = this.#optimize(createFinancialActionOptimizerInput({
      run, snapshot: verified.snapshot, consensus, actions, policy
    }));
    if (rows.some((row) => row.status === "not_computable")) {
      throw financialCouncilError("financial_council_portfolio_not_computable");
    }
    const createdAt = this.#now();
    const portfolios = projectFinancialActionPortfolios({
      run, rows, createdAt, revision: targetRevision
    });
    const revision = createFinancialCouncilPortfolioRevision({
      workspaceId: run.workspaceId,
      runId: run.runId,
      revision: targetRevision,
      baseRevision: input.baseRevision,
      commandKeyHash,
      commandRequestHash: command.requestHash as `sha256:${string}`,
      operationsHash,
      runHash: financialCouncilOptimizationRunHash(run),
      snapshotId: run.snapshotId!,
      snapshotHash: run.snapshotHash!,
      auditHash: graph.graphHash,
      policyVersionId: policy.policyVersionId,
      policyHash: policy.policyHash,
      consensusReportId: consensus.reportId,
      candidateSetHash: firstRevision.candidateSetHash,
      portfolios,
      createdAt
    });
    return this.dependencies.repository.commitPortfolioRevision(command, {
      revision
    });
  }
}
