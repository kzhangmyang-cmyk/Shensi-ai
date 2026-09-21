import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const demoApp = readFileSync(new URL("../demo/demo-app.ts", import.meta.url), "utf8");

assert.match(
  demoApp,
  /shouldUseRealDashboard\(\s*router\.current\(\),\s*document\.body\.dataset\.sessionMode\s*\)/u,
  "an authenticated real dashboard route must select the server-backed dashboard controller"
);
assert.match(
  demoApp,
  /realDashboardController\.open\(\)/u,
  "the real dashboard route must load the authenticated summary"
);
assert.match(
  demoApp,
  /realDashboardController\.deactivate\(\)/u,
  "leaving the dashboard must fence and cancel stale summary reads"
);
