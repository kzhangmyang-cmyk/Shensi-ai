import { z } from "zod";
import {
  createFinancialActionProjectionPolicy,
  parseActionHypothesis,
  projectCandidateAction,
  type FinancialActionProjectionPolicyInput
} from "./financial-council-action-projector.js";
import {
  buildFinancialFormulaCatalog,
  type FinancialFormulaCatalogPolicy,
  type FinancialFormulaResult
} from "./financial-council-formulas.js";
import {
  assertFinancialCouncilRunValue,
  validateFinancialCouncilSpecialistResult,
  type FinancialCouncilSpecialistResult
} from "./financial-council-repository.js";
import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue,
  type FinancialCouncilRun
} from "./financial-council-domain.js";
import {
  validateFinancialSnapshotForRun,
  type FinancialSnapshot
} from "./financial-council-snapshot.js";
import type {
  FinancialCouncilAnalyzeOutput,
  FinancialCouncilModelAllowlist
} from "./financial-council-model-port.js";
import type {
  FinancialCouncilActionKind,
  FinancialCouncilAgentRole,
  FinancialCouncilCandidateAction,
  FinancialCouncilDataGap,
  FinancialCouncilEvidenceRef,
  FinancialCouncilFinding
} from "./growth-contract-types.js";

const ROLES = ["finance", "profit", "cost", "cashflow", "tax"] as const;
const ACTION_KINDS = [
  "collect_receivable", "review_loss_product_pricing",
  "reduce_cost_anomaly", "prepare_cash_reserve_budget",
  "complete_financial_data", "schedule_tax_review"
] as const;
const ACTION_EXPLANATIONS = Object.freeze({
  collect_receivable: "collect_receivable_hypothesis",
  review_loss_product_pricing: "review_loss_product_pricing_hypothesis",
  reduce_cost_anomaly: "reduce_cost_anomaly_hypothesis",
  prepare_cash_reserve_budget: "prepare_cash_reserve_budget_hypothesis",
  complete_financial_data: "complete_financial_data_hypothesis",
  schedule_tax_review: "税务风险需专业人员复核"
} as const satisfies Readonly<Record<FinancialCouncilActionKind, string>>);

const ROLE_FORMULAS = Object.freeze({
  finance: ["financial_data_gaps", "financial_indicators"],
  profit: ["customer_true_profit", "loss_product_pricing_gap",
    "product_true_profit"],
  cost: ["cost_analysis", "verified_avoidable_cost"],
  cashflow: ["cash_shortfall", "cashflow_forecast",
    "eligible_overdue_receivable"],
  tax: ["tax_risk"]
} as const satisfies Readonly<Record<FinancialCouncilAgentRole,
readonly string[]>>);

const ROLE_ACTIONS = Object.freeze({
  finance: ["complete_financial_data"],
  profit: ["review_loss_product_pricing"],
  cost: ["reduce_cost_anomaly"],
  cashflow: ["collect_receivable", "prepare_cash_reserve_budget"],
  tax: ["schedule_tax_review"]
} as const satisfies Readonly<Record<FinancialCouncilAgentRole,
readonly FinancialCouncilActionKind[]>>);

const ACTION_FORMULAS = Object.freeze({
  collect_receivable: "eligible_overdue_receivable",
  review_loss_product_pricing: "loss_product_pricing_gap",
  reduce_cost_anomaly: "verified_avoidable_cost",
  prepare_cash_reserve_budget: "cash_shortfall",
  complete_financial_data: "financial_data_gaps",
  schedule_tax_review: "tax_risk"
} as const satisfies Readonly<Record<FinancialCouncilActionKind, string>>);

const ROLE_EVIDENCE_SOURCES = Object.freeze({
  finance: ["business_report", "financial_fact"],
  profit: ["business_report", "quote", "roi"],
  cost: ["business_report", "acquisition_cost", "financial_fact"],
  cashflow: ["business_report", "crm", "financial_fact", "quote"],
  tax: ["business_report", "financial_fact"]
} as const satisfies Readonly<Record<FinancialCouncilAgentRole,
readonly FinancialCouncilEvidenceRef["source"][]>>);

const boundedId = z.string().min(1).max(255)
  .refine((value) => value.trim() === value);
const uniqueIds = (minimum: number, maximum: number) =>
  z.array(boundedId).min(minimum).max(maximum)
    .refine((values) => new Set(values).size === values.length);
const draftSchema = z.object({
  findingId: boundedId,
  conclusion: z.string().min(1).max(4_000),
  evidenceRefs: uniqueIds(1, 100),
  formulaRef: boundedId.nullable(),
  confidenceBps: z.number().int().min(0).max(10_000),
  severity: z.enum(["info", "warning", "critical"]),
  assumptions: uniqueIds(0, 24),
  missingDataRefs: uniqueIds(0, 100)
}).strict();
const actionSchema = z.object({
  kind: z.enum(ACTION_KINDS),
  sourceFindingIds: uniqueIds(1, 24),
  subjectRef: boundedId.nullable(),
  explanation: z.string().min(1).max(4_000)
}).strict();
const outputSchema = z.object({
  findingDrafts: z.array(draftSchema).min(1).max(24),
  actionHypotheses: z.array(actionSchema).max(24)
}).strict();

export type FinancialCouncilActionPolicyTemplate = Omit<
FinancialActionProjectionPolicyInput,
"snapshotId" | "snapshotHash" | "currency"
>;

export interface FinancialFindingValidatorOptions {
  readonly run: FinancialCouncilRun;
  readonly snapshot: unknown;
  readonly formulaPolicy: FinancialFormulaCatalogPolicy;
  readonly actionPolicy: FinancialCouncilActionPolicyTemplate;
  readonly now?: () => string;
}

export interface FinancialSpecialistProjection {
  readonly role: FinancialCouncilAgentRole;
  readonly allowlist: FinancialCouncilModelAllowlist;
  readonly businessData: unknown;
}

export interface ValidatedFinancialSpecialistOutput {
  readonly outputHash: `sha256:${string}`;
  readonly findings: readonly FinancialCouncilFinding[];
  readonly actions: readonly FinancialCouncilCandidateAction[];
}

declare const authorizedSpecialistResultBrand: unique symbol;

export type AuthorizedFinancialCouncilSpecialistResult =
  FinancialCouncilSpecialistResult & {
    readonly [authorizedSpecialistResultBrand]: true;
  };

const authorizedSpecialistResults = new WeakSet<object>();

export function assertFinancialCouncilSpecialistResultAuthorized(
  value: FinancialCouncilSpecialistResult
): asserts value is AuthorizedFinancialCouncilSpecialistResult {
  if (!value || typeof value !== "object"
    || !authorizedSpecialistResults.has(value)) {
    throw financialCouncilError("financial_council_specialist_result_invalid");
  }
}

interface RoleProjectionState {
  readonly projection: FinancialSpecialistProjection;
  readonly evidenceById: ReadonlyMap<string, FinancialCouncilEvidenceRef>;
  readonly formulaById: ReadonlyMap<string, FinancialFormulaResult>;
  readonly gapById: ReadonlyMap<string, FinancialCouncilDataGap>;
  readonly productSubjects: ReadonlySet<string>;
  readonly receivableSubjects: ReadonlySet<string>;
}

function invalid(): never {
  throw financialCouncilError("financial_finding_invalid");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function role(value: unknown): asserts value is FinancialCouncilAgentRole {
  if (!ROLES.includes(value as FinancialCouncilAgentRole)) invalid();
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    return invalid();
  }
  return parsed;
}

function evidenceId(
  snapshot: FinancialSnapshot,
  ref: FinancialCouncilEvidenceRef
): string {
  return `evidence:${financialCouncilCanonicalHash({
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    ref
  })}`;
}

function formulaId(formula: FinancialFormulaResult): string {
  return `formula:${financialCouncilCanonicalHash({
    snapshotId: formula.snapshotId,
    snapshotHash: formula.snapshotHash,
    formulaId: formula.formulaId,
    formulaVersion: formula.formulaVersion,
    inputHash: formula.inputHash,
    resultHash: formula.resultHash
  })}`;
}

function gapId(snapshot: FinancialSnapshot, gap: FinancialCouncilDataGap) {
  return `gap:${financialCouncilCanonicalHash({
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    gap
  })}`;
}

function sourceEvidence(
  snapshot: FinancialSnapshot
): readonly FinancialCouncilEvidenceRef[] {
  return Object.freeze(snapshot.sourceRefs.map((ref) => Object.freeze({
    source: ref.kind,
    sourceId: ref.sourceId,
    contentHash: ref.contentHash
  })));
}

function formulaGaps(
  snapshot: FinancialSnapshot,
  catalogGaps: readonly { readonly dataGap: FinancialCouncilDataGap }[]
): readonly FinancialCouncilDataGap[] {
  const unique = new Map<string, FinancialCouncilDataGap>();
  for (const gap of [
    ...snapshot.dataGaps,
    ...catalogGaps.map((candidate) => candidate.dataGap)
  ]) unique.set(financialCouncilCanonicalHash(gap), gap);
  return Object.freeze([...unique.values()].sort((left, right) =>
    compare(left.source, right.source)
    || compare(left.sourceId ?? "", right.sourceId ?? "")
    || compare(left.code, right.code)
    || compare(left.description, right.description)));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function bySubject(value: unknown): readonly string[] {
  const root = asRecord(value);
  if (!Array.isArray(root.bySubject)) return Object.freeze([]);
  const subjects: string[] = [];
  for (const candidate of root.bySubject) {
    const row = asRecord(candidate);
    if (typeof row.subjectRef !== "string") invalid();
    subjects.push(row.subjectRef);
  }
  return Object.freeze(subjects.sort(compare));
}

export class FinancialFindingValidator {
  readonly #run: FinancialCouncilRun;
  readonly #snapshot: FinancialSnapshot;
  readonly #catalog: ReturnType<typeof buildFinancialFormulaCatalog>;
  readonly #actionPolicy: ReturnType<
  typeof createFinancialActionProjectionPolicy>;
  readonly #states = new Map<FinancialCouncilAgentRole, RoleProjectionState>();

  constructor(options: FinancialFindingValidatorOptions) {
    try {
      assertFinancialCouncilRunValue(options.run);
      if (options.run.status !== "snapshot_frozen"
        && options.run.status !== "analyzing"
        && options.run.status !== "auditing") invalid();
      this.#run = immutableFinancialCouncilValue(options.run);
      this.#snapshot = validateFinancialSnapshotForRun(
        options.snapshot, this.#run
      );
      const now = timestamp((options.now ?? (() =>
        new Date().toISOString()))());
      if (timestamp(this.#snapshot.dataAsOf) > now + 1_000) invalid();
      this.#catalog = buildFinancialFormulaCatalog({
        snapshot: this.#snapshot,
        businessReport: this.#run.businessReport,
        policy: options.formulaPolicy
      });
      this.#actionPolicy = createFinancialActionProjectionPolicy({
        ...options.actionPolicy,
        snapshotId: this.#snapshot.snapshotId,
        snapshotHash: this.#snapshot.snapshotHash,
        currency: this.#snapshot.currency as "CNY" | "USD"
      }, this.#catalog.formulaResults);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code
        === "financial_finding_invalid") throw error;
      invalid();
    }
  }

  project(rawRole: FinancialCouncilAgentRole): FinancialSpecialistProjection {
    role(rawRole);
    let state = this.#states.get(rawRole);
    if (!state) {
      state = this.#buildProjection(rawRole);
      this.#states.set(rawRole, state);
    }
    return state.projection;
  }

  validate(
    rawRole: FinancialCouncilAgentRole,
    rawOutput: unknown
  ): ValidatedFinancialSpecialistOutput {
    try {
      role(rawRole);
      const state = this.#states.get(rawRole) ?? this.#buildProjection(rawRole);
      this.#states.set(rawRole, state);
      const stable = immutableFinancialCouncilInput(rawOutput);
      const parsed = outputSchema.safeParse(stable);
      if (!parsed.success) invalid();
      const output = parsed.data;
      const allowedFindings = new Set(state.projection.allowlist.findingIds);
      const submitted = new Set<string>();
      const formulaByFinding = new Map<string, FinancialFormulaResult>();
      const baseFindings: FinancialCouncilFinding[] = [];
      for (const draft of output.findingDrafts) {
        if (!allowedFindings.has(draft.findingId)
          || submitted.has(draft.findingId)) invalid();
        submitted.add(draft.findingId);
        const expectedConclusion = rawRole === "tax"
          ? "税务风险需专业人员复核" : "risk_hypothesis";
        if (draft.conclusion !== expectedConclusion
          || (rawRole === "tax" && draft.assumptions.length !== 0)) invalid();
        const evidence = draft.evidenceRefs.map((id) => {
          const ref = state.evidenceById.get(id);
          if (!ref) return invalid();
          return ref;
        });
        const formula = draft.formulaRef === null
          ? null : state.formulaById.get(draft.formulaRef);
        if (draft.formulaRef !== null && !formula) invalid();
        if (formula && !draft.evidenceRefs.some((id) =>
          formula.evidenceRefs.some((ref) =>
            evidenceId(this.#snapshot, ref) === id))) invalid();
        if (formula) formulaByFinding.set(draft.findingId, formula);
        const assumptions = draft.assumptions.map((id) => {
          if (!state.gapById.has(id)) invalid();
          return id;
        });
        const missingData = draft.missingDataRefs.map((id) => {
          const gap = state.gapById.get(id);
          if (!gap) return invalid();
          return gap;
        });
        baseFindings.push(immutableFinancialCouncilValue({
          findingId: draft.findingId,
          runId: this.#run.runId,
          snapshotId: this.#snapshot.snapshotId,
          agentRole: rawRole,
          conclusion: draft.conclusion,
          evidenceRefs: evidence,
          formulaRef: formula ? {
            formulaVersion: formula.formulaVersion,
            inputHash: formula.inputHash,
            resultHash: formula.resultHash
          } : null,
          confidenceBps: draft.confidenceBps,
          severity: draft.severity,
          assumptions,
          missingData,
          candidateActionIds: []
        } satisfies FinancialCouncilFinding));
      }

      const actions: FinancialCouncilCandidateAction[] = [];
      const actionIds = new Set<string>();
      for (const rawAction of output.actionHypotheses) {
        let hypothesis;
        try {
          hypothesis = parseActionHypothesis(rawAction);
        } catch {
          return invalid();
        }
        if (!ROLE_ACTIONS[rawRole].includes(hypothesis.kind as never)
          || hypothesis.explanation !== ACTION_EXPLANATIONS[hypothesis.kind]
          || hypothesis.sourceFindingIds.some((id) => !submitted.has(id)
            || formulaByFinding.get(id)?.formulaId
              !== ACTION_FORMULAS[hypothesis.kind])) {
          invalid();
        }
        if (hypothesis.kind === "review_loss_product_pricing") {
          if (hypothesis.subjectRef !== null
            && !state.productSubjects.has(hypothesis.subjectRef)) invalid();
        } else if (hypothesis.kind === "collect_receivable") {
          if (hypothesis.subjectRef !== null
            && !state.receivableSubjects.has(hypothesis.subjectRef)) invalid();
        } else if (hypothesis.subjectRef !== null) invalid();
        try {
          const action = projectCandidateAction(
            hypothesis, this.#catalog.formulaResults, this.#actionPolicy
          );
          if (actionIds.has(action.actionId)) invalid();
          actionIds.add(action.actionId);
          actions.push(action);
        } catch {
          return invalid();
        }
      }
      const actionIdsByFinding = new Map<string, string[]>();
      for (const action of actions) {
        for (const findingId of action.sourceFindingIds) {
          const ids = actionIdsByFinding.get(findingId) ?? [];
          ids.push(action.actionId);
          actionIdsByFinding.set(findingId, ids);
        }
      }
      const findings = baseFindings.map((finding) =>
        immutableFinancialCouncilValue({
          ...finding,
          candidateActionIds: (actionIdsByFinding.get(finding.findingId) ?? [])
            .sort(compare)
        }));
      return immutableFinancialCouncilValue({
        outputHash: financialCouncilCanonicalHash(stable),
        findings,
        actions
      });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code
        === "financial_finding_invalid") throw error;
      return invalid();
    }
  }

  authorizeSpecialistResult(
    rawResult: unknown
  ): AuthorizedFinancialCouncilSpecialistResult {
    try {
      const result = validateFinancialCouncilSpecialistResult(rawResult);
      if (result.workspaceId !== this.#run.workspaceId
        || result.runId !== this.#run.runId
        || result.snapshotId !== this.#snapshot.snapshotId
        || result.snapshotHash !== this.#snapshot.snapshotHash
        || timestamp(result.createdAt) < timestamp(this.#run.updatedAt)
        || timestamp(result.createdAt) > timestamp(this.#run.expiresAt)) {
        invalid();
      }
      const expectedResultId = financialCouncilCanonicalHash({
        workspaceId: result.workspaceId,
        runId: result.runId,
        snapshotId: result.snapshotId,
        snapshotHash: result.snapshotHash,
        role: result.role,
        phase: result.phase,
        attempt: result.attempt,
        outputHash: result.outputHash,
        modelJobId: result.modelBinding.jobId
      });
      if (result.resultId !== expectedResultId) invalid();
      const state = this.#states.get(result.role)
        ?? this.#buildProjection(result.role);
      this.#states.set(result.role, state);
      this.#assertPersistedSemantics(result, state);
      authorizedSpecialistResults.add(result);
      return result as AuthorizedFinancialCouncilSpecialistResult;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code
        === "financial_finding_invalid") throw error;
      invalid();
    }
  }

  #assertPersistedSemantics(
    result: FinancialCouncilSpecialistResult,
    state: RoleProjectionState
  ): void {
    const allowedFindingIds = new Set(state.projection.allowlist.findingIds);
    const formulas = [...state.formulaById.values()];
    const formulaByFinding = new Map<string, FinancialFormulaResult>();
    const findingIds = new Set<string>();
    for (const finding of result.findings) {
      if (!allowedFindingIds.has(finding.findingId)
        || findingIds.has(finding.findingId)
        || finding.runId !== result.runId
        || finding.snapshotId !== result.snapshotId
        || finding.agentRole !== result.role
        || finding.conclusion !== (result.role === "tax"
          ? "税务风险需专业人员复核" : "risk_hypothesis")
        || (result.role === "tax" && finding.assumptions.length !== 0)) {
        invalid();
      }
      findingIds.add(finding.findingId);
      for (const evidence of finding.evidenceRefs) {
        const allowed = state.evidenceById.get(evidenceId(
          this.#snapshot, evidence
        ));
        if (!allowed || financialCouncilCanonicalHash(allowed)
          !== financialCouncilCanonicalHash(evidence)) invalid();
      }
      const formula = finding.formulaRef === null ? null : formulas.find(
        (candidate) => candidate.formulaVersion
          === finding.formulaRef!.formulaVersion
          && candidate.inputHash === finding.formulaRef!.inputHash
          && candidate.resultHash === finding.formulaRef!.resultHash
      ) ?? null;
      if (finding.formulaRef !== null && !formula) invalid();
      if (formula && !finding.evidenceRefs.some((evidence) =>
        formula.evidenceRefs.some((formulaEvidence) =>
          financialCouncilCanonicalHash(formulaEvidence)
            === financialCouncilCanonicalHash(evidence)))) invalid();
      if (formula) formulaByFinding.set(finding.findingId, formula);
      if (finding.assumptions.some((id) => !state.gapById.has(id))) invalid();
      const missingHashes = new Set(finding.missingData.map((gap) =>
        financialCouncilCanonicalHash(gap)));
      if (missingHashes.size !== finding.missingData.length
        || finding.missingData.some((gap) => ![...state.gapById.values()]
          .some((allowed) => financialCouncilCanonicalHash(allowed)
            === financialCouncilCanonicalHash(gap)))) invalid();
    }

    const expectedActions: FinancialCouncilCandidateAction[] = [];
    for (const action of result.actions) {
      if (!ROLE_ACTIONS[result.role].includes(action.kind as never)
        || action.sourceFindingIds.some((id) => !findingIds.has(id)
          || formulaByFinding.get(id)?.formulaId
            !== ACTION_FORMULAS[action.kind])) invalid();
      if (action.kind === "review_loss_product_pricing") {
        if (action.subjectRef !== null
          && !state.productSubjects.has(action.subjectRef)) invalid();
      } else if (action.kind === "collect_receivable") {
        if (action.subjectRef !== null
          && !state.receivableSubjects.has(action.subjectRef)) invalid();
      } else if (action.subjectRef !== null) invalid();
      const projected = projectCandidateAction({
        kind: action.kind,
        sourceFindingIds: action.sourceFindingIds,
        subjectRef: action.subjectRef,
        explanation: action.kind === "schedule_tax_review"
          ? "税务风险需专业人员复核" : action.explanation
      }, this.#catalog.formulaResults, this.#actionPolicy);
      if (financialCouncilCanonicalHash(projected)
        !== financialCouncilCanonicalHash(action)) invalid();
      expectedActions.push(projected);
    }
    const expectedByFinding = new Map<string, string[]>();
    for (const action of expectedActions) {
      for (const findingId of action.sourceFindingIds) {
        const ids = expectedByFinding.get(findingId) ?? [];
        ids.push(action.actionId);
        expectedByFinding.set(findingId, ids);
      }
    }
    for (const finding of result.findings) {
      const expected = (expectedByFinding.get(finding.findingId) ?? [])
        .sort(compare);
      if (financialCouncilCanonicalHash(expected)
        !== financialCouncilCanonicalHash(finding.candidateActionIds)) {
        invalid();
      }
    }
  }

  #buildProjection(role: FinancialCouncilAgentRole): RoleProjectionState {
    const formulaIds = ROLE_FORMULAS[role];
    const formulas = this.#catalog.formulaResults.filter((formula) =>
      formulaIds.includes(formula.formulaId as never));
    const formulaById = new Map(formulas.map((formula) =>
      [formulaId(formula), formula] as const));
    const allowedSources = new Set(ROLE_EVIDENCE_SOURCES[role]);
    const gaps = formulaGaps(this.#snapshot, this.#catalog.dataGaps).filter(
      (gap) => allowedSources.has(gap.source as never)
    );
    const gapById = new Map(gaps.map((gap) =>
      [gapId(this.#snapshot, gap), gap] as const));
    const facts = this.#roleFacts(role);
    const visibleSourceIds = new Map<string, Set<string>>();
    const expose = (source: string, sourceId: string) => {
      const ids = visibleSourceIds.get(source) ?? new Set<string>();
      ids.add(sourceId);
      visibleSourceIds.set(source, ids);
    };
    for (const fact of facts) expose("financial_fact", fact.entryId);
    for (const gap of gaps) {
      if (gap.sourceId !== null) expose(gap.source, gap.sourceId);
    }
    if (role === "profit") {
      for (const quote of this.#snapshot.authority.pendingQuoteApprovals) {
        expose("quote", quote.quoteVersionId);
      }
      for (const [kind, rows] of [
        ["expected", this.#snapshot.authority.expectedRoi],
        ["actual", this.#snapshot.authority.actualRoi]
      ] as const) {
        for (const row of rows) {
          expose("roi", `${kind}:${row.cohortId}:`
            + `${row.planId ?? "all"}:${row.currency}`);
        }
      }
    }
    const evidence = sourceEvidence(this.#snapshot).filter((ref) =>
      allowedSources.has(ref.source as never)
      && (ref.source === "business_report"
        || visibleSourceIds.get(ref.source)?.has(ref.sourceId) === true));
    const evidenceById = new Map(evidence.map((ref) =>
      [evidenceId(this.#snapshot, ref), ref] as const));
    const productFormula = formulas.find((formula) =>
      formula.formulaId === "loss_product_pricing_gap");
    const receivableFormula = formulas.find((formula) =>
      formula.formulaId === "eligible_overdue_receivable");
    const productSubjects = new Set(productFormula
      ? bySubject(productFormula.value) : []);
    const receivableSubjects = new Set(receivableFormula
      ? bySubject(receivableFormula.value) : []);
    const subjectRefs = [...new Set([
      ...productSubjects, ...receivableSubjects
    ])].sort(compare);
    const findingIds = Array.from({ length: 24 }, (_, index) =>
      `finding:${financialCouncilCanonicalHash({
        runId: this.#run.runId,
        snapshotId: this.#snapshot.snapshotId,
        snapshotHash: this.#snapshot.snapshotHash,
        role,
        slot: index + 1
      })}`);
    const allowlist = immutableFinancialCouncilValue({
      evidenceRefIds: [...evidenceById.keys()].sort(compare),
      formulaRefIds: [...formulaById.keys()].sort(compare),
      findingIds,
      subjectRefs,
      dataGapRefs: [...gapById.keys()].sort(compare)
    } satisfies FinancialCouncilModelAllowlist);
    if (allowlist.evidenceRefIds.length === 0) invalid();
    const formulaRows = [...formulaById].map(([refId, formula]) => ({
      refId,
      formulaId: formula.formulaId,
      formulaVersion: formula.formulaVersion,
      unit: formula.unit,
      value: formula.value,
      evidenceRefIds: formula.evidenceRefs.map((ref) =>
        evidenceId(this.#snapshot, ref))
        .filter((id) => evidenceById.has(id))
        .sort(compare)
    })).sort((left, right) => compare(left.formulaId, right.formulaId));
    const businessData = immutableFinancialCouncilValue({
      snapshot: {
        runId: this.#run.runId,
        workspaceId: this.#run.workspaceId,
        snapshotId: this.#snapshot.snapshotId,
        snapshotHash: this.#snapshot.snapshotHash,
        dataAsOf: this.#snapshot.dataAsOf,
        currency: this.#snapshot.currency
      },
      manifest: {
        formulaIds: [...formulaIds],
        actionKinds: [...ROLE_ACTIONS[role]]
      },
      formulas: formulaRows,
      evidence: [...evidenceById].map(([refId, ref]) => ({ refId, ...ref })),
      dataGaps: [...gapById].map(([refId, dataGap]) => ({ refId, dataGap })),
      slice: this.#roleSlice(role, receivableSubjects, facts)
    });
    return Object.freeze({
      projection: immutableFinancialCouncilValue({
        role, allowlist, businessData
      }),
      evidenceById,
      formulaById,
      gapById,
      productSubjects,
      receivableSubjects
    });
  }

  #roleSlice(
    role: FinancialCouncilAgentRole,
    receivableSubjects: ReadonlySet<string>,
    facts: FinancialSnapshot["authority"]["verifiedFinancialFacts"]
  ): unknown {
    switch (role) {
      case "finance":
        return {
          report: this.#snapshot.report,
          indicators: this.#snapshot.formulaInputs.indicators,
          verifiedFinancialFacts: facts
        };
      case "profit":
        return {
          products: this.#snapshot.formulaInputs.products,
          customers: this.#snapshot.formulaInputs.customers,
          quoteSummaries: this.#snapshot.authority.pendingQuoteApprovals,
          expectedRoi: this.#snapshot.authority.expectedRoi,
          actualRoi: this.#snapshot.authority.actualRoi
        };
      case "cost":
        return {
          cost: this.#snapshot.formulaInputs.cost,
          verifiedFinancialFacts: facts
        };
      case "cashflow":
        return {
          cashflow: this.#snapshot.formulaInputs.cashflow,
          receivableSubjects: [...receivableSubjects].sort(compare),
          verifiedFinancialFacts: facts
        };
      case "tax":
        return {
          tax: this.#snapshot.formulaInputs.tax,
          verifiedDataGaps: this.#snapshot.dataGaps.filter((gap) =>
            gap.source === "business_report" || gap.source === "financial_fact")
        };
    }
  }

  #roleFacts(
    role: FinancialCouncilAgentRole
  ): FinancialSnapshot["authority"]["verifiedFinancialFacts"] {
    switch (role) {
      case "finance":
        return this.#snapshot.authority.verifiedFinancialFacts;
      case "cost":
        return this.#snapshot.authority.verifiedFinancialFacts.filter((fact) =>
          fact.factType === "cogs_recognized");
      case "cashflow":
        return this.#snapshot.authority.verifiedFinancialFacts.filter((fact) =>
          fact.factType === "payment_received"
          || fact.factType === "refund"
          || fact.factType === "bad_debt_written_off");
      case "profit":
      case "tax":
        return Object.freeze([]);
    }
  }
}
