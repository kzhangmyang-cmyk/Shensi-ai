import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAdvisorRecommendationRepository
} from "./advisor-recommendation-repository.js";
import {
  DefaultAdvisorRecommendationExpirySweeper
} from "./advisor-recommendation-expiry-sweeper.js";
import {
  recommendationFixture
} from "./advisor-recommendation-domain-test.js";
import { canonicalGrowthRequestHash } from "./growth-http-idempotency-repository.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const workspace: ActiveWorkspaceContext = Object.freeze({
  workspaceId: "ws-1",
  kind: "team",
  actorId: "advisor-expiry-sweeper",
  role: "manager",
  teamId: "ws-1",
  capabilities: Object.freeze(["roi.close"]),
  capabilityRegistryVersion: "growth-capabilities.v1"
});

test("expiry sweeper transitions each due recommendation exactly once", async () => {
  const repository = new InMemoryAdvisorRecommendationRepository([
    recommendationFixture({
      id: "due-1",
      workspaceId: "ws-1",
      expiresAt: "2026-08-09T07:59:00.000Z"
    })
  ], {
    now: "2026-08-09T08:00:00.000Z"
  });
  const sweeper = new DefaultAdvisorRecommendationExpirySweeper({
    repository,
    now: () => Date.parse("2026-08-09T08:00:00.000Z"),
    onError: () => undefined,
    command(input: {
      workspaceId: string;
      actorId: string;
      idempotencyKey: string;
      requestHash: string;
    }): CommandContext {
      return Object.freeze({
        workspace,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
        requestHash: canonicalGrowthRequestHash(input.requestHash),
        expectedRevision: null
      });
    }
  });
  await Promise.all([sweeper.sweep(), sweeper.sweep()]);
  assert.equal(
    (await repository.findById(workspace, "due-1"))?.status,
    "expired"
  );
  assert.equal(
    repository.eventsFor("due-1")
      .filter((event) => event.eventType === "expire").length,
    1
  );
  await sweeper.close();
});

test("expiry sweeper skips recommendations with a blocking operation", async () => {
  const repository = new InMemoryAdvisorRecommendationRepository([
    recommendationFixture({
      id: "blocked-1",
      workspaceId: "ws-1",
      expiresAt: "2026-08-09T07:59:00.000Z"
    })
  ], {
    now: "2026-08-09T08:00:00.000Z",
    blocking: {
      async hasBlockingOperation() {
        return true;
      }
    }
  });
  const sweeper = new DefaultAdvisorRecommendationExpirySweeper({
    repository,
    now: () => Date.parse("2026-08-09T08:00:00.000Z"),
    onError: () => undefined,
    command(input: {
      workspaceId: string;
      actorId: string;
      idempotencyKey: string;
      requestHash: string;
    }): CommandContext {
      return Object.freeze({
        workspace,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
        requestHash: canonicalGrowthRequestHash(input.requestHash),
        expectedRevision: null
      });
    }
  });
  await sweeper.sweep();
  assert.equal(
    (await repository.findById(workspace, "blocked-1"))?.status,
    "proposed"
  );
  await sweeper.close();
});
