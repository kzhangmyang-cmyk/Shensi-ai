import type {
  AcquisitionPresentationCandidateSnapshot,
  AcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import type {
  AcquisitionPlanRunRepository
} from "./acquisition-plan-run-repository.js";
import type {
  AcquisitionOutcomeReconciliationDiagnostic
} from "./types.js";

export interface AcquisitionPerformanceQuery {
  platform?: "douyin" | "web";
  from: string;
  to: string;
}

export interface AcquisitionPerformanceQueryLimits {
  runs: number;
  eventsPerRun: number;
  candidates: number;
  historyPerCandidate: number;
  evidenceRefs: number;
}

const defaultLimits: AcquisitionPerformanceQueryLimits = {
  runs: 100,
  eventsPerRun: 1_000,
  candidates: 500,
  historyPerCandidate: 500,
  evidenceRefs: 500
};

export interface AcquisitionPerformanceFact {
  metricId: string;
  text: string;
  evidenceRefs: string[];
}

export interface AcquisitionPerformanceDto {
  counts: {
    discovered: number;
    highIntent: number;
    approved: number;
    converted: number;
    contacted: number;
    quoted: number;
    won: number;
    lost: number;
  };
  rates: {
    highIntentRate: number | null;
    approvalRate: number | null;
    crmConversionRate: number | null;
    contactRate: number | null;
    quoteRate: number | null;
    winRate: number | null;
  };
  valuesByCurrency: Array<{
    currency: string;
    estimatedPipelineMinor: number;
    quotedMinor: number;
    wonContractMinor: number;
  }>;
  cost: {
    status: "available" | "not_aggregatable";
    executionCostMinor: number | null;
    currency: string | null;
    coverage: "recorded_api_execution_only";
  };
  roi: {
    status: "not_computable";
    reason: "channel_cost_or_verified_margin_unavailable";
  };
  dataQuality: {
    missingAttribution: number;
    missingFinancial: number;
    truncated: boolean;
    lastReconciledAt: string | null;
  };
  briefingFacts: {
    headlines: AcquisitionPerformanceFact[];
    risks: AcquisitionPerformanceFact[];
    actions: AcquisitionPerformanceFact[];
    metricIds: string[];
  };
}

interface PerformanceReconciler {
  runOnce(): Promise<{ lastReconciledAt: string | null }>;
}

interface PerformanceCheckpoint {
  ownerId: string;
  teamId: string;
  updatedAt: string;
}

function rate(numerator: number, denominator: number) {
  return denominator === 0 ? null : numerator / denominator;
}

function inWindow(value: string, from: string, to: string) {
  const time = new Date(value).getTime();
  return Number.isFinite(time)
    && time >= new Date(from).getTime()
    && time <= new Date(to).getTime();
}

function moneyValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const amount = value as { amountMinor?: unknown; currency?: unknown };
  if (!Number.isSafeInteger(amount.amountMinor)
    || Number(amount.amountMinor) < 0
    || typeof amount.currency !== "string"
    || !/^[A-Z]{3}$/.test(amount.currency.toUpperCase())) return null;
  return {
    amountMinor: Number(amount.amountMinor),
    currency: amount.currency.toUpperCase()
  };
}

function fact(
  metricId: string,
  text: string,
  evidenceRefs: string[]
): AcquisitionPerformanceFact {
  return { metricId, text, evidenceRefs };
}

export class AcquisitionPerformanceQueryService {
  readonly #planRuns: Pick<
    AcquisitionPlanRunRepository,
    "listRuns" | "listRunEvents"
  >;
  readonly #domain: Pick<
    AcquisitionDomainRepository,
    | "getPresentationCandidateSnapshots"
    | "listQualificationDecisions"
    | "listFinancialValues"
    | "listOutcomes"
    | "listAuditEvents"
  >;
  readonly #diagnostics: AcquisitionOutcomeReconciliationDiagnostic[];
  readonly #checkpoints: PerformanceCheckpoint[];
  readonly #limits: AcquisitionPerformanceQueryLimits;

  constructor(options: {
    planRuns: Pick<
      AcquisitionPlanRunRepository,
      "listRuns" | "listRunEvents"
    >;
    domain: Pick<
      AcquisitionDomainRepository,
      | "getPresentationCandidateSnapshots"
      | "listQualificationDecisions"
      | "listFinancialValues"
      | "listOutcomes"
      | "listAuditEvents"
    >;
    diagnostics: AcquisitionOutcomeReconciliationDiagnostic[];
    checkpoints?: PerformanceCheckpoint[];
    limits?: Partial<AcquisitionPerformanceQueryLimits>;
    /** Accepted temporarily for backwards-compatible composition; never called. */
    reconcile?: PerformanceReconciler;
  }) {
    this.#planRuns = options.planRuns;
    this.#domain = options.domain;
    this.#diagnostics = options.diagnostics;
    this.#checkpoints = options.checkpoints ?? [];
    this.#limits = { ...defaultLimits, ...options.limits };
    for (const [name, value] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`performance limit ${name} must be a positive integer`);
      }
    }
  }

  async get(
    scope: { ownerId: string; teamId: string },
    query: AcquisitionPerformanceQuery
  ): Promise<AcquisitionPerformanceDto> {
    let truncated = false;
    const fromMs = new Date(query.from).getTime();
    const toMs = new Date(query.to).getTime();
    const windowDurationMs = toMs - fromMs + 1;
    const previousFrom = new Date(fromMs - windowDurationMs).toISOString();
    const previousTo = new Date(fromMs - 1).toISOString();
    const inRelevantWindow = (value: string) =>
      inWindow(value, previousFrom, previousTo)
      || inWindow(value, query.from, query.to);
    const lastReconciledAt = this.#checkpoints
      .filter((item) =>
        item.ownerId === scope.ownerId && item.teamId === scope.teamId)
      .map((item) => item.updatedAt)
      .sort((left, right) => right.localeCompare(left))[0] ?? null;
    const queriedRuns = await this.#planRuns.listRuns(scope, {
      ...(query.platform ? { targetPlatform: query.platform } : {}),
      createdAtOnOrBefore: query.to,
      orderBy: "created_at_desc",
      limit: this.#limits.runs + 1
    });
    if (queriedRuns.length > this.#limits.runs) truncated = true;
    const selectedRuns = queriedRuns
      .slice(0, this.#limits.runs)
      .map((run) => ({ run }));
    const selectedRunIds = new Set(selectedRuns.map(({ run }) => run.id));
    const allDiscoveryEvents = (await Promise.all(selectedRuns.map(
      async ({ run }) => {
        const events = (await this.#planRuns.listRunEvents(run.id))
          .filter((event) =>
            event.runId === run.id
            && event.ownerId === scope.ownerId
            && event.teamId === scope.teamId
            && event.type === "candidate.discovered"
            && event.data.candidateId
            && inRelevantWindow(event.at))
          .sort((left, right) =>
            right.at.localeCompare(left.at) || right.id.localeCompare(left.id));
        if (events.length > this.#limits.eventsPerRun) truncated = true;
        return events.slice(0, this.#limits.eventsPerRun);
      }
    ))).flat();
    const discoveryEvents = allDiscoveryEvents.filter((event) =>
      inWindow(event.at, query.from, query.to));
    const previousDiscoveryEvents = allDiscoveryEvents.filter((event) =>
      inWindow(event.at, previousFrom, previousTo));
    const candidateEvent = new Map<string, (typeof discoveryEvents)[number]>();
    for (const event of discoveryEvents.sort((left, right) =>
      left.at.localeCompare(right.at) || left.id.localeCompare(right.id))) {
      candidateEvent.set(String(event.data.candidateId), event);
    }
    const allCandidateIds = [...candidateEvent.keys()].sort();
    if (allCandidateIds.length > this.#limits.candidates) truncated = true;
    const candidateIds = allCandidateIds.slice(0, this.#limits.candidates);
    const boundedCandidateIds = new Set(candidateIds);
    const snapshots = candidateIds.length
      ? await this.#domain.getPresentationCandidateSnapshots(scope, candidateIds)
      : [];
    const scopedSnapshots = snapshots.filter((snapshot) =>
      boundedCandidateIds.has(snapshot.candidate.id)
      && snapshot.candidate.ownerId === scope.ownerId
      && snapshot.candidate.teamId === scope.teamId);
    const candidateHistory = await Promise.all(candidateIds.map(
      async (candidateId) => {
        const [allDecisions, allFinancials] = await Promise.all([
          this.#domain.listQualificationDecisions(scope, candidateId),
          this.#domain.listFinancialValues(scope, candidateId)
        ]);
        const decisions = allDecisions.filter((decision) =>
          decision.candidateId === candidateId
          && decision.ownerId === scope.ownerId
          && decision.teamId === scope.teamId
          && inWindow(decision.createdAt, query.from, query.to))
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt)
            || right.id.localeCompare(left.id));
        const financials = allFinancials.filter((financial) =>
          financial.candidateId === candidateId
          && financial.ownerId === scope.ownerId
          && financial.teamId === scope.teamId
          && inWindow(financial.createdAt, query.from, query.to))
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt)
            || right.id.localeCompare(left.id));
        if (decisions.length > this.#limits.historyPerCandidate
          || financials.length > this.#limits.historyPerCandidate) {
          truncated = true;
        }
        const qualification = decisions
          .slice(0, this.#limits.historyPerCandidate)[0] ?? null;
        const financial = qualification
          ? financials.slice(0, this.#limits.historyPerCandidate).find((item) =>
              item.qualificationDecisionId === qualification.id) ?? null
          : null;
        return { candidateId, qualification, financial };
      }
    ));
    const qualificationByCandidate = new Map(candidateHistory.map((item) =>
      [item.candidateId, item.qualification] as const));
    const financialByCandidate = new Map(candidateHistory.map((item) =>
      [item.candidateId, item.financial] as const));
    const outcomes = (await Promise.all(candidateIds.map(
      async (candidateId) => {
        const items = (await this.#domain.listOutcomes(scope, candidateId))
          .filter((outcome) =>
            outcome.candidateId === candidateId
            && outcome.ownerId === scope.ownerId
            && outcome.teamId === scope.teamId
            && inWindow(outcome.occurredAt, query.from, query.to)
            && (!query.platform
              || selectedRunIds.has(outcome.attribution?.runId ?? "")))
          .sort((left, right) =>
            right.occurredAt.localeCompare(left.occurredAt)
            || right.id.localeCompare(left.id));
        if (items.length > this.#limits.historyPerCandidate) truncated = true;
        return items.slice(0, this.#limits.historyPerCandidate);
      }
    ))).flat();
    const auditEvents = (await Promise.all(candidateIds.map(
      async (candidateId) => {
        const items = (await this.#domain.listAuditEvents(scope, candidateId))
          .filter((event) =>
            event.candidateId === candidateId
            && event.ownerId === scope.ownerId
            && event.teamId === scope.teamId
            && inWindow(event.createdAt, query.from, query.to))
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt)
            || right.id.localeCompare(left.id));
        if (items.length > this.#limits.historyPerCandidate) truncated = true;
        return items.slice(0, this.#limits.historyPerCandidate);
      }
    ))).flat();
    const candidatesForOutcome = (eventType: string) => new Set(outcomes
      .filter((outcome) => outcome.eventType === eventType)
      .map((outcome) => outcome.candidateId));
    const highIntent = [...qualificationByCandidate.values()].filter(
      (decision) => decision && ["S", "A"].includes(decision.grade)
    ).length;
    const approved = new Set(auditEvents.filter((event) =>
      event.toStatus === "approved").map((event) => event.candidateId)).size;
    const converted = new Set(auditEvents.filter((event) =>
      event.toStatus === "converted_to_lead")
      .map((event) => event.candidateId)).size;
    const contacted = candidatesForOutcome("contacted").size;
    const quoted = candidatesForOutcome("quoted").size;
    const won = candidatesForOutcome("won").size;
    const lost = candidatesForOutcome("lost").size;
    const counts = {
      discovered: candidateIds.length,
      highIntent,
      approved,
      converted,
      contacted,
      quoted,
      won,
      lost
    };
    const rates = {
      highIntentRate: rate(highIntent, counts.discovered),
      approvalRate: rate(approved, counts.discovered),
      crmConversionRate: rate(converted, approved),
      contactRate: rate(contacted, converted),
      quoteRate: rate(quoted, contacted),
      winRate: rate(won, quoted)
    };
    const byCurrency = new Map<string, {
      estimatedPipelineMinor: number;
      quotedMinor: number;
      wonContractMinor: number;
    }>();
    const currency = (code: string) => {
      const key = code.toUpperCase();
      const current = byCurrency.get(key) ?? {
        estimatedPipelineMinor: 0,
        quotedMinor: 0,
        wonContractMinor: 0
      };
      byCurrency.set(key, current);
      return current;
    };
    for (const snapshot of scopedSnapshots) {
      const financial = financialByCandidate.get(snapshot.candidate.id);
      if (!financial) continue;
      currency(financial.currency).estimatedPipelineMinor +=
        financial.expectedRevenueMinor;
    }
    const stableMonetaryOutcomes = new Map<string, (typeof outcomes)[number]>();
    for (const outcome of outcomes.filter((item) =>
      item.eventType === "quoted" || item.eventType === "won")) {
      const key = `${outcome.candidateId}\u001f${outcome.eventType}`;
      const previous = stableMonetaryOutcomes.get(key);
      if (!previous
        || outcome.occurredAt.localeCompare(previous.occurredAt) > 0
        || (outcome.occurredAt === previous.occurredAt
          && outcome.id.localeCompare(previous.id) > 0)) {
        stableMonetaryOutcomes.set(key, outcome);
      }
    }
    for (const outcome of stableMonetaryOutcomes.values()) {
      const amount = moneyValue(outcome.amount);
      if (!amount) continue;
      if (outcome.eventType === "quoted") {
        currency(amount.currency).quotedMinor += amount.amountMinor;
      }
      if (outcome.eventType === "won") {
        currency(amount.currency).wonContractMinor += amount.amountMinor;
      }
    }
    const valuesByCurrency = [...byCurrency.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currencyCode, values]) => ({
        currency: currencyCode,
        ...values
      }));
    const costByCurrency = new Map<string, number>();
    for (const { run } of selectedRuns) {
      if (!inWindow(run.createdAt, query.from, query.to)) continue;
      const code = run.billingCurrency.toUpperCase();
      costByCurrency.set(
        code,
        (costByCurrency.get(code) ?? 0) + run.consumedBudget.amountMinor
      );
    }
    const costEntries = [...costByCurrency.entries()];
    const cost: AcquisitionPerformanceDto["cost"] = costEntries.length <= 1
      ? {
          status: "available",
          executionCostMinor: costEntries[0]?.[1] ?? 0,
          currency: costEntries[0]?.[0] ?? "CNY",
          coverage: "recorded_api_execution_only"
        }
      : {
          status: "not_aggregatable",
          executionCostMinor: null,
          currency: null,
          coverage: "recorded_api_execution_only"
        };
    const missingFinancial = scopedSnapshots.filter((snapshot) =>
      !financialByCandidate.get(snapshot.candidate.id)).length;
    const missingAttribution = this.#diagnostics.filter((item) =>
      item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
      && ["attribution_missing", "attribution_invalid", "attribution_cross_tenant"]
        .includes(item.code)
      && inWindow(item.occurredAt, query.from, query.to)).length;
    const boundedEvidenceRefs = (refs: string[]) => {
      const unique = [...new Set(refs)];
      if (unique.length > this.#limits.evidenceRefs) truncated = true;
      return unique.slice(0, this.#limits.evidenceRefs);
    };
    const headlineRefs = boundedEvidenceRefs(discoveryEvents
      .filter((event) => boundedCandidateIds.has(String(event.data.candidateId)))
      .map((event) => event.id));
    const previousCandidates = new Set(previousDiscoveryEvents.map((event) =>
      String(event.data.candidateId)));
    const discoveredDelta = counts.discovered - previousCandidates.size;
    const signedDelta = discoveredDelta > 0
      ? `+${discoveredDelta}`
      : String(discoveredDelta);
    const headlines = [
      fact(
        "funnel.discovered",
        `本期发现 ${counts.discovered} 个去重候选，高意向 ${counts.highIntent} 个。`,
        headlineRefs
      ),
      fact(
        "funnel.discovered.delta",
        `本期去重候选较前一可比窗口变化 ${signedDelta}（前期 ${previousCandidates.size}，本期 ${counts.discovered}）。`,
        boundedEvidenceRefs([
          ...headlineRefs,
          ...previousDiscoveryEvents.map((event) => event.id)
        ])
      ),
      fact(
        "funnel.won",
        `本期成交 ${counts.won} 个候选；金额仅表示成交合同额。`,
        boundedEvidenceRefs(outcomes
          .filter((item) => item.eventType === "won")
          .map((item) => item.id))
      )
    ];
    const risks = [
      fact(
        "data.missing_attribution",
        `缺失或无效获客归因 ${missingAttribution} 条。`,
        boundedEvidenceRefs(this.#diagnostics.filter((item) =>
          item.ownerId === scope.ownerId && item.teamId === scope.teamId)
          .map((item) => item.id))
      ),
      fact(
        "roi.status",
        "缺少完整渠道成本、财务核销或可验证毛利，ROI 暂不可计算。",
        boundedEvidenceRefs(selectedRuns.map(({ run }) => run.id))
      )
    ];
    const actions = [
      fact(
        "action.follow_up_converted",
        `优先检查 ${Math.max(0, converted - contacted)} 个尚无联系结果的已转 CRM 候选。`,
        boundedEvidenceRefs(candidateIds)
      )
    ];
    return {
      counts,
      rates,
      valuesByCurrency,
      cost,
      roi: {
        status: "not_computable",
        reason: "channel_cost_or_verified_margin_unavailable"
      },
      dataQuality: {
        missingAttribution,
        missingFinancial,
        truncated,
        lastReconciledAt
      },
      briefingFacts: {
        headlines,
        risks,
        actions,
        metricIds: [...new Set([
          ...headlines,
          ...risks,
          ...actions
        ].map((item) => item.metricId))]
      }
    };
  }
}
