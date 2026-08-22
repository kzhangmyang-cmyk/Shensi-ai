import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";
import {
  createAcquisitionPerformanceRouter
} from "./acquisition-performance-router.js";
import {
  normalizeShanghaiPerformanceWindow
} from "./acquisition-performance-window.js";

async function fixture() {
  const calls: unknown[] = [];
  const app = express();
  app.use((req, _res, next) => {
    if (req.header("x-owner")) {
      (req as any).user = {
        id: req.header("x-owner")!,
        teamId: req.header("x-team")!
      };
    }
    next();
  });
  app.use(createAcquisitionPerformanceRouter({
    query: {
      async get(scope, input) {
        calls.push({ scope, input });
        return {
          counts: { discovered: 0, highIntent: 0, approved: 0, converted: 0, contacted: 0, quoted: 0, won: 0, lost: 0 },
          rates: { highIntentRate: null, approvalRate: null, crmConversionRate: null, contactRate: null, quoteRate: null, winRate: null },
          valuesByCurrency: [],
          cost: { status: "available", executionCostMinor: 0, currency: "CNY", coverage: "recorded_api_execution_only" },
          roi: { status: "not_computable", reason: "channel_cost_or_verified_margin_unavailable" },
          dataQuality: { missingAttribution: 0, missingFinancial: 0, truncated: false, lastReconciledAt: null },
          briefingFacts: { headlines: [], risks: [], actions: [], metricIds: [] }
        };
      }
    },
    requestIdFactory: () => "request-performance"
  }));
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const request = async (path: string, authenticated = true, method = "GET") => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: authenticated ? { "x-owner": "owner-a", "x-team": "team-a" } : {}
    });
    return { response, body: await response.json().catch(() => null) };
  };
  return {
    calls,
    request,
    close: () => new Promise<void>((resolve, reject) => server.close(
      (error) => error ? reject(error) : resolve()
    ))
  };
}

test("serves the authenticated read-only performance endpoint", async () => {
  const app = await fixture();
  try {
    const result = await app.request(
      "/api/v1/acquisition/performance?platform=douyin&from=2026-08-02&to=2026-08-02"
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("x-request-id"), "request-performance");
    assert.equal(result.body.roi.status, "not_computable");
    assert.deepEqual(app.calls, [{
      scope: { ownerId: "owner-a", teamId: "team-a" },
      input: {
        platform: "douyin",
        from: "2026-08-01T16:00:00.000Z",
        to: "2026-08-02T15:59:59.999Z"
      }
    }]);
    assert.equal((await app.request(
      "/api/v1/acquisition/performance",
      true,
      "POST"
    )).response.status, 404);
  } finally {
    await app.close();
  }
});

test("rejects anonymous, invalid and over-90-day windows", async () => {
  const app = await fixture();
  try {
    assert.equal((await app.request(
      "/api/v1/acquisition/performance?from=2026-08-01&to=2026-08-07",
      false
    )).response.status, 401);
    assert.equal((await app.request(
      "/api/v1/acquisition/performance?from=2026-01-01&to=2026-08-07"
    )).response.status, 400);
    assert.equal((await app.request(
      "/api/v1/acquisition/performance?platform=unknown&from=2026-08-01&to=2026-08-07"
    )).response.status, 400);
    assert.equal((await app.request(
      "/api/v1/acquisition/performance?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-07"
    )).response.status, 400);
  } finally {
    await app.close();
  }
});

test("accepts at most 90 real Shanghai calendar days", async () => {
  const app = await fixture();
  try {
    const ninetyDays = await app.request(
      "/api/v1/acquisition/performance?from=2026-05-10&to=2026-08-07"
    );
    assert.equal(ninetyDays.response.status, 200);
    assert.deepEqual(app.calls.at(-1), {
      scope: { ownerId: "owner-a", teamId: "team-a" },
      input: {
        platform: undefined,
        from: "2026-05-09T16:00:00.000Z",
        to: "2026-08-07T15:59:59.999Z"
      }
    });

    const leapDay = await app.request(
      "/api/v1/acquisition/performance?from=2024-02-29&to=2024-02-29"
    );
    assert.equal(leapDay.response.status, 200);
    assert.deepEqual(app.calls.at(-1), {
      scope: { ownerId: "owner-a", teamId: "team-a" },
      input: {
        platform: undefined,
        from: "2024-02-28T16:00:00.000Z",
        to: "2024-02-29T15:59:59.999Z"
      }
    });
  } finally {
    await app.close();
  }
});

test("normalizes the shared Shanghai date-only contract", () => {
  assert.deepEqual(normalizeShanghaiPerformanceWindow({
    from: "2026-08-02",
    to: "2026-08-02"
  }), {
    ok: true,
    value: {
      fromInclusiveUtc: "2026-08-01T16:00:00.000Z",
      toInclusiveUtc: "2026-08-02T15:59:59.999Z"
    }
  });

  const cases = [
    [{ from: "2026-02-29", to: "2026-02-29" }, "from"],
    [{ from: "2026-02-28", to: "2026-02-30" }, "to"],
    [{ from: "2026-08-08", to: "2026-08-07" }, "from"],
    [{ from: "2026-05-09", to: "2026-08-07" }, "to"]
  ] as const;
  for (const [input, field] of cases) {
    const result = normalizeShanghaiPerformanceWindow(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.issue.field, field);
  }
});

test("rejects fake, reversed, timestamp and 91-day windows before querying", async () => {
  const app = await fixture();
  try {
    const invalidPaths = [
      "/api/v1/acquisition/performance?from=2026-02-29&to=2026-02-29",
      "/api/v1/acquisition/performance?from=2026-02-30&to=2026-02-30",
      "/api/v1/acquisition/performance?from=2026-13-01&to=2026-13-01",
      "/api/v1/acquisition/performance?from=2026-08-08&to=2026-08-07",
      "/api/v1/acquisition/performance?from=2026-05-09&to=2026-08-07",
      "/api/v1/acquisition/performance?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-07"
    ];
    for (const path of invalidPaths) {
      assert.equal((await app.request(path)).response.status, 400, path);
    }
    assert.equal(app.calls.length, 0);
  } finally {
    await app.close();
  }
});
