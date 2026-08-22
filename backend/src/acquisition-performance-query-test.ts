import assert from "node:assert/strict";
import test from "node:test";
import {
  AcquisitionPerformanceQueryService
} from "./acquisition-performance-query.js";

const scope = { ownerId: "owner-a", teamId: "team-a" };

function fixture() {
  const runs = [{
    id: "run-a",
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    planVersionId: "version-a",
    billingCurrency: "CNY",
    consumedBudget: {
      requests: 2,
      results: 3,
      amountMinor: 300,
      durationSeconds: 10
    },
    createdAt: "2026-08-01T00:00:00.000Z"
  }];
  const candidateIds = ["candidate-a", "candidate-b", "candidate-c"];
  const candidates = [
    {
      candidate: {
        id: "candidate-a",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        status: "converted_to_lead",
        approvedDecisionVersion: "decision-v1"
      },
      qualification: {
        grade: "A",
        createdAt: "2026-08-01T12:00:00.000Z"
      },
      financial: { currency: "USD", expectedRevenueMinor: 12_000 },
      sourcePlatforms: ["douyin"]
    },
    {
      candidate: {
        id: "candidate-b",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        status: "approved",
        approvedDecisionVersion: "decision-v1"
      },
      qualification: {
        grade: "C",
        createdAt: "2026-08-02T12:00:00.000Z"
      },
      financial: { currency: "CNY", expectedRevenueMinor: 50_000 },
      sourcePlatforms: ["douyin"]
    },
    {
      candidate: {
        id: "candidate-c",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        status: "discovered",
        approvedDecisionVersion: null
      },
      qualification: null,
      financial: null,
      sourcePlatforms: ["douyin"]
    }
  ];
  const outcomes = new Map<string, Array<Record<string, unknown>>>([
    ["candidate-a", [{
      id: "outcome-contacted",
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      candidateId: "candidate-a",
      eventType: "contacted",
      occurredAt: "2026-08-02T00:00:00.000Z",
      attribution: { runId: "run-a" },
      amount: null
    }, {
      id: "outcome-quoted",
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      candidateId: "candidate-a",
      eventType: "quoted",
      occurredAt: "2026-08-03T00:00:00.000Z",
      attribution: { runId: "run-a" },
      amount: { amountMinor: 10_000, currency: "USD" }
    }, {
      id: "outcome-won",
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      candidateId: "candidate-a",
      eventType: "won",
      occurredAt: "2026-08-04T00:00:00.000Z",
      attribution: { runId: "run-a" },
      amount: { amountMinor: 9_000, currency: "USD" }
    }, {
      id: "outcome-quoted-duplicate",
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      candidateId: "candidate-a",
      eventType: "quoted",
      occurredAt: "2026-08-03T01:00:00.000Z",
      attribution: { runId: "run-a" },
      amount: { amountMinor: 10_000, currency: "USD" }
    }]],
    ["candidate-b", [{
      id: "outcome-lost",
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      candidateId: "candidate-b",
      eventType: "lost",
      occurredAt: "2026-08-05T00:00:00.000Z",
      attribution: { runId: "run-a" },
      amount: null
    }]]
  ]);
  return new AcquisitionPerformanceQueryService({
    planRuns: {
      async listRuns() { return runs; },
      async listRunEvents() {
        return [...candidateIds.map((candidateId, index) => ({
          id: `event-${index}`,
          runId: "run-a",
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          type: "candidate.discovered",
          at: `2026-08-0${index + 1}T01:00:00.000Z`,
          data: { candidateId }
        })), {
          id: "event-prior",
          runId: "run-a",
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          type: "candidate.discovered",
          at: "2026-07-30T01:00:00.000Z",
          data: { candidateId: "candidate-prior" }
        }];
      }
    } as never,
    domain: {
      async getPresentationCandidateSnapshots(
        _scope: unknown,
        ids: string[]
      ) {
        assert.deepEqual(ids.sort(), candidateIds);
        return candidates;
      },
      async listOutcomes(_scope: unknown, candidateId: string) {
        return outcomes.get(candidateId) ?? [];
      },
      async listQualificationDecisions(
        _scope: unknown,
        candidateId: string
      ) {
        const snapshot = candidates.find((item) =>
          item.candidate.id === candidateId);
        return snapshot?.qualification ? [{
          ...snapshot.qualification,
          id: `qualification-${candidateId}`,
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          candidateId
        }] : [];
      },
      async listFinancialValues(_scope: unknown, candidateId: string) {
        const snapshot = candidates.find((item) =>
          item.candidate.id === candidateId);
        return snapshot?.financial ? [{
          ...snapshot.financial,
          id: `financial-${candidateId}`,
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          candidateId,
          qualificationDecisionId: `qualification-${candidateId}`,
          createdAt: snapshot.qualification?.createdAt
        }] : [];
      },
      async listAuditEvents(_scope: unknown, candidateId: string) {
        const createdAt = candidateId === "candidate-a"
          ? "2026-08-02T12:00:00.000Z"
          : "2026-08-03T12:00:00.000Z";
        return candidateId === "candidate-c" ? [] : [{
          id: `audit-approved-${candidateId}`,
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          candidateId,
          toStatus: "approved",
          createdAt
        }, ...(candidateId === "candidate-a" ? [{
          id: "audit-converted-candidate-a",
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          candidateId,
          toStatus: "converted_to_lead",
          createdAt: "2026-08-03T13:00:00.000Z"
        }] : [])];
      }
    } as never,
    diagnostics: [],
    checkpoints: [{
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      updatedAt: "2026-08-07T08:00:00.000Z"
    }],
    reconcile: {
      async runOnce() {
        return { lastReconciledAt: "2026-08-07T08:00:00.000Z" };
      }
    }
  });
}

test("aggregates candidate-deduplicated funnel, currency-separated values and conservative ROI", async () => {
  const result = await fixture().get(scope, {
    platform: "douyin",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-07T23:59:59.999Z"
  });

  assert.deepEqual(result.counts, {
    discovered: 3,
    highIntent: 1,
    approved: 2,
    converted: 1,
    contacted: 1,
    quoted: 1,
    won: 1,
    lost: 1
  });
  assert.deepEqual(result.rates, {
    highIntentRate: 1 / 3,
    approvalRate: 2 / 3,
    crmConversionRate: 1 / 2,
    contactRate: 1,
    quoteRate: 1,
    winRate: 1
  });
  assert.deepEqual(result.valuesByCurrency, [{
    currency: "CNY",
    estimatedPipelineMinor: 50_000,
    quotedMinor: 0,
    wonContractMinor: 0
  }, {
    currency: "USD",
    estimatedPipelineMinor: 12_000,
    quotedMinor: 10_000,
    wonContractMinor: 9_000
  }]);
  assert.deepEqual(result.cost, {
    status: "available",
    executionCostMinor: 300,
    currency: "CNY",
    coverage: "recorded_api_execution_only"
  });
  assert.deepEqual(result.roi, {
    status: "not_computable",
    reason: "channel_cost_or_verified_margin_unavailable"
  });
  assert.equal(result.dataQuality.missingFinancial, 1);
  assert.equal(result.dataQuality.lastReconciledAt, "2026-08-07T08:00:00.000Z");
  assert.ok(result.briefingFacts.metricIds.includes("funnel.discovered"));
  const delta = result.briefingFacts.headlines.find((item) =>
    item.metricId === "funnel.discovered.delta");
  assert.match(delta?.text ?? "", /\+2/);
  assert.ok(delta?.evidenceRefs.includes("event-prior"));
  assert.ok(result.briefingFacts.headlines.every((item) => item.metricId));
  assert.equal(JSON.stringify(result).includes("payment"), false);
});

test("returns null for every zero-denominator rate", async () => {
  const service = new AcquisitionPerformanceQueryService({
    planRuns: {
      async listRuns() { return []; },
      async listRunEvents() { return []; }
    } as never,
    domain: {
      async getPresentationCandidateSnapshots() { return []; },
      async listOutcomes() { return []; },
      async listQualificationDecisions() { return []; },
      async listFinancialValues() { return []; },
      async listAuditEvents() { return []; }
    } as never,
    diagnostics: [],
    reconcile: { async runOnce() { return { lastReconciledAt: null }; } }
  });
  const result = await service.get(scope, {
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z"
  });
  assert.deepEqual(result.rates, {
    highIntentRate: null,
    approvalRate: null,
    crmConversionRate: null,
    contactRate: null,
    quoteRate: null,
    winRate: null
  });
});

test("performance reads never invoke CRM reconciliation or any write path", async () => {
  let reconciliationCalls = 0;
  const service = new AcquisitionPerformanceQueryService({
    planRuns: {
      async listRuns() { return []; },
      async listRunEvents() { return []; }
    } as never,
    domain: {
      async getPresentationCandidateSnapshots() { return []; },
      async listOutcomes() { return []; },
      async listQualificationDecisions() { return []; },
      async listFinancialValues() { return []; },
      async listAuditEvents() { return []; }
    } as never,
    diagnostics: [],
    reconcile: {
      async runOnce() {
        reconciliationCalls += 1;
        throw new Error("read path attempted a write");
      }
    }
  });

  await service.get(scope, {
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z"
  });

  assert.equal(reconciliationCalls, 0);
});

test("uses qualification, approval and conversion event time instead of current snapshot state", async () => {
  const service = new AcquisitionPerformanceQueryService({
    planRuns: {
      async listRuns() {
        return [{
          id: "run-history",
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          planVersionId: "version-history",
          billingCurrency: "CNY",
          consumedBudget: { amountMinor: 0 },
          createdAt: "2026-08-01T00:00:00.000Z"
        }];
      },
      async listRunEvents() {
        return [{
          id: "event-history",
          runId: "run-history",
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          type: "candidate.discovered",
          at: "2026-08-01T01:00:00.000Z",
          data: { candidateId: "candidate-history" }
        }, {
          id: "event-requalified",
          runId: "run-history",
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          type: "candidate.discovered",
          at: "2026-08-01T02:00:00.000Z",
          data: { candidateId: "candidate-requalified" }
        }];
      }
    } as never,
    domain: {
      async getPresentationCandidateSnapshots() {
        return [{
          candidate: {
            id: "candidate-history",
            ownerId: scope.ownerId,
            teamId: scope.teamId,
            status: "converted_to_lead"
          },
          qualification: {
            grade: "A",
            createdAt: "2026-08-10T00:00:00.000Z"
          },
          financial: { currency: "USD", expectedRevenueMinor: 50_000 }
        }, {
          candidate: {
            id: "candidate-requalified",
            ownerId: scope.ownerId,
            teamId: scope.teamId,
            status: "discovered"
          },
          qualification: {
            grade: "C",
            createdAt: "2026-08-10T00:00:00.000Z"
          },
          financial: null
        }];
      },
      async listOutcomes() { return []; },
      async listQualificationDecisions(
        _scope: unknown,
        candidateId: string
      ) {
        if (candidateId === "candidate-requalified") {
          return [{
            id: "qualification-requalified-a",
            ownerId: scope.ownerId,
            teamId: scope.teamId,
            candidateId,
            grade: "A",
            createdAt: "2026-08-02T00:00:00.000Z"
          }, {
            id: "qualification-requalified-c",
            ownerId: scope.ownerId,
            teamId: scope.teamId,
            candidateId,
            grade: "C",
            createdAt: "2026-08-10T00:00:00.000Z"
          }];
        }
        return [{
          id: "qualification-history-late",
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          candidateId,
          grade: "A",
          createdAt: "2026-08-10T00:00:00.000Z"
        }];
      },
      async listFinancialValues() { return []; },
      async listAuditEvents() {
        return [{
          id: "audit-late-approved",
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          candidateId: "candidate-history",
          toStatus: "approved",
          createdAt: "2026-08-10T01:00:00.000Z"
        }, {
          id: "audit-late-converted",
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          candidateId: "candidate-history",
          toStatus: "converted_to_lead",
          createdAt: "2026-08-10T02:00:00.000Z"
        }];
      }
    } as never,
    diagnostics: []
  });

  const result = await service.get(scope, {
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-07T23:59:59.999Z"
  });

  assert.deepEqual(result.counts, {
    discovered: 2,
    highIntent: 1,
    approved: 0,
    converted: 0,
    contacted: 0,
    quoted: 0,
    won: 0,
    lost: 0
  });
  assert.deepEqual(result.valuesByCurrency, []);
});

test("uses Financial history tied to the qualification selected inside the window", async () => {
  const service = new AcquisitionPerformanceQueryService({
    planRuns: {
      async listRuns() { return [{
        id: "run-history-financial",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        planVersionId: "version-history-financial",
        billingCurrency: "CNY",
        consumedBudget: { amountMinor: 0 },
        createdAt: "2026-08-01T00:00:00.000Z"
      }]; },
      async listRunEvents() { return [{
        id: "event-history-financial",
        runId: "run-history-financial",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        type: "candidate.discovered",
        at: "2026-08-01T01:00:00.000Z",
        data: { candidateId: "candidate-history-financial" }
      }]; }
    } as never,
    domain: {
      async getPresentationCandidateSnapshots() { return [{
        candidate: {
          id: "candidate-history-financial",
          ownerId: scope.ownerId,
          teamId: scope.teamId
        },
        qualification: { id: "qualification-future", grade: "A" },
        financial: { currency: "CNY", expectedRevenueMinor: 999_999 }
      }]; },
      async listQualificationDecisions() { return [{
        id: "qualification-window",
        candidateId: "candidate-history-financial",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        grade: "A",
        createdAt: "2026-08-02T00:00:00.000Z"
      }, {
        id: "qualification-future",
        candidateId: "candidate-history-financial",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        grade: "A",
        createdAt: "2026-08-10T00:00:00.000Z"
      }]; },
      async listFinancialValues() { return [{
        id: "financial-window",
        candidateId: "candidate-history-financial",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        qualificationDecisionId: "qualification-window",
        currency: "USD",
        expectedRevenueMinor: 12_345,
        createdAt: "2026-08-02T00:01:00.000Z"
      }, {
        id: "financial-future",
        candidateId: "candidate-history-financial",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        qualificationDecisionId: "qualification-future",
        currency: "CNY",
        expectedRevenueMinor: 999_999,
        createdAt: "2026-08-10T00:01:00.000Z"
      }]; },
      async listOutcomes() { return []; },
      async listAuditEvents() { return []; }
    } as never,
    diagnostics: []
  });

  const result = await service.get(scope, {
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-07T23:59:59.999Z"
  });
  assert.deepEqual(result.valuesByCurrency, [{
    currency: "USD",
    estimatedPipelineMinor: 12_345,
    quotedMinor: 0,
    wonContractMinor: 0
  }]);
});

test("platform filtering follows immutable Outcome run attribution", async () => {
  const service = new AcquisitionPerformanceQueryService({
    planRuns: {
      async listRuns(_scope: unknown, query?: {
        targetPlatform?: "douyin" | "web";
        limit: number;
      }) {
        return ["douyin", "web"]
          .filter((platform) =>
            !query?.targetPlatform || platform === query.targetPlatform)
          .slice(0, query?.limit)
          .map((platform) => ({
            id: `run-${platform}`,
            ownerId: scope.ownerId,
            teamId: scope.teamId,
            planVersionId: `version-${platform}`,
            billingCurrency: "CNY",
            consumedBudget: { amountMinor: 0 },
            createdAt: "2026-08-01T00:00:00.000Z"
          }));
      },
      async listRunEvents(runId: string) { return [{
        id: `event-${runId}`,
        runId,
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        type: "candidate.discovered",
        at: "2026-08-01T01:00:00.000Z",
        data: { candidateId: "candidate-shared" }
      }]; }
    } as never,
    domain: {
      async getPresentationCandidateSnapshots() { return [{
        candidate: {
          id: "candidate-shared",
          ownerId: scope.ownerId,
          teamId: scope.teamId
        },
        qualification: null,
        financial: null
      }]; },
      async listQualificationDecisions() { return []; },
      async listFinancialValues() { return []; },
      async listOutcomes() { return [{
        id: "outcome-web-won",
        candidateId: "candidate-shared",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        eventType: "won",
        occurredAt: "2026-08-03T00:00:00.000Z",
        attribution: { runId: "run-web" },
        amount: { currency: "CNY", amountMinor: 88_800 }
      }]; },
      async listAuditEvents() { return []; }
    } as never,
    diagnostics: []
  });
  const result = await service.get(scope, {
    platform: "douyin",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-07T23:59:59.999Z"
  });
  assert.equal(result.counts.won, 0);
  assert.deepEqual(result.valuesByCurrency, []);
});

test("caps deterministic candidates before per-candidate fan-out and reports truncation", async () => {
  const calls: string[] = [];
  const service = new AcquisitionPerformanceQueryService({
    limits: { candidates: 1 },
    planRuns: {
      async listRuns() { return [{
        id: "run-bounded",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        planVersionId: "version-bounded",
        billingCurrency: "CNY",
        consumedBudget: { amountMinor: 0 },
        createdAt: "2026-08-01T00:00:00.000Z"
      }]; },
      async listRunEvents() { return ["candidate-b", "candidate-a"].map((candidateId) => ({
        id: `event-${candidateId}`,
        runId: "run-bounded",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        type: "candidate.discovered",
        at: "2026-08-01T01:00:00.000Z",
        data: { candidateId }
      })); }
    } as never,
    domain: {
      async getPresentationCandidateSnapshots(_scope: unknown, ids: string[]) {
        assert.deepEqual(ids, ["candidate-a"]);
        return ids.map((id) => ({ candidate: {
          id,
          ownerId: scope.ownerId,
          teamId: scope.teamId
        }, qualification: null, financial: null }));
      },
      async listQualificationDecisions(_scope: unknown, id: string) {
        calls.push(`qualification:${id}`); return [];
      },
      async listFinancialValues(_scope: unknown, id: string) {
        calls.push(`financial:${id}`); return [];
      },
      async listOutcomes(_scope: unknown, id: string) {
        calls.push(`outcomes:${id}`); return [];
      },
      async listAuditEvents(_scope: unknown, id: string) {
        calls.push(`audit:${id}`); return [];
      }
    } as never,
    diagnostics: []
  } as never);
  const result = await service.get(scope, {
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-07T23:59:59.999Z"
  });
  assert.deepEqual(calls.sort(), [
    "audit:candidate-a",
    "financial:candidate-a",
    "outcomes:candidate-a",
    "qualification:candidate-a"
  ]);
  assert.equal(result.dataQuality.truncated, true);
});

test("historical windows are not evicted by newer runs outside the requested windows", async () => {
  const service = new AcquisitionPerformanceQueryService({
    limits: { runs: 1 },
    planRuns: {
      async listRuns(_scope: unknown, query?: {
        createdAtOnOrBefore: string;
        limit: number;
      }) {
        return [{
          id: "run-future",
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          planVersionId: "version-future",
          billingCurrency: "CNY",
          consumedBudget: { amountMinor: 0 },
          createdAt: "2026-08-20T00:00:00.000Z"
        }, {
          id: "run-historical",
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          planVersionId: "version-historical",
          billingCurrency: "CNY",
          consumedBudget: { amountMinor: 0 },
          createdAt: "2026-07-01T00:00:00.000Z"
        }]
          .filter((run) =>
            run.createdAt <= (query?.createdAtOnOrBefore ?? run.createdAt))
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt)
            || right.id.localeCompare(left.id))
          .slice(0, query?.limit);
      },
      async listRunEvents(runId: string) {
        return runId === "run-historical" ? [{
          id: "event-historical",
          runId,
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          type: "candidate.discovered",
          at: "2026-08-01T01:00:00.000Z",
          data: { candidateId: "candidate-historical" }
        }] : [];
      }
    } as never,
    domain: {
      async getPresentationCandidateSnapshots() { return [{
        candidate: {
          id: "candidate-historical",
          ownerId: scope.ownerId,
          teamId: scope.teamId
        },
        qualification: null,
        financial: null
      }]; },
      async listQualificationDecisions() { return []; },
      async listFinancialValues() { return []; },
      async listOutcomes() { return []; },
      async listAuditEvents() { return []; }
    } as never,
    diagnostics: []
  });

  const result = await service.get(scope, {
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-07T23:59:59.999Z"
  });

  assert.equal(result.counts.discovered, 1);
  assert.equal(result.dataQuality.truncated, false);
});

test("filters platform before applying the run cap", async () => {
  const eventReads: string[] = [];
  const webRuns = Array.from({ length: 100 }, (_, index) => ({
    id: `run-web-${String(index).padStart(3, "0")}`,
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    planVersionId: `version-web-${String(index).padStart(3, "0")}`,
    billingCurrency: "CNY",
    consumedBudget: { amountMinor: 0 },
    createdAt: `2026-08-07T${String(23 - Math.floor(index / 5)).padStart(2, "0")}:${String((index % 5) * 10).padStart(2, "0")}:00.000Z`
  }));
  const douyinRun = {
    id: "run-douyin-older",
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    planVersionId: "version-douyin-older",
    billingCurrency: "CNY",
    consumedBudget: { amountMinor: 0 },
    createdAt: "2026-08-01T00:00:00.000Z"
  };
  const service = new AcquisitionPerformanceQueryService({
    limits: { runs: 100 },
    planRuns: {
      async listRuns(_scope: unknown, query?: {
        targetPlatform?: "douyin" | "web";
        limit: number;
      }) {
        const matching = query?.targetPlatform === "douyin"
          ? [douyinRun]
          : [...webRuns, douyinRun];
        return matching.slice(0, query?.limit);
      },
      async listRunEvents(runId: string) {
        eventReads.push(runId);
        return runId === douyinRun.id ? [{
          id: "event-douyin-older",
          runId,
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          type: "candidate.discovered",
          at: "2026-08-02T01:00:00.000Z",
          data: { candidateId: "candidate-douyin-older" }
        }] : [];
      }
    } as never,
    domain: {
      async getPresentationCandidateSnapshots() { return [{
        candidate: {
          id: "candidate-douyin-older",
          ownerId: scope.ownerId,
          teamId: scope.teamId
        },
        qualification: null,
        financial: null
      }]; },
      async listQualificationDecisions() { return []; },
      async listFinancialValues() { return []; },
      async listOutcomes() { return []; },
      async listAuditEvents() { return []; }
    } as never,
    diagnostics: []
  });

  const result = await service.get(scope, {
    platform: "douyin",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-07T23:59:59.999Z"
  });

  assert.equal(result.counts.discovered, 1);
  assert.equal(result.dataQuality.truncated, false);
  assert.deepEqual(eventReads, ["run-douyin-older"]);
});

test("pushes an empty platform result into one bounded run query", async () => {
  const runs = Array.from({ length: 1_000 }, (_, index) => ({
    id: `run-web-only-${String(index).padStart(4, "0")}`,
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    planVersionId: `version-web-only-${String(index).padStart(4, "0")}`,
    billingCurrency: "CNY",
    consumedBudget: { amountMinor: 0 },
    createdAt: "2026-08-07T23:00:00.000Z"
  }));
  let versionReads = 0;
  let receivedQuery: unknown;
  const service = new AcquisitionPerformanceQueryService({
    limits: { runs: 2 },
    planRuns: {
      async listRuns(_scope: unknown, query?: {
        targetPlatform?: string;
      }) {
        receivedQuery = query;
        return query?.targetPlatform === "douyin" ? [] : runs;
      },
      async getPlanVersion() {
        versionReads += 1;
        return { payload: { targetPlatform: "web" } };
      },
      async listRunEvents() { return []; }
    } as never,
    domain: {
      async getPresentationCandidateSnapshots() { return []; },
      async listQualificationDecisions() { return []; },
      async listFinancialValues() { return []; },
      async listOutcomes() { return []; },
      async listAuditEvents() { return []; }
    } as never,
    diagnostics: []
  });

  const result = await service.get(scope, {
    platform: "douyin",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-07T23:59:59.999Z"
  });

  assert.equal(versionReads, 0);
  assert.deepEqual(receivedQuery, {
    targetPlatform: "douyin",
    createdAtOnOrBefore: "2026-08-07T23:59:59.999Z",
    orderBy: "created_at_desc",
    limit: 3
  });
  assert.equal(result.counts.discovered, 0);
  assert.equal(result.dataQuality.truncated, false);
});

test("requests the run cap plus one and truncates before event fan-out", async () => {
  let receivedQuery: unknown;
  const eventReads: string[] = [];
  const runs = Array.from({ length: 5 }, (_, index) => ({
    id: `run-bounded-${index}`,
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    planVersionId: `version-bounded-${index}`,
    billingCurrency: "CNY",
    consumedBudget: { amountMinor: 0 },
    createdAt: `2026-08-0${7 - index}T00:00:00.000Z`
  }));
  const service = new AcquisitionPerformanceQueryService({
    limits: { runs: 2 },
    planRuns: {
      async listRuns(_scope: unknown, query?: { limit: number }) {
        receivedQuery = query;
        return runs.slice(0, query?.limit);
      },
      async listRunEvents(runId: string) {
        eventReads.push(runId);
        return [];
      }
    } as never,
    domain: {
      async getPresentationCandidateSnapshots() { return []; },
      async listQualificationDecisions() { return []; },
      async listFinancialValues() { return []; },
      async listOutcomes() { return []; },
      async listAuditEvents() { return []; }
    } as never,
    diagnostics: []
  });

  const result = await service.get(scope, {
    platform: "douyin",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-07T23:59:59.999Z"
  });

  assert.deepEqual(receivedQuery, {
    targetPlatform: "douyin",
    createdAtOnOrBefore: "2026-08-07T23:59:59.999Z",
    orderBy: "created_at_desc",
    limit: 3
  });
  assert.deepEqual(eventReads, ["run-bounded-0", "run-bounded-1"]);
  assert.equal(result.dataQuality.truncated, true);
});

test("historical discovery events are not evicted by newer events outside the requested windows", async () => {
  const service = new AcquisitionPerformanceQueryService({
    limits: { eventsPerRun: 1 },
    planRuns: {
      async listRuns() { return [{
        id: "run-historical-events",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        planVersionId: "version-historical-events",
        billingCurrency: "CNY",
        consumedBudget: { amountMinor: 0 },
        createdAt: "2026-08-01T00:00:00.000Z"
      }]; },
      async listRunEvents() { return [{
        id: "event-future",
        runId: "run-historical-events",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        type: "candidate.discovered",
        at: "2026-08-20T01:00:00.000Z",
        data: { candidateId: "candidate-future" }
      }, {
        id: "event-historical",
        runId: "run-historical-events",
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        type: "candidate.discovered",
        at: "2026-08-01T01:00:00.000Z",
        data: { candidateId: "candidate-historical" }
      }]; }
    } as never,
    domain: {
      async getPresentationCandidateSnapshots() { return [{
        candidate: {
          id: "candidate-historical",
          ownerId: scope.ownerId,
          teamId: scope.teamId
        },
        qualification: null,
        financial: null
      }]; },
      async listQualificationDecisions() { return []; },
      async listFinancialValues() { return []; },
      async listOutcomes() { return []; },
      async listAuditEvents() { return []; }
    } as never,
    diagnostics: []
  });

  const result = await service.get(scope, {
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-07T23:59:59.999Z"
  });

  assert.equal(result.counts.discovered, 1);
  assert.equal(result.dataQuality.truncated, false);
});
