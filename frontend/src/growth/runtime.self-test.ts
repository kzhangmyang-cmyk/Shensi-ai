import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const entries = readdirSync(root, { recursive: true }) as string[];
const runtimeSource = readFileSync(join(root, "runtime.ts"), "utf8");
assert.match(runtimeSource, /let financeKind:.*= "readonly";/u, 'real default upload must inspect, never assume acquisition cost');

assert.match(
  runtimeSource,
  /workspaceId:\s*\(\)\s*=>\s*mode\.bootstrap\.workspaceId/u,
  "real growth requests must carry the workspace selected by bootstrap"
);
assert.match(
  runtimeSource,
  /quoteController\.listCases\(context\.signal\)/u,
  "opening the quote workbench without a case must load selectable cases"
);
assert.match(
  runtimeSource,
  /data-quote-assessment-form/u,
  "ordinary CRM deals must collect a human assessment before case creation"
);
assert.match(
  runtimeSource,
  /crmAssessment/u,
  "the human assessment must be sent through the quote case contract"
);
assert.match(
  runtimeSource,
  /createPrivateDomainController/u,
  "the customer directory must reuse the authoritative CRM/private-domain controller"
);
assert.match(
  runtimeSource,
  /data-growth-catalog-tab/u,
  "the customer directory must expose working customer and product tabs"
);
assert.match(
  runtimeSource,
  /<details class="growth-catalog-summary">/u,
  "the catalog keeps product and pricing material as an optional disclosure"
);
assert.match(
  runtimeSource,
  /surface:\s*"catalog"/u,
  "the customer directory must render catalog columns without changing the private-domain surface"
);
assert.match(
  runtimeSource,
  /createFinanceImportWorkflow/u,
  "the finance page must bind its existing import workflow"
);
assert.match(
  runtimeSource,
  /advisorController\.decide/u,
  "advisor recommendation controls must call the real decision controller"
);

for (const entry of entries) {
  if (!entry.endsWith(".ts") || entry.includes(".self-test")) continue;
  const source = readFileSync(join(root, entry), "utf8");
  const isDemo = entry.startsWith("demo/");
  const importsDemo = source.includes('"./demo/')
    || source.includes('"../demo/');
  const importsHttp = source.includes('"./http"')
    || source.includes('"../http"');
  assert.equal(
    isDemo ? false : importsDemo,
    false,
    `growth import boundary: ${entry} must not import demo`
  );
  assert.equal(
    isDemo ? importsHttp : false,
    false,
    `growth import boundary: demo ${entry} must not import http`
  );
}
