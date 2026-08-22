import assert from "node:assert/strict";
import test from "node:test";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import {
  DefaultAcquisitionGrowthPerformanceQueryService,
  type GrowthPerformanceDataSource
} from "./acquisition-growth-performance-query.js";
import {
  createAcquisitionGrowthPerformanceRouter
} from "./acquisition-growth-performance-router.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { workspaceContext } from "./growth-roi-test-fixtures.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

async function mountGrowthRoiRouters() {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T00:00:00.000Z"
  );
  const barrier = new DefaultGrowthTemporalBarrier(transactions);
  const workspace = workspaceContext("workspace-a");
  const source: GrowthPerformanceDataSource = {
    async listCohortMembersAsOf(_w, _c, _p, _cutoff) {
      return { rows: [], truncated: false };
    },
    async listCohortMemberSourcesAsOf() {
      return { rows: [], truncated: false };
    },
    async selectPublishedClosure(_w, _c, _currency, _cutoff) {
      return {
        closure: Object.freeze({
          id: "closure-1",
          workspaceId: "workspace-a",
          cohortId: "cohort-1",
          currency: _currency,
          version: 1,
          asOf: "2026-08-08T00:00:00.000Z",
          status: "closed",
          previousClosureVersionId: null,
          formulaVersion: "verified-gross-profit-roi.v1",
          membershipSnapshotHash: `sha256:${"a".repeat(64)}`,
          attestationSetHash: `sha256:${"b".repeat(64)}`,
          factSetHash: `sha256:${"c".repeat(64)}`,
          costSetHash: `sha256:${"d".repeat(64)}`,
          allocationSetHash: `sha256:${"e".repeat(64)}`,
          settlementSetHash: `sha256:${"f".repeat(64)}`,
          closedBy: "finance-a",
          closedAt: "2026-08-09T00:00:00.000Z"
        }),
        truncated: false
      };
    },
    async getExactPublishedClosure(_w, _c, _currency, id, _cutoff) {
      return id === "closure-1"
        ? await this.selectPublishedClosure(_w, _c, _currency, _cutoff)
        : null;
    },
    async readMaterializedSnapshot(_w, _id, _sliceKey) {
      return Object.freeze({
        closureVersionId: "closure-1",
        sliceKey: "all",
        planId: null,
        memberCount: 1,
        memberSetHash: `sha256:${"a".repeat(64)}`,
        computedMetrics: {
          status: "computed",
          verifiedGrossProfitMinor: 1000,
          verifiedAcquisitionCostMinor: 200,
          roiBps: 4000,
          formulaVersion: "verified-gross-profit-roi.v1"
        },
        commercialRatios: {
          verifiedContractWonMinor: 1000,
          allocatedPaymentMinor: 900,
          netCashMinor: 900,
          verifiedAcquisitionCostMinor: 200,
          contractRoas: {
            status: "computed",
            bps: 50_000,
            formulaVersion: "contract-roas.v1"
          },
          cashMultiple: {
            status: "computed",
            bps: 45_000,
            formulaVersion: "cash-multiple.v1"
          },
          collectionRate: {
            status: "computed",
            bps: 9_000,
            formulaVersion: "collection-rate.v1"
          }
        },
        commercialAuthoritySetHash: `sha256:${"a".repeat(64)}`,
        coverage: {
          costCoverageBps: 10000,
          marginCoverageBps: 10000,
          cashCoverageBps: 10000,
          attributionCoverageBps: 10000,
          gapCodes: []
        },
        calculationHash: `sha256:${"b".repeat(64)}`
      });
    }
  };
  const queryService = new DefaultAcquisitionGrowthPerformanceQueryService(
    source,
    {
      async listQuoteContributions() {
        return [];
      }
    }
  );
  const workspaceContextResolver = (): ActiveWorkspaceContext => workspace;
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.activeWorkspace = workspace;
    next();
  });
  app.use(createAcquisitionGrowthPerformanceRouter({
    queryService,
    workspaceContext: workspaceContextResolver,
    temporalBarrier: barrier,
    now: () => "2026-08-09T00:00:00.000Z"
  }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status : 500;
    const code = typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code : "internal_error";
    res.status(status).json({ code, message: code });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    async request(path: string) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { "X-Workspace-Id": "workspace-a" }
      });
      return { response, body: await response.json() };
    },
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
  };
}

test("growth performance publishes closure metadata with redaction-free projection", async () => {
  const app = await mountGrowthRoiRouters();
  try {
    const growth = await app.request(
      "/api/v1/acquisition/growth-performance"
      + "?cohortId=cohort-1&currency=CNY&asOf=2026-08-09T00%3A00%3A00.000Z"
    );
    assert.equal(growth.response.status, 200);
    assert.equal(growth.body.actualRoiByCurrency[0].status, "computed");
    assert.equal(
      growth.body.actualRoiByCurrency[0].closureVersionId,
      "closure-1"
    );
    assert.equal(
      growth.body.formulaVersion,
      "growth-performance.v1"
    );
    assert.equal(
      JSON.stringify(growth.body).includes("temporalSequence"),
      false
    );
    assert.equal(
      JSON.stringify(growth.body).includes("cutoffTemporalSequence"),
      false
    );
  } finally {
    await app.close();
  }
});

test("growth performance rejects a future asOf before any query work", async () => {
  const app = await mountGrowthRoiRouters();
  try {
    const query = await app.request(
      "/api/v1/acquisition/growth-performance"
      + "?cohortId=cohort-1&currency=CNY&asOf=2026-08-09T00%3A00%3A01.001Z"
    );
    assert.equal(query.response.status, 422);
    assert.equal(query.body.code, "invalid_as_of");
  } finally {
    await app.close();
  }
});
