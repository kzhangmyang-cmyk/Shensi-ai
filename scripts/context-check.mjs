import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "AGENTS.md",
  "README.md",
  "docs/PROJECT_STATUS.md",
  "docs/ARCHITECTURE.md",
  "docs/API_INDEX.md",
  "docs/DATA_MIGRATION.md",
  "docs/DEPLOYMENT.md",
  "docs/SOURCE_PROVENANCE.md",
  "docs/modules/acquisition.md",
  "docs/modules/crm.md",
  "docs/modules/financial-council.md",
  "docs/modules/model-connections.md",
  "docs/modules/identity-and-permissions.md"
];
for (const relative of required) {
  if (!existsSync(resolve(root, relative))) throw new Error(`CONTEXT_FILE_MISSING:${relative}`);
}
const status = readFileSync(resolve(root, "docs/PROJECT_STATUS.md"), "utf8");
for (const heading of ["## Completed", "## Active", "## Blocked", "## Next"]) {
  if (!status.includes(heading)) throw new Error(`PROJECT_STATUS_SECTION_MISSING:${heading}`);
}
if (status.includes(".worktrees/agent-center-shell")) {
  throw new Error("PROJECT_STATUS_POINTS_TO_LEGACY_WORKTREE");
}
const contractManifest = JSON.parse(readFileSync(
  resolve(root, "contracts/releases/growth-advisor-quote-roi/1.0.12/manifest.json"),
  "utf8"
));
if (contractManifest.contractVersion !== "1.0.12") throw new Error("CONTRACT_RELEASE_DRIFT");
console.log("SHENSI_CONTEXT_OK");
