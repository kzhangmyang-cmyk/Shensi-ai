import { chromium, expect, type Page } from '@playwright/test';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import assert from 'node:assert/strict';

// Run only after the parent builds and restarts the dedicated synthetic preview.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = join(root, '.runtime/admin-preview');
const artifacts = join(runtime, 'artifacts');
const origin = 'http://localhost:5681';
const requireBackend = createRequire(join(root, 'backend/package.json'));
const { TOTP, Secret } = requireBackend('otpauth');
const mysql = requireBackend('mysql2/promise');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, pool: any;
let stage = 'validate_isolation';
const checks: string[] = [];
const result: Record<string, unknown> = { syntheticOnly: true, database: 'shensi_admin_preview', checks, passed: false };
const suffix = Date.now().toString(36);
const accounts = [`signup_${suffix}`, `tenant2_${suffix}`];
const passwords = [randomBytes(18).toString('base64url'), randomBytes(18).toString('base64url')];
const localDate = (timestamp: number) => new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60000).toISOString().slice(0, 16);

try {
  assert.equal(process.env.SHENSI_ADMIN_REGISTRATION_ACCEPTANCE, '1', 'explicit_acceptance_required');
  const configPath = join(runtime, 'config.json'), stat = await lstat(configPath);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600);
  const cfg = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(cfg.database, 'shensi_admin_preview'); assert.match(cfg.owner, /^[a-f0-9]{24}$/);
  assert.equal(cfg.name, `shensi-admin-preview-${cfg.owner}`);
  assert.equal(cfg.dockerHost, 'unix:///Users/mac/.colima/shensi-trial/docker.sock');
  const docker = (args: string[]) => execFileSync('docker', args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: cfg.dockerHost }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(createHash('sha256').update(docker(['info', '--format', '{{.ID}}'])).digest('hex'), cfg.engine);
  assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "io.shensi.admin-preview.owner"}}', cfg.name]), cfg.owner);
  assert.equal(docker(['port', cfg.name, '3306/tcp']), `127.0.0.1:${cfg.mysqlPort}`);
  pool = mysql.createPool({ host: '127.0.0.1', port: cfg.mysqlPort, user: 'root', password: cfg.databasePassword, database: cfg.database });
  const [[database]] = await pool.query('SELECT DATABASE() name'); assert.equal(database.name, cfg.database);
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  await writeFile(join(runtime, 'registration-credentials.json'), JSON.stringify({ accounts, passwords }), { mode: 0o600 });
  browser = await chromium.launch();
  const ops = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const contexts = await Promise.all(accounts.map(() => browser!.newContext({ viewport: { width: 1440, height: 960 } })));
  const admin = await ops.newPage(), clients = await Promise.all(contexts.map(context => context.newPage()));
  const errors: string[] = []; [admin, ...clients].forEach(page => page.on('pageerror', error => errors.push(error.name)));
  async function state() { const [[row]] = await pool.query('SELECT payload FROM platform_administration_state WHERE id=1'); return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; }
  async function shot(page: Page, filename: string) { await page.screenshot({ path: join(artifacts, filename), mask: [page.locator('input[type=password]'), page.locator('input[autocomplete=one-time-code]')] }); }
  async function request(page: Page, path: string, method = 'GET', body?: unknown) {
    return page.evaluate(async ({ path, method, body }) => {
      const csrf = document.cookie.split(';').map(row => row.trim()).find(row => row.startsWith('gj_csrf='))?.slice(8) ?? '';
      const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }, { path, method, body });
  }
  async function login(index: number, clear = true) {
    const page = clients[index]; if (clear) await contexts[index].clearCookies();
    await page.goto(origin);
    await page.locator('#loginEmail').fill(accounts[index]); await page.locator('#loginPassword').fill(passwords[index]);
    const response = page.waitForResponse(row => new URL(row.url()).pathname === '/api/auth/login');
    await page.locator('#loginForm button[type=submit]').click(); return (await response).status();
  }
  async function registration(index: number) {
    const page = clients[index]; await page.goto(origin);
    await page.locator('#loginModeToggle').click();
    await page.locator('#loginEmail').fill(accounts[index]); await page.locator('#loginPassword').fill(passwords[index]);
    const response = page.waitForResponse(row => new URL(row.url()).pathname === '/api/auth/register');
    await page.locator('#loginForm button[type=submit]').click(); assert.equal((await response).status(), 201);
    const [[user]] = await pool.query('SELECT id,team_id FROM users WHERE email=?', [`${accounts[index]}@shensi.local`]);
    assert.ok(user); const workspace = (await state()).workspaces.find((row: any) => row.id === user.team_id);
    assert.ok(workspace); assert.equal(workspace.status, 'pending');
    return { userId: user.id, workspaceId: user.team_id };
  }
  async function nav(tab: string) { await admin.getByRole('navigation').getByRole('button', { name: tab, exact: true }).click(); await expect(admin.getByRole('heading', { level: 1 })).toHaveText(tab); }
  async function search(query: string) { await admin.getByRole('textbox', { name: '搜索企业或账号' }).fill(query); await admin.getByRole('button', { name: '搜索', exact: true }).click(); await expect(admin.getByRole('button', { name: '刷新', exact: true })).toBeEnabled(); }
  async function operation(path: string, click: () => Promise<void>) {
    const response = admin.waitForResponse(row => new URL(row.url()).pathname === path && ['POST', 'PATCH'].includes(row.request().method()));
    await click(); const received = await response; assert.ok([200, 201].includes(received.status()));
    await expect(admin.getByRole('button', { name: '刷新', exact: true })).toBeEnabled(); return received.json();
  }
  let planId = '';
  async function grant(index: number, workspaceId: string, status = 'active', expiry = Date.now() + 86400000) {
    await nav('企业客户'); await search(accounts[index]);
    await admin.getByRole('row').filter({ hasText: workspaceId }).getByRole('button', { name: '管理', exact: true }).click();
    await admin.locator('select[name=status]').selectOption(status); await admin.locator('select[name=planVersionId]').selectOption(planId);
    await admin.getByLabel('生效时间', { exact: true }).fill(localDate(Date.now() - 86400000));
    await admin.getByLabel('到期时间', { exact: true }).fill(localDate(expiry));
    await admin.getByLabel('操作原因', { exact: true }).fill(`仅合成注册验收 ${status}`);
    await operation(`/api/platform/v1/enterprises/${workspaceId}`, () => admin.getByRole('button', { name: '保存', exact: true }).click());
  }
  async function customerWrite(page: Page, company: string, expected: number) {
    await page.goto(`${origin}/#private-domain`); await page.getByRole('button', { name: '添加客户', exact: true }).click();
    await page.getByLabel('客户 / 公司名称', { exact: true }).fill(company);
    await page.getByLabel('联系人', { exact: true }).fill('合成联系人');
    const response = page.waitForResponse(row => new URL(row.url()).pathname === '/api/customers' && row.request().method() === 'POST');
    await page.locator('[data-private-domain-form=customer]').getByRole('button', { name: '保存', exact: true }).click();
    assert.equal((await response).status(), expected);
  }
  // Stable lifecycle selectors are shared with the client session controller.
  const lifecycle = (page: Page) => page.locator('[data-account-access-panel]');
  async function statusVisible(page: Page, code: string) {
    const headings: Record<string, string> = { workspace_pending: '账号已注册，等待运营开通', workspace_suspended: '企业使用权限已暂停', subscription_expired: '企业授权已到期，当前仅可查看' };
    await expect(lifecycle(page)).toBeVisible(); await expect(lifecycle(page).getByRole('heading', { level: 1 })).toHaveText(headings[code]);
    await expect(page.locator('body')).toHaveAttribute('data-account-access', code === 'subscription_expired' ? 'readonly' : 'blocked');
  }
  async function invalidated(page: Page) {
    const refresh = page.locator('[data-account-access-action=refresh]');
    if (await refresh.isVisible()) await refresh.click(); else await page.reload();
    await expect(page.locator('#loginForm')).toBeVisible(); await expect(page.locator('#loginError')).toContainText(/重新登录|失效|权限/);
  }

  stage = 'registration_pending';
  const first = await registration(0);
  await statusVisible(clients[0], 'workspace_pending');
  assert.equal((await request(clients[0], '/api/customers')).body.code, 'workspace_pending');
  await shot(clients[0], 'registration-pending.png'); checks.push('registration_ui_creates_persisted_pending_enterprise');
  stage = 'operator_search_and_grant';
  await admin.goto(`${origin}/admin.html`);
  await admin.getByLabel('账号', { exact: true }).fill('preview_ops'); await admin.getByLabel('密码', { exact: true }).fill(cfg.operatorPassword);
  const counter = (await state()).memberships.find((row: any) => row.userId === cfg.operatorId).lastOtpCounter;
  const stamp = Math.max(Date.now(), (counter + 1) * 30000);
  if (stamp > Date.now() + 29000) await new Promise(resolve => setTimeout(resolve, stamp - Date.now() - 29000));
  await admin.getByLabel('身份验证器验证码').fill(new TOTP({ secret: Secret.fromBase32(cfg.totpSecret) }).generate({ timestamp: stamp }));
  await admin.getByRole('button', { name: '验证并进入' }).click(); await expect(admin.getByRole('button', { name: '创建企业', exact: true })).toBeVisible();
  await search(accounts[0]); await expect(admin.getByRole('table')).toContainText(first.workspaceId);
  await nav('账号'); await search(accounts[0]); await expect(admin.getByRole('table')).toContainText(`${accounts[0]}@shensi.local`);
  await nav('套餐授权'); await admin.getByRole('button', { name: '配置套餐版本' }).click();
  await admin.locator('select[name=code]').selectOption('trial');
  for (const feature of ['获客中心', '智能体中心', '星盘决策模拟', '客户管理', '经营管理', '社媒外联']) await admin.getByLabel(feature, { exact: true }).check();
  await admin.getByLabel('席位数').fill('2'); await admin.getByLabel('标准有效天数').fill('7'); await admin.getByLabel('发布此版本').check();
  await admin.getByLabel('操作原因', { exact: true }).fill('仅合成注册验收套餐，不是真实商业配置');
  planId = (await operation('/api/platform/v1/plans', () => admin.getByRole('button', { name: '保存', exact: true }).click())).id;
  await grant(0, first.workspaceId); await invalidated(clients[0]); await shot(clients[0], 'registration-grant-reauth.png');
  checks.push('operator_finds_registration_grant_requires_reauthentication');
  stage = 'customer_business_write'; assert.equal(await login(0), 200);
  const customerName = `注册验收客户-${suffix}`;
  await customerWrite(clients[0], customerName, 200);
  const [[customer]] = await pool.query('SELECT id,team_id,owner_id FROM customers WHERE company=?', [customerName]);
  assert.equal(customer.team_id, first.workspaceId); assert.equal(customer.owner_id, first.userId);
  await shot(clients[0], 'registration-customer-business.png'); checks.push('registered_customer_ui_write_committed_mysql');
  stage = 'suspension'; await grant(0, first.workspaceId, 'suspended'); await invalidated(clients[0]); assert.equal(await login(0), 200);
  await statusVisible(clients[0], 'workspace_suspended'); assert.equal((await request(clients[0], '/api/customers')).body.code, 'workspace_suspended');
  await shot(clients[0], 'registration-suspended.png'); checks.push('suspended_enterprise_visible_and_execution_denied');
  stage = 'expiry'; await grant(0, first.workspaceId, 'active', Date.now() - 60000); assert.equal(await login(0), 200);
  await statusVisible(clients[0], 'subscription_expired'); assert.equal((await request(clients[0], '/api/customers')).status, 200);
  const deniedName = `expired-must-not-exist-${suffix}`;
  assert.equal((await request(clients[0], '/api/customers', 'POST', { company: deniedName })).body.code, 'subscription_expired');
  await shot(clients[0], 'registration-expired.png');
  const [[denied]] = await pool.query('SELECT COUNT(*) total FROM customers WHERE company=?', [deniedName]); assert.equal(denied.total, 0);
  checks.push('expiry_visible_retained_read_execution_denied');
  stage = 'renewal'; await grant(0, first.workspaceId); await invalidated(clients[0]); assert.equal(await login(0), 200);
  const renewedName = `续期注册客户-${suffix}`; await customerWrite(clients[0], renewedName, 200);
  const [[renewed]] = await pool.query('SELECT team_id FROM customers WHERE company=?', [renewedName]); assert.equal(renewed.team_id, first.workspaceId);
  checks.push('renewal_restores_registered_customer_writes');
  stage = 'account_disable_restore'; await nav('账号'); await search(accounts[0]);
  const accountRow = admin.getByRole('row').filter({ hasText: `${accounts[0]}@shensi.local` });
  async function accountAction(action: string) { await accountRow.locator('input[name=reason]').fill(`仅合成注册验收${action}`); await operation(`/api/platform/v1/accounts/${first.userId}`, () => accountRow.getByRole('button', { name: action, exact: true }).click()); }
  await accountAction('停用'); await invalidated(clients[0]); assert.notEqual(await login(0), 200);
  await expect(clients[0].locator('#loginError')).toContainText(/停用|禁用/); await shot(clients[0], 'registration-disabled.png');
  await accountAction('恢复'); assert.equal(await login(0), 200); assert.equal((await request(clients[0], '/api/customers')).status, 200);
  checks.push('disabled_login_feedback_and_restore');
  stage = 'second_tenant_isolation'; const second = await registration(1); await statusVisible(clients[1], 'workspace_pending');
  assert.notEqual(second.workspaceId, first.workspaceId); await grant(1, second.workspaceId); assert.equal(await login(1), 200);
  const secondRead = await request(clients[1], '/api/customers'); assert.equal(secondRead.status, 200);
  assert.ok(!JSON.stringify(secondRead.body).includes(customer.id)); assert.ok(!JSON.stringify(secondRead.body).includes(customerName));
  const crossWrite = await request(clients[1], `/api/customers/${customer.id}`, 'PATCH', { company: `cross-tenant-must-not-write-${suffix}` });
  assert.ok([403, 404].includes(crossWrite.status));
  const [[unchanged]] = await pool.query('SELECT company,team_id FROM customers WHERE id=?', [customer.id]); assert.equal(unchanged.company, customerName); assert.equal(unchanged.team_id, first.workspaceId);
  await clients[1].goto(`${origin}/#private-domain`); await expect(clients[1].getByText(customerName, { exact: true })).toHaveCount(0);
  await shot(clients[1], 'registration-second-tenant.png'); checks.push('independently_registered_active_tenant_cannot_read_or_modify_first_tenant');
  assert.deepEqual(errors, []); result.passed = true;
  await writeFile(join(runtime, 'registration-credentials.json'), JSON.stringify({ accounts, passwords, enterprises: [first, second] }), { mode: 0o600 });
} catch (error) {
  result.failedStage = stage; result.errorType = error instanceof Error ? error.name : 'UnknownError'; process.exitCode = 1;
} finally {
  await browser?.close(); await pool?.end();
  // No exception messages, response bodies, passwords or session material in artifacts.
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  await writeFile(join(artifacts, 'registration-result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
