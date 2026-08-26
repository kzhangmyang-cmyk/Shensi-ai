import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const entries = readdirSync(root, { recursive: true }) as string[];
const runtimeSource = readFileSync(join(root, "runtime.ts"), "utf8");

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
