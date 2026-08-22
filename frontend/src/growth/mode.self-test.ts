import { strict as assert } from "node:assert";
import manifest from "../../contracts/pinned/growth-advisor-quote-roi.manifest.json";
import { resolveGrowthMode } from "./mode";

const mismatch = resolveGrowthMode({
  requested: "real",
  pinned: manifest,
  bootstrap: {
    status: "ready",
    workspaceId: "workspace-1",
    capabilityRegistryVersion: "growth-capabilities.v1",
    capabilities: ["catalog.read"],
    contractVersion: manifest.contractVersion,
    contractHash: `sha256:${"f".repeat(64)}`,
    features: ["catalog"]
  }
});
assert.deepEqual(mismatch, {
  kind: "unavailable",
  reason: "contract_mismatch"
});

const selectionRequired = resolveGrowthMode({
  requested: "real",
  pinned: manifest,
  bootstrap: {
    status: "workspace_selection_required",
    workspaceId: null,
    capabilityRegistryVersion: "growth-capabilities.v1",
    capabilities: [],
    contractVersion: manifest.contractVersion,
    contractHash: manifest.contractHash,
    features: []
  }
});
assert.deepEqual(selectionRequired, {
  kind: "unavailable",
  reason: "workspace_selection_required"
});

const demo = resolveGrowthMode({
  requested: "demo",
  pinned: manifest,
  bootstrap: {
    status: "workspace_selection_required",
    workspaceId: null,
    capabilityRegistryVersion: "growth-capabilities.v1",
    capabilities: [],
    contractVersion: manifest.contractVersion,
    contractHash: manifest.contractHash,
    features: []
  }
});
assert.deepEqual(demo, { kind: "demo" });

const ready = resolveGrowthMode({
  requested: "real",
  pinned: manifest,
  bootstrap: {
    status: "ready",
    workspaceId: "workspace-1",
    capabilityRegistryVersion: "growth-capabilities.v1",
    capabilities: ["catalog.read"],
    contractVersion: manifest.contractVersion,
    contractHash: manifest.contractHash,
    features: ["catalog"]
  }
});
assert.equal(ready.kind, "real");
