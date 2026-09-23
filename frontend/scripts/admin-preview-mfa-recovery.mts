import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdir, lstat, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { previewEnvironment } from '../../scripts/admin-preview-runtime.mjs';

// Explicitly invoked acceptance only. No caller-provided DB URL or desktop identity.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = join(root, '.runtime/admin-preview');
const artifacts = join(runtime, 'artifacts');
const configPath = join(runtime, 'config.json');
const origin = 'http://localhost:5681';
const requireBackend = createRequire(join(root, 'backend/package.json'));
const { TOTP, Secret } = requireBackend('otpauth');
const mysql = requireBackend('mysql2/promise');
const checks: string[] = [];
let stage = 'validate_isolation';
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let pool: any;
let cfg: any;
let stopped = false;
let recovered = false;
let configUpdated = false;
let replacementSecret = '';
const result: Record<string, unknown> = { syntheticOnly: true, database: 'shensi_admin_preview', checks, passed: false };

async function privateFile(path: string) {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600, 'private_file_required');
}
function docker(args: string[]) {
  return execFileSync('docker', args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: cfg.dockerHost }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function assertOwned() {
  assert.equal(cfg.dockerHost, 'unix:///Users/mac/.colima/shensi-trial/docker.sock');
  assert.equal(createHash('sha256').update(docker(['info', '--format', '{{.ID}}'])).digest('hex'), cfg.engine);
  assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "io.shensi.admin-preview.owner"}}', cfg.name]), cfg.owner);
  assert.equal(docker(['port', cfg.name, '3306/tcp']), `127.0.0.1:${cfg.mysqlPort}`);
}
function runtimeCommand(command: 'stop' | 'start') {
  assertOwned();
  execFileSync(process.execPath, [join(root, 'scripts/admin-preview-runtime.mjs'), command], {
    cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, DOCKER_HOST: cfg.dockerHost },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
  });
}
async function waitStopped() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const up = await Promise.all([5680, 5681].map(async port => {
      try { await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }); return true; } catch { return false; }
    }));
    if (up.every(value => !value)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('preview_stop_timeout');
}
async function state() {
  const [[row]] = await pool.query('SELECT payload FROM platform_administration_state WHERE id=1');
  return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
}
async function updateConfig() {
  const nextPath = join(runtime, 'config.mfa-recovery-next.json');
  await writeFile(nextPath, JSON.stringify({ ...cfg, totpSecret: replacementSecret }), { mode: 0o600, flag: 'wx' });
  await rename(nextPath, configPath);
  cfg.totpSecret = replacementSecret;
  configUpdated = true;
}
try {
  assert.equal(process.env.SHENSI_ADMIN_PREVIEW_MFA_ACCEPTANCE, '1', 'explicit_acceptance_required');
  await privateFile(configPath);
  await privateFile(join(runtime, 'operator-before-recovery.json'));
  cfg = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(cfg.version, 1);
  assert.match(cfg.owner, /^[a-f0-9]{24}$/);
  assert.equal(cfg.name, `shensi-admin-preview-${cfg.owner}`);
  assert.equal(cfg.database, 'shensi_admin_preview');
  assert.equal(cfg.operatorId, `preview_ops_${cfg.owner}`);
  assertOwned();
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  pool = mysql.createPool(previewEnvironment(cfg).DATABASE_URL);
  const [[database]] = await pool.query('SELECT DATABASE() name'); assert.equal(database.name, cfg.database);
  const before = await state();
  const previousMember = before.memberships.find((row: any) => row.userId === cfg.operatorId);
  assert.ok(previousMember);
  const [usersBefore] = await pool.query('SELECT id,auth_version,password_hash FROM users ORDER BY id');
  const [customersBefore] = await pool.query('SELECT id,team_id,owner_id FROM customers ORDER BY id');
  browser = await chromium.launch();
  const oldContext = await browser.newContext({ storageState: join(runtime, 'operator-before-recovery.json'), viewport: { width: 1440, height: 960 } });
  assert.equal((await oldContext.request.get(`${origin}/api/platform/v1/overview`)).status(), 200, 'fresh_old_operator_session_required');
  checks.push('existing_operator_session_valid_before_recovery');
  stage = 'offline_recovery';
  const oldSecret = cfg.totpSecret;
  replacementSecret = new TOTP().secret.base32;
  assert.notEqual(replacementSecret, oldSecret);
  runtimeCommand('stop'); stopped = true; await waitStopped();
  execFileSync(process.execPath, [join(root, 'backend/dist/platform-admin-recover-mfa.js')], {
    cwd: root, env: { ...previewEnvironment(cfg), SHENSI_PLATFORM_RECOVERY_CONFIRM_DATABASE: cfg.database,
      SHENSI_PLATFORM_RECOVERY_USER_ID: cfg.operatorId, SHENSI_PLATFORM_RECOVERY_TOTP_SECRET: replacementSecret,
      SHENSI_PLATFORM_RECOVERY_REASON: '隔离合成验收：运营验证器离线恢复' },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  });
  recovered = true;
  await updateConfig();
  checks.push('offline_cli_recovery_committed');
  runtimeCommand('start'); stopped = false;
  stage = 'durable_state_after_restart';
  const after = await state(), nextMember = after.memberships.find((row: any) => row.userId === cfg.operatorId);
  assert.equal(nextMember.sessionVersion, previousMember.sessionVersion + 1);
  assert.notEqual(nextMember.secretEncrypted, previousMember.secretEncrypted);
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.workspaces, before.workspaces); assert.deepEqual(after.plans, before.plans);
  assert.deepEqual(after.audits.slice(0, -1), before.audits);
  assert.equal(after.audits.at(-1).action, 'recover_platform_mfa');
  const [usersAfter] = await pool.query('SELECT id,auth_version,password_hash FROM users ORDER BY id');
  assert.deepEqual(usersAfter, usersBefore.map((row: any) => row.id === cfg.operatorId ? { ...row, auth_version: (row.auth_version || 1) + 1 } : row));
  const [customersAfter] = await pool.query('SELECT id,team_id,owner_id FROM customers ORDER BY id');
  assert.deepEqual(customersAfter, customersBefore);
  checks.push('restart_preserves_enterprises_accounts_passwords_customers_and_audit');
  stage = 'old_sessions_and_otp';
  assert.equal((await oldContext.request.get(`${origin}/api/auth/me`)).status(), 401);
  assert.equal((await oldContext.request.get(`${origin}/api/platform/v1/overview`)).status(), 401);
  checks.push('old_customer_and_operator_sessions_revoked');
  const fresh = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await fresh.newPage(); await page.goto(`${origin}/admin.html`);
  const login = await fresh.request.post(`${origin}/api/auth/login`, { data: { email: 'preview_ops', password: cfg.operatorPassword } });
  assert.equal(login.status(), 200);
  const csrf = (await fresh.cookies()).find(row => row.name === 'gj_csrf')!.value;
  const headers = { 'X-CSRF-Token': decodeURIComponent(csrf), Origin: origin };
  const newOtp = new TOTP({ secret: Secret.fromBase32(replacementSecret) });
  const oldOtp = new TOTP({ secret: Secret.fromBase32(oldSecret) });
  // Avoid the rare equal-code collision when proving old-seed rejection.
  let timestamp = Date.now();
  while ([-1, 0, 1].some(offset => oldOtp.generate({ timestamp }) === newOtp.generate({ timestamp: timestamp + offset * 30000 }))) {
    await new Promise(resolve => setTimeout(resolve, 1000)); timestamp = Date.now();
  }
  assert.equal((await fresh.request.post(`${origin}/api/platform/v1/session`, { headers, data: { code: oldOtp.generate({ timestamp }) } })).status(), 401);
  checks.push('old_totp_secret_rejected');
  await page.reload();
  await page.getByLabel('身份验证器验证码').fill(newOtp.generate());
  await page.getByRole('button', { name: '验证并进入' }).click();
  await expect(page.getByRole('button', { name: '创建企业', exact: true })).toBeVisible();
  await page.screenshot({ path: join(artifacts, 'mfa-recovered-admin.png') });
  checks.push('new_totp_browser_login_succeeds');
  result.passed = true;
} catch (error) {
  result.failedStage = stage;
  result.errorType = error instanceof Error ? error.name : 'UnknownError';
  // Do not serialize exception messages, subprocess output, assertions or credentials.
  process.exitCode = 1;
} finally {
  if (stopped) {
    try {
      if (recovered && !configUpdated) await updateConfig();
      runtimeCommand('start'); stopped = false;
    } catch { result.previewRecoveryRequired = true; }
  }
  await browser?.close(); await pool?.end();
  if (cfg) {
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    await writeFile(join(artifacts, 'mfa-recovery-result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify(result));
}
