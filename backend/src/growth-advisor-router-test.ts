import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  createGrowthAdvisorRouter,
  type GrowthAdvisorRouterDependencies
} from "./growth-advisor-router.js";
import type {
  GrowthAdvisorQueryService,
  GrowthAdvisorTodayView
} from "./growth-advisor-query.js";
import {
  InMemoryGrowthHttpIdempotencyRepository
} from "./growth-http-idempotency-repository.js";
import {
  commandContextFromRequest
} from "./growth-http-preconditions.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { AdvisorRecommendation } from "./advisor-recommendation-domain.js";

const workspace: ActiveWorkspaceContext = Object.freeze({
  workspaceId: "ws-1",
  kind: "team",
  actorId: "manager-1",
  role: "manager",
  teamId: "ws-1",
  capabilities: Object.freeze(["catalog.read"]),
  capabilityRegistryVersion: "growth-capabilities.v1"
});

function todayView(): GrowthAdvisorTodayView {
  return Object.freeze({
    workspaceId: "ws-1",
    audienceRole: "manager",
    dataAsOf: "2026-08-09T08:00:00.000Z",
    priorityCustomers: Object.freeze([]),
    pendingQuoteApprovals: Object.freeze([]),
    expectedRoi: Object.freeze([]),
    actualRoi: Object.freeze([]),
    dataGaps: Object.freeze([]),
    recommendations: Object.freeze([]),
    sourceSnapshotHash: `sha256:${"a".repeat(64)}`
  });
}

function recommendationProjection(
  overrides: Partial<AdvisorRecommendation> = {}
): AdvisorRecommendation {
  return {
    id: "recommendation-1",
    workspaceId: "ws-1",
    revision: 1,
    audienceRole: "manager",
    type: "data_gap",
    summary: "summary",
    rationale: "rationale",
    metricRefs: [],
    evidenceRefs: [],
    entityRefs: [],
    confidenceBps: 8000,
    riskLevel: "medium",
    recommendedAction: { kind: "complete_cost_data", cohortId: "cohort-1" },
    status: "proposed",
    assignedTo: null,
    acceptedBy: null,
    acceptedAt: null,
    outcomeRefs: [],
    dataAsOf: "2026-08-09T08:00:00.000Z",
    inputSnapshotHash: `sha256:${"b".repeat(64)}`,
    modelSnapshotRef: "model-1",
    promptVersion: "growth-advisor.v1",
    schemaVersion: "advisor-recommendation.v1",
    generationIdempotencyKey: "generation-1",
    expiresAt: "2026-08-10T08:00:00.000Z",
    createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-09T08:00:00.000Z",
    ...overrides
  };
}

async function serve(
  handler: express.RequestHandler
): Promise<{ request(path: string, init?: RequestInit): Promise<{
  response: Response;
  json: () => Promise<unknown>;
}>; close(): Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.activeWorkspace = workspace;
    next();
  });
  app.use("/api/v1/acquisition/advisor", handler);
  app.use((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const status = (error as { status?: number }).status ?? 500;
    const code = (error as { code?: string }).code
      ?? "GROWTH_INTERNAL_ERROR";
    res.status(status).json({ code, message: error instanceof Error
      ? error.message : String(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    async request(path, init) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
      return { response, json: () => response.json() };
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function createRouterFixture() {
  const todayCalls: string[] = [];
  const today: GrowthAdvisorQueryService = {
    async getToday(_context, query) {
      todayCalls.push(query.asOf);
      return todayView();
    }
  };
  const acceptedIds: string[] = [];
  const recommendations = {
    async accept() {
      acceptedIds.push("accept");
    },
    async ignore() {},
    async complete() {},
    async getProjection() {
      return recommendationProjection();
    }
  } as never;
  const deps: GrowthAdvisorRouterDependencies = {
    today,
    recommendations,
    workspaceContext: (() => workspace) as never,
    commandContextFactory: commandContextFromRequest,
    httpIdempotency: new InMemoryGrowthHttpIdempotencyRepository(),
    now: () => "2026-08-09T09:00:00.000Z"
  };
  const server = await serve(createGrowthAdvisorRouter(deps));
  return { server, todayCalls, acceptedIds };
}

test("today returns the server-derived view and hides nothing", async () => {
  const fixture = await createRouterFixture();
  try {
    const { response, json } = await fixture.server.request(
      "/api/v1/acquisition/advisor/today?currency=CNY&asOf=2026-08-09T08:00:00.000Z"
    );
    assert.equal(response.status, 200);
    const body = await json() as { sourceSnapshotHash?: string };
    assert.equal(body.sourceSnapshotHash, `sha256:${"a".repeat(64)}`);
    assert.deepEqual(fixture.todayCalls, ["2026-08-09T08:00:00.000Z"]);
  } finally {
    await fixture.server.close();
  }
});

test("today rejects future asOf before any reader call", async () => {
  const fixture = await createRouterFixture();
  try {
    const { response, json } = await fixture.server.request(
      "/api/v1/acquisition/advisor/today?currency=CNY&asOf=2026-08-09T12:00:00.000Z"
    );
    assert.equal(response.status, 422);
    const body = await json() as { code?: string };
    assert.equal(body.code, "invalid_as_of");
    assert.deepEqual(fixture.todayCalls, []);
  } finally {
    await fixture.server.close();
  }
});

test("advisor commands require idempotency and revision", async () => {
  const fixture = await createRouterFixture();
  try {
    const missingKey = await fixture.server.request(
      "/api/v1/acquisition/advisor/recommendations/recommendation-1/accept",
      {
        method: "POST",
        headers: { "If-Match": "\"advisor-recommendation-v:1\"",
          "Content-Type": "application/json" },
        body: JSON.stringify({ reason: null })
      }
    );
    assert.equal(missingKey.response.status, 400);
    const missingRevision = await fixture.server.request(
      "/api/v1/acquisition/advisor/recommendations/recommendation-1/accept",
      {
        method: "POST",
        headers: { "Idempotency-Key": "accept-1",
          "Content-Type": "application/json" },
        body: JSON.stringify({ reason: null })
      }
    );
    assert.equal(missingRevision.response.status, 428);
    const body = await missingRevision.json() as { code?: string };
    assert.equal(body.code, "revision_required");
  } finally {
    await fixture.server.close();
  }
});

test("accept succeeds with a valid command", async () => {
  const fixture = await createRouterFixture();
  try {
    const { response, json } = await fixture.server.request(
      "/api/v1/acquisition/advisor/recommendations/recommendation-1/accept",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "accept-valid",
          "If-Match": "\"advisor-recommendation-v:1\"",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ reason: null })
      }
    );
    assert.equal(response.status, 200);
    const body = await json() as { id?: string };
    assert.equal(body.id, "recommendation-1");
    assert.deepEqual(fixture.acceptedIds, ["accept"]);
  } finally {
    await fixture.server.close();
  }
});

test("one key cannot replay a recommendation command for another path id", async () => {
  const fixture = await createRouterFixture();
  try {
    const first = await fixture.server.request(
      "/api/v1/acquisition/advisor/recommendations/recommendation-a/accept",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "accept-shared",
          "If-Match": "\"advisor-recommendation-v:1\"",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ reason: null })
      }
    );
    assert.equal(first.response.status, 200);
    const second = await fixture.server.request(
      "/api/v1/acquisition/advisor/recommendations/recommendation-b/accept",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "accept-shared",
          "If-Match": "\"advisor-recommendation-v:1\"",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ reason: null })
      }
    );
    assert.equal(second.response.status, 409);
    const body = await second.json() as { code?: string };
    assert.equal(body.code, "idempotency_conflict");
  } finally {
    await fixture.server.close();
  }
});

test("transition bodies reject extra and missing fields", async () => {
  const fixture = await createRouterFixture();
  try {
    const extra = await fixture.server.request(
      "/api/v1/acquisition/advisor/recommendations/recommendation-1/accept",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "accept-extra",
          "If-Match": "\"advisor-recommendation-v:1\"",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ reason: null, outcomeRefs: [] })
      }
    );
    assert.equal(extra.response.status, 400);
    const missing = await fixture.server.request(
      "/api/v1/acquisition/advisor/recommendations/recommendation-1/accept",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "accept-missing",
          "If-Match": "\"advisor-recommendation-v:1\"",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }
    );
    assert.equal(missing.response.status, 400);
  } finally {
    await fixture.server.close();
  }
});
