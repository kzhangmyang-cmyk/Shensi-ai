import assert from "node:assert/strict";
import {
  createAiModelConfigId,
  requiredNodeVersion
} from "./model-providers/connection-service.js";

assert.equal(requiredNodeVersion, ">=22.19.0");
const ids = new Set(Array.from({ length: 2_000 }, () => createAiModelConfigId()));
assert.equal(ids.size, 2_000);
for (const id of ids) {
  assert.match(id, /^ai_[0-9a-f-]{36}$/);
}
console.log(JSON.stringify({ ok: true, ids: ids.size }));
