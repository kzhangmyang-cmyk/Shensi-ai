import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  prepareTrialCloudflared,
  prepareTrialRuntime
} from "./real-trial-config.mjs";

const fixturePassword = "fixture-only-application-password-123456";

async function mode(path) { return (await stat(path)).mode & 0o777; }

test("prepareTrialCloudflared installs an explicitly supplied verified binary into retained runtime tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-cloudflared-"));
  const source = join(root, "cloudflared-source");
  const bytes = Buffer.from("fixture-cloudflared-binary");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(source, bytes, { mode: 0o700 });

  const installed = await prepareTrialCloudflared(join(root, "runtime"), {
    cloudflaredBinary: source,
    hostEnvironment: {}
  }, { expectedSha256: sha256 });

  assert.equal(installed, join(root, "runtime", "tools", "cloudflared"));
  assert.deepEqual(await readFile(installed), bytes);
  assert.equal(await mode(installed), 0o700);
});

test("prepareTrialCloudflared uses SHENSI_TRIAL_CLOUDFLARED when no explicit source is supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-cloudflared-env-"));
  const source = join(root, "cloudflared-env-source");
  const bytes = Buffer.from("fixture-cloudflared-from-environment");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(source, bytes, { mode: 0o700 });

  const installed = await prepareTrialCloudflared(join(root, "runtime"), {
    hostEnvironment: { SHENSI_TRIAL_CLOUDFLARED: source }
  }, { expectedSha256: sha256 });

  assert.deepEqual(await readFile(installed), bytes);
});

test("prepareTrialCloudflared reuses the verified retained runtime copy after its external source disappears", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-cloudflared-retained-"));
  const runtimeRoot = join(root, "runtime");
  const source = join(root, "cloudflared-one-time-source");
  const bytes = Buffer.from("fixture-retained-cloudflared");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(source, bytes, { mode: 0o700 });
  const installed = await prepareTrialCloudflared(runtimeRoot, {
    cloudflaredBinary: source,
    hostEnvironment: {}
  }, { expectedSha256: sha256 });
  await unlink(source);

  const reused = await prepareTrialCloudflared(runtimeRoot, {
    hostEnvironment: { SHENSI_TRIAL_CLOUDFLARED: "" }
  }, { expectedSha256: sha256 });

  assert.equal(reused, installed);
  assert.deepEqual(await readFile(reused), bytes);
});

test("prepareTrialCloudflared gives an explicit source precedence over the environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-cloudflared-precedence-"));
  const explicitSource = join(root, "explicit-cloudflared");
  const environmentSource = join(root, "environment-cloudflared");
  const explicitBytes = Buffer.from("fixture-explicit-cloudflared");
  const sha256 = createHash("sha256").update(explicitBytes).digest("hex");
  await writeFile(explicitSource, explicitBytes, { mode: 0o700 });
  await writeFile(environmentSource, "different-environment-binary", {
    mode: 0o700
  });

  const installed = await prepareTrialCloudflared(join(root, "runtime"), {
    cloudflaredBinary: explicitSource,
    hostEnvironment: { SHENSI_TRIAL_CLOUDFLARED: environmentSource }
  }, { expectedSha256: sha256 });

  assert.deepEqual(await readFile(installed), explicitBytes);
});

test("prepareTrialCloudflared fails with stable errors for a missing or unverified source", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-trial-cloudflared-invalid-"));
  await assert.rejects(prepareTrialCloudflared(join(root, "missing-runtime"), {
    hostEnvironment: {}
  }, { expectedSha256: "0".repeat(64) }), /TRIAL_CLOUDFLARED_REQUIRED/u);

  const source = join(root, "wrong-cloudflared");
  await writeFile(source, "wrong-binary", { mode: 0o700 });
  await assert.rejects(prepareTrialCloudflared(join(root, "wrong-runtime"), {
    cloudflaredBinary: source,
    hostEnvironment: {}
  }, { expectedSha256: "0".repeat(64) }), /TRIAL_CLOUDFLARED_SHA256_MISMATCH/u);
});

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
  assert.equal(/^DOUYIN_OUTREACH_APPROVALS_ENABLED=false$/m.test(environment), true);
  assert.equal(/^DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED=false$/m.test(environment), true);
  assert.equal(/^DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED=false$/m.test(environment), true);
  assert.equal(/^SHENSI_DESKTOP_CLIENT_ADMISSION_MODE=migration_locked$/m.test(environment), true);
  assert.equal(/^SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256=$/m.test(environment), true);
  assert.match(environment, /^DOUYIN_ACTION_VISUAL_LOCATOR=disabled$/m);
  assert.match(environment, /^DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS=120$/m);
  assert.match(environment, /^MEDIACRAWLER_BASE_URL=http:\/\/127\.0\.0\.1:5612$/m);
  assert.match(environment, /^MEDIACRAWLER_BROWSER_HEADLESS=false$/m);
  assert.match(environment, /^MEDIACRAWLER_BROWSER_CHANNEL=$/m);
  assert.match(environment, /^MEDIACRAWLER_BROWSER_DISPLAY=virtual$/m);
  for (const name of ["SHENSI_MYSQL_APP_PASSWORD", "TRADE_OBSERVATION_CURSOR_SECRET", "MARKET_OPPORTUNITY_CURSOR_SECRET", "PROSPECT_RUN_IDEMPOTENCY_SECRET", "PROSPECT_RUN_CURSOR_SECRET", "PROSPECT_EXECUTION_CLAIM_SECRET", "ORGANIZATION_IDENTITY_MASTER_SECRET", "PROSPECT_SOURCE_RAW_ENVELOPE_SECRET", "PROSPECT_COVERAGE_MASTER_SECRET"]) {
    assert.match(environment, new RegExp(`^${name}=.{32,}$`, "m"));
  }
  const names = ["jwt_secret", "provider_credential_key", "agent_job_encryption_key", "acquisition_master_secret", "acquisition_v1_cursor_secret", "mysql_app_password", "trade_observation_cursor_secret", "market_opportunity_cursor_secret", "prospect_run_idempotency_secret", "prospect_run_cursor_secret", "prospect_execution_claim_secret", "organization_identity_master_secret", "prospect_source_raw_envelope_secret", "prospect_coverage_master_secret"];
  const secrets = await Promise.all([
    ...names.map(async (name) => readFile(join(runtime.secretsDirectory, name), "utf8")),
    readFile(join(runtime.secretsDirectory, "mediacrawler", "service_secret"), "utf8")
  ]);
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
  assert.equal(runtime.environment.MEDIACRAWLER_ENCRYPTED_VOLUME,
    join(runtime.stateDirectory, "mediacrawler"));
  assert.equal(runtime.environment.MEDIACRAWLER_PROFILE_ROOT,
    join(runtime.stateDirectory, "mediacrawler", "profile"));
  assert.equal(runtime.environment.MEDIACRAWLER_CRAWL_OUTPUT_ROOT,
    join(runtime.stateDirectory, "mediacrawler", "output"));
  assert.equal(runtime.environment.MEDIACRAWLER_SERVICE_SECRET_FILE,
    join(runtime.secretsDirectory, "mediacrawler", "service_secret"));
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
  const enabledFile = await readFile(enabled.environmentFile, "utf8");
  assert.equal(/^DOUYIN_OUTREACH_APPROVALS_ENABLED=true$/m.test(enabledFile), true);
  assert.equal(/^DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED=true$/m.test(enabledFile), true);
  assert.equal(/^DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED=false$/m.test(enabledFile), true);
  assert.equal(/^SHENSI_DESKTOP_CLIENT_ADMISSION_MODE=migration_locked$/m.test(enabledFile), true);
  assert.equal(/^SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256=$/m.test(enabledFile), true);

  const disabled = await prepareTrialRuntime(root, {
    isPortAvailable: async () => true,
    outreachActionsEnabled: " true "
  });
  assert.equal(disabled.environment.DOUYIN_OUTREACH_ACTIONS_ENABLED, "false");
  const disabledFile = await readFile(disabled.environmentFile, "utf8");
  assert.equal(/^DOUYIN_OUTREACH_APPROVALS_ENABLED=false$/m.test(disabledFile), true);
  assert.equal(/^DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED=false$/m.test(disabledFile), true);
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
  const inherited = {
    DOUYIN_OUTREACH_APPROVALS_ENABLED: "true",
    DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: "true",
    DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: "true",
    SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "exact",
    SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: "d".repeat(64)
  };
  const previousRoles = Object.fromEntries(Object.keys(inherited)
    .map((key) => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  process.env.DOUYIN_OUTREACH_ACTIONS_ENABLED = "true";
  process.env.DOUYIN_ACTION_VISUAL_LOCATOR = "rapidocr";
  try {
    const runtime = await prepareTrialRuntime(root, {
      appPassword: fixturePassword,
      isPortAvailable: async () => true
    });
    assert.equal(runtime.environment.DOUYIN_OUTREACH_ACTIONS_ENABLED, "false");
    assert.equal(runtime.environment.DOUYIN_ACTION_VISUAL_LOCATOR, "disabled");
    assert.equal(runtime.environment.DOUYIN_OUTREACH_APPROVALS_ENABLED, "false");
    assert.equal(runtime.environment.DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED, "false");
    assert.equal(runtime.environment.DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED, "false");
    assert.equal(runtime.environment.SHENSI_DESKTOP_CLIENT_ADMISSION_MODE, "migration_locked");
    assert.equal(runtime.environment.SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256, "");
    assert.equal(/d{64}/u.test(await readFile(runtime.environmentFile, "utf8")), false);
  } finally {
    for (const [key, value] of Object.entries(previousRoles)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
