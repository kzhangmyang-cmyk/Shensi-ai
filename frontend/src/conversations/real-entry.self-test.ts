import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const demoApp = readFileSync(new URL("../demo/demo-app.ts", import.meta.url), "utf8");

assert.match(
  demoApp,
  /shouldUseRealConversations\(\s*router\.current\(\),\s*document\.body\.dataset\.sessionMode\s*\)/u,
  "real authenticated #conversations must select the read-only real controller"
);
assert.match(
  demoApp,
  /realConversationsController\.open\(\)/u,
  "the real conversations route must load server-backed public interactions"
);
assert.match(
  demoApp,
  /realConversationsController\.deactivate\(\)/u,
  "leaving the route must deactivate stale real conversation reads"
);
