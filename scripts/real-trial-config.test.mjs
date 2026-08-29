import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareTrialRuntime } from "./real-trial-config.mjs";

const fixturePassword = "fixture-only-application-password-123456";

async function mode(path) { return (await stat(path)).mode & 0o777; }

test("prepareTrialRuntime creates private deterministic runtime state without exposing values", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-config-"));
  const logs = [];
  const runtime = await prepareTrialRuntime(root, {
    appPassword: fixturePassword,
    isPortAvailable: async () => true,
    emit: (line) => logs.push(line)
  });
  assert.equal(await mode(runtime.root), 0o700);
  assert.equal(await mode(runtime.secretsDirectory), 0o700);
  assert.equal(await mode(runtime.stateDirectory), 0o700);
  assert.equal(await mode(runtime.environmentFile), 0o600);
  const environment = await readFile(runtime.environmentFile, "utf8");
  assert.match(environment, /^DATABASE_URL=mysql:\/\/shensi_trial_app:/m);
  assert.match(environment, /@127\.0\.0\.1:3310\/shensi_trial$/m);
  assert.match(environment, /^VITE_REAL_TRIAL=true$/m);
  assert.match(environment, /^DOUYIN_OUTREACH_ACTIONS_ENABLED=false$/m);
  assert.match(environment, /^DOUYIN_ACTION_VISUAL_LOCATOR=disabled$/m);
  assert.match(environment, /^DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS=120$/m);
  assert.match(environment, /^MEDIACRAWLER_BASE_URL=http:\/\/127\.0\.0\.1:5612$/m);
  for (const name of ["SHENSI_MYSQL_APP_PASSWORD", "TRADE_OBSERVATION_CURSOR_SECRET", "MARKET_OPPORTUNITY_CURSOR_SECRET", "PROSPECT_RUN_IDEMPOTENCY_SECRET", "PROSPECT_RUN_CURSOR_SECRET", "PROSPECT_EXECUTION_CLAIM_SECRET", "ORGANIZATION_IDENTITY_MASTER_SECRET", "PROSPECT_SOURCE_RAW_ENVELOPE_SECRET", "PROSPECT_COVERAGE_MASTER_SECRET"]) {
    assert.match(environment, new RegExp(`^${name}=.{32,}$`, "m"));
  }
  const names = ["jwt_secret", "provider_credential_key", "agent_job_encryption_key", "acquisition_master_secret", "acquisition_v1_cursor_secret", "mediacrawler_service_secret", "mysql_app_password", "trade_observation_cursor_secret", "market_opportunity_cursor_secret", "prospect_run_idempotency_secret", "prospect_run_cursor_secret", "prospect_execution_claim_secret", "organization_identity_master_secret", "prospect_source_raw_envelope_secret", "prospect_coverage_master_secret"];
  const secrets = await Promise.all(names.map(async (name) => readFile(join(runtime.secretsDirectory, name), "utf8")));
  assert.equal(new Set(secrets).size, secrets.length);
  for (const value of secrets) {
    assert.ok(Buffer.byteLength(value) >= 32);
    assert.doesNotMatch(value, /[\r\n]/);
    assert.equal(logs.some((line) => line.includes(value)), false);
  }
  assert.equal(logs.some((line) => line.includes(fixturePassword)), false);
  assert.notEqual(await readFile(join(runtime.secretsDirectory, "mysql_app_password"), "utf8"), fixturePassword);
  assert.equal(await readFile(join(runtime.secretsDirectory, "trial_app_password"), "utf8"), fixturePassword);
  assert.equal(runtime.environment.SHENSI_TRIAL_APP_PASSWORD_FILE, join(runtime.secretsDirectory, "trial_app_password"));
  const repeated = await prepareTrialRuntime(root, { isPortAvailable: async () => true });
  assert.equal(await readFile(join(repeated.secretsDirectory, "jwt_secret"), "utf8"), secrets[0]);
  assert.equal(await readFile(join(repeated.secretsDirectory, "bootstrap_admin_password"), "utf8"), runtime.bootstrapPassword);
  await assert.rejects(prepareTrialRuntime(root, { appPassword: "different-fixture-password-123456", isPortAvailable: async () => true }), /TRIAL_APP_PASSWORD_MISMATCH/);
});

test("prepareTrialRuntime refuses every occupied fixed port", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-config-port-"));
  await assert.rejects(
    prepareTrialRuntime(root, { appPassword: fixturePassword, isPortAvailable: async (port) => port !== 3310 }),
    /TRIAL_PORT_OCCUPIED:3310/
  );
});

test("prepareTrialRuntime enables outreach only for exact explicit authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-config-outreach-"));
  const enabled = await prepareTrialRuntime(root, {
    appPassword: fixturePassword,
    isPortAvailable: async () => true,
    outreachActionsEnabled: true
  });
  assert.equal(enabled.environment.DOUYIN_OUTREACH_ACTIONS_ENABLED, "true");

  const disabled = await prepareTrialRuntime(root, {
    isPortAvailable: async () => true,
    outreachActionsEnabled: " true "
  });
  assert.equal(disabled.environment.DOUYIN_OUTREACH_ACTIONS_ENABLED, "false");
});

test("prepareTrialRuntime defaults OCR off and accepts only an exact explicit locator", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-config-locator-"));
  const enabled = await prepareTrialRuntime(root, {
    appPassword: fixturePassword,
    isPortAvailable: async () => true,
    actionVisualLocator: "rapidocr"
  });
  assert.equal(enabled.environment.DOUYIN_ACTION_VISUAL_LOCATOR, "rapidocr");

  await assert.rejects(prepareTrialRuntime(root, {
    isPortAvailable: async () => true,
    actionVisualLocator: " rapidocr "
  }), /DOUYIN_ACTION_VISUAL_LOCATOR_INVALID/u);
});

test("prepareTrialRuntime never treats a retained process environment flag as fresh authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-config-no-inherit-"));
  const previous = process.env.DOUYIN_OUTREACH_ACTIONS_ENABLED;
  const previousLocator = process.env.DOUYIN_ACTION_VISUAL_LOCATOR;
  process.env.DOUYIN_OUTREACH_ACTIONS_ENABLED = "true";
  process.env.DOUYIN_ACTION_VISUAL_LOCATOR = "rapidocr";
  try {
    const runtime = await prepareTrialRuntime(root, {
      appPassword: fixturePassword,
      isPortAvailable: async () => true
    });
    assert.equal(runtime.environment.DOUYIN_OUTREACH_ACTIONS_ENABLED, "false");
    assert.equal(runtime.environment.DOUYIN_ACTION_VISUAL_LOCATOR, "disabled");
  } finally {
    if (previous === undefined) delete process.env.DOUYIN_OUTREACH_ACTIONS_ENABLED;
    else process.env.DOUYIN_OUTREACH_ACTIONS_ENABLED = previous;
    if (previousLocator === undefined) delete process.env.DOUYIN_ACTION_VISUAL_LOCATOR;
    else process.env.DOUYIN_ACTION_VISUAL_LOCATOR = previousLocator;
  }
});

test("prepareTrialRuntime rejects an explicitly relative root and a symlinked private directory", async () => {
  await assert.rejects(
    prepareTrialRuntime(process.cwd(), {
      runtimeRoot: "relative-trial-runtime",
      appPassword: fixturePassword,
      isPortAvailable: async () => true
    }),
    /TRIAL_RUNTIME_ROOT_MUST_BE_ABSOLUTE/u
  );
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-config-symlink-"));
  const target = await mkdtemp(join(tmpdir(), "shensi-trial-config-target-"));
  await symlink(target, join(root, "secrets"));
  await assert.rejects(
    prepareTrialRuntime(root, { runtimeRoot: root, appPassword: fixturePassword, isPortAvailable: async () => true }),
    /TRIAL_PRIVATE_DIRECTORY_SYMLINK/u
  );
});
