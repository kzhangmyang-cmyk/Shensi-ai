import { createHash } from "node:crypto";
import { runDesktopOutreachSchemaUpgrade, validateUpgradeInput }
  from "./desktop-outreach-schema-upgrade.mjs";
import { createDesktopOutreachMysqlAdapter }
  from "./lib/desktop-outreach-schema-mysql.mjs";
import { createDesktopOutreachSchemaInspector }
  from "./lib/desktop-outreach-schema-inspector.mjs";
import { captureDesktopOutreachPreservation, compareDesktopOutreachPreservation }
  from "./lib/desktop-outreach-preservation.mjs";

const fail = () => new Error("DESKTOP_OUTREACH_PRESERVATION_BASELINE_INVALID");

function validateBaseline(input, baseline) {
  const keys = ["version", "attemptId", "project", "engineIdHash",
    "targetServerUuidSha256", "snapshot"];
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)
    || Object.keys(baseline).length !== keys.length
    || !keys.every((key) => Object.hasOwn(baseline, key))
    || baseline.version !== 1 || baseline.attemptId !== input.attemptId
    || baseline.project !== input.project
    || baseline.engineIdHash !== input.ownerWitness.engineIdHash
    || typeof baseline.targetServerUuidSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(baseline.targetServerUuidSha256)) throw fail();
  try {
    compareDesktopOutreachPreservation(baseline.snapshot, baseline.snapshot);
  } catch { throw fail(); }
}

/**
 * Compose the SQL runner for an already-restored, writer-free target.
 * The caller must load the persisted pre-upgrade baseline created at restore.
 * This function never captures a replacement baseline on retry, owns no CLI,
 * and cannot discover a database or credential from the environment.
 */
export async function runDesktopOutreachMysqlUpgrade(input, dependencies) {
  const context = structuredClone(input);
  validateUpgradeInput(context);
  const baseline = structuredClone(dependencies?.preservationBaseline);
  validateBaseline(context, baseline);
  let finalSnapshot;
  const assertBaselineTarget = async (read) => {
    const rows = await read.query("SELECT @@server_uuid AS serverUuid");
    if (!Array.isArray(rows) || rows.length !== 1
      || typeof rows[0].serverUuid !== "string"
      || createHash("sha256").update(rows[0].serverUuid).digest("hex")
        !== baseline.targetServerUuidSha256) throw fail();
  };
  const inspector = createDesktopOutreachSchemaInspector({
    async assertPreservation(read) {
      await assertBaselineTarget(read);
      const current = await captureDesktopOutreachPreservation(read);
      if (!compareDesktopOutreachPreservation(baseline.snapshot, current)) throw fail();
      finalSnapshot = current;
      return true;
    }
  });
  const adapter = createDesktopOutreachMysqlAdapter({
    readTargetPassword: dependencies.readTargetPassword,
    verifyOwner: dependencies.verifyOwner,
    connect: dependencies.connect,
    async inspectOwnerTable(read) {
      await assertBaselineTarget(read);
      return inspector.inspectOwnerTable(read);
    },
    inspectStep: inspector.inspectStep
  });
  const result = await runDesktopOutreachSchemaUpgrade(context, { adapter,
    now: dependencies.now, checkpoint: dependencies.checkpoint });
  if (!finalSnapshot) throw fail();
  return { ...result, preservationReport: { ...result.preservationReport,
    before: baseline.snapshot, after: finalSnapshot } };
}
