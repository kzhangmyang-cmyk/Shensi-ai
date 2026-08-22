import { strict as assert } from "node:assert";
import { createGrowthDemoAdapter } from "./adapter";

const adapter = createGrowthDemoAdapter();
assert.equal(adapter.kind, "demo");
const today = await adapter.getToday();
assert.equal(today.workspaceId, "demo-workspace");
assert.equal(today.audienceRole, "manager");
assert.match(today.sourceSnapshotHash, /^sha256:[a-f0-9]{64}$/u);
