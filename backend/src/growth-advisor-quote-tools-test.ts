import assert from "node:assert/strict";
import test from "node:test";
import {
  GROWTH_QUOTE_TOOL_BLUEPRINTS,
  GrowthAdvisorQuoteToolExecutor,
  GrowthQuoteToolReplayProjector
} from "./growth-advisor-quote-tools.js";
import { createGrowthCommercialToolPorts } from "./growth-commercial-application.js";
import { workspaceContextFixture } from "./growth-quote-test-fixtures.js";

test("quote tools expose draft and approval-task actions but no authority mutation", () => {
  assert.deepEqual(GROWTH_QUOTE_TOOL_BLUEPRINTS.map((tool) => tool.name), [
    "list_catalog_items",
    "get_pricing_policy",
    "preview_quote",
    "create_quote_draft",
    "list_pending_quote_approvals",
    "get_quote_decision",
    "create_quote_approval_task"
  ]);
  const names = new Set(GROWTH_QUOTE_TOOL_BLUEPRINTS.map((tool) => tool.name));
  assert.equal(names.has("approve_quote" as never), false);
  assert.equal(names.has("send_quote" as never), false);
  assert.equal(names.has("mark_deal_won" as never), false);
});

test("focused ledger stores one authority envelope and reprojects every replay", async () => {
  let handlerCalls = 0;
  let projectorCalls = 0;
  let stored: unknown;
  const ports = createGrowthCommercialToolPorts();
  ports.register("get_quote_decision", async () => {
    handlerCalls += 1;
    return {
      quoteVersionId: "formal-2",
      status: "submitted",
      estimatedGrossProfitMinor: 280_000,
      commercialAmountHash: `sha256:${"c".repeat(64)}`,
      dataAsOf: "2026-08-09T08:30:00.000Z",
      temporalSequence: 7
    };
  });
  const projector = new class extends GrowthQuoteToolReplayProjector {
    override async authorizeAndProjectCached(context: any, envelope: any) {
      projectorCalls += 1;
      return super.authorizeAndProjectCached(context, envelope);
    }
  }();
  const executor = new GrowthAdvisorQuoteToolExecutor({
    toolPorts: ports,
    resultLedger: {
      async executeOnce(_identity, operation) {
        if (stored === undefined) stored = await operation();
        return structuredClone(stored) as any;
      }
    },
    projector,
    modelSnapshotRef: "model-snapshot-1",
    promptSnapshotRef: "prompt-snapshot-1"
  });
  const call = {
    name: "get_quote_decision" as const,
    input: { quoteVersionId: "formal-2" },
    stableCallHash: `sha256:${"d".repeat(64)}` as const
  };
  const full = await executor.executeResolved(call,
    workspaceContextFixture("manager", [
      "quote.draft.create", "pricing.sensitive.read"
    ]));
  assert.equal((full as any).estimatedGrossProfitMinor, 280_000);
  const redacted = await executor.executeResolved(call,
    workspaceContextFixture("manager", ["quote.draft.create"]));
  assert.equal("estimatedGrossProfitMinor" in (redacted as any), false);
  assert.equal((redacted as any).quoteVersionId, "formal-2");
  assert.equal((stored as any).kind, "growth_quote_authority_snapshot");
  assert.equal(handlerCalls, 1);
  assert.equal(projectorCalls, 2);
  await assert.rejects(() => executor.executeResolved(call,
    workspaceContextFixture("manager", [])), (error: any) =>
      error?.code === "capability_forbidden");
  assert.equal(handlerCalls, 1);
  assert.equal(projectorCalls, 3);
});

test("quote schemas are closed and preview requires a positive Case revision", () => {
  const preview = GROWTH_QUOTE_TOOL_BLUEPRINTS.find(
    (tool) => tool.name === "preview_quote"
  );
  assert.equal(preview?.parameters.additionalProperties, false);
  assert.deepEqual(preview?.parameters.required, [
    "quoteCaseId", "quoteCaseRevision", "quoteInput"
  ]);
  assert.deepEqual(
    (preview?.parameters.properties.quoteCaseRevision as Record<string, unknown>),
    { minimum: 1, type: "integer" }
  );
});

test("preview_quote carries the exact Case revision and unwraps command execution", async () => {
  const calls: unknown[][] = [];
  const ports = createGrowthCommercialToolPorts();
  ports.register("preview_quote", async (input, command) => {
    calls.push([input, command]);
    return { value: { previewIdentity: { inputSnapshotHash: `sha256:${"a".repeat(64)}` } }, replayed: false };
  });
  const executor = new GrowthAdvisorQuoteToolExecutor({
    toolPorts: ports,
    resultLedger: {
      executeOnce: async (_identity, operation) => operation()
    },
    modelSnapshotRef: "model-snapshot-1",
    promptSnapshotRef: "prompt-snapshot-1",
    now: () => "2026-08-09T08:30:00.000Z"
  });
  const context = workspaceContextFixture("sales");
  const result = await executor.executeResolved({
    name: "preview_quote",
    input: {
      quoteCaseId: "case-1",
      quoteCaseRevision: 3,
      quoteInput: {
        catalogItemId: "catalog-item-1",
        pricingPolicyVersionId: "pricing-policy-1",
        quantityMicros: 1_000_000,
        offeredUnitPriceMinor: 9_000,
        orderDiscountMinor: 0,
        paymentTermDays: 30,
        giftItems: [],
        surchargeContext: { region: null, deliveryMethod: null },
        customerTargetPriceMinor: null,
        creditRiskBps: null,
        manualEscalation: false
      }
    },
    stableCallHash: `sha256:${"b".repeat(64)}`
  }, context);
  assert.equal((result as any).previewIdentity.inputSnapshotHash.startsWith("sha256:"), true);
  assert.equal((calls[0]?.[1] as any).expectedRevision, 3);
  assert.equal((calls[0]?.[0] as any).quoteCaseRevision, undefined);
});
