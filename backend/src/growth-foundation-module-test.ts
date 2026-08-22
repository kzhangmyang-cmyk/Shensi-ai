import assert from "node:assert/strict";
import express from "express";
import { test } from "node:test";
import { createGrowthCommercialToolPorts } from "./growth-commercial-application.js";
import { createGrowthPrivateServiceRegistry } from "./growth-commercial-private-services.js";
import {
  GROWTH_FOUNDATION_SERVICES,
  createGrowthFoundationModule
} from "./growth-foundation-module.js";
import type { GrowthTrustedWorkspaceSettingsAppender } from "./growth-workspace-settings.js";
import { createGrowthAcquisitionWorkspaceResolver, type ActiveWorkspaceContext } from "./growth-workspace-context.js";

const workspace = Object.freeze({ workspaceId: "team-a", kind: "team", actorId: "user-1", role: "admin", teamId: "team-a", capabilities: [], capabilityRegistryVersion: "growth-capabilities.v1" }) as ActiveWorkspaceContext;

test("Foundation installs one frozen singleton whose request adapters preserve trusted provenance", async () => {
  const acquisitionWorkspace = createGrowthAcquisitionWorkspaceResolver({
    resolve: async ({ ownerId, teamId }) => ownerId === "owner-1" && teamId === "team-a"
      ? { workspaceId: "team-a", kind: "team", bindingRevision: "binding-1" } : null
  });
  const module = createGrowthFoundationModule({ mode: "memory", acquisitionWorkspace });
  const privateServices = createGrowthPrivateServiceRegistry();
  await module.install({ router: express.Router(), toolPorts: createGrowthCommercialToolPorts(), privateServices });
  const services = privateServices.require(GROWTH_FOUNDATION_SERVICES);
  const request = { method: "POST", activeWorkspace: workspace, header: (name: string) => name === "Idempotency-Key" ? "command-key-0001" : undefined } as never;
  assert.equal(services.workspaceContext(request), workspace);
  const context = services.commandContextFactory(request, { canonicalPath: "/api/v1/catalog/items/:id/retire", pathParams: Object.freeze({ id: "item-1" }), payload: { actorId: "forged" }, expectedRevision: 2 });
  assert.equal(context.workspace, workspace);
  assert.equal(context.actorId, "user-1");
  assert.equal(context.idempotencyKey, "command-key-0001");
  assert.equal(services.acquisitionWorkspace, acquisitionWorkspace);
  const firstAppend = await services.temporalTransactions.run((transaction) =>
    services.temporalBarrier.allocateAppend(transaction, "team-a")
  );
  const settingsAppend = await (services.workspaceSettings as GrowthTrustedWorkspaceSettingsAppender)
    .appendTrustedSettingsEvent("team-a", {
      timeZone: "Asia/Shanghai",
      revision: "settings-2"
    });
  const cutoff = await services.temporalBarrier.sealReadCutoff(
    workspace,
    "1970-01-01T00:00:00.002Z"
  );
  assert.equal(firstAppend.temporalSequence, 1);
  assert.equal(settingsAppend.recordedAt, "1970-01-01T00:00:00.002Z");
  assert.equal(cutoff.temporalSequence, 3);
  assert.throws(() => services.workspaceContext({ activeWorkspace: undefined } as never), /workspace_required/u);
  assert.ok(Object.isFrozen(services));
  await assert.rejects(() => module.install({ router: express.Router(), toolPorts: createGrowthCommercialToolPorts(), privateServices }), /DUPLICATE_GROWTH_FOUNDATION_INSTALL/u);
});
