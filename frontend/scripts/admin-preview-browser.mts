import { chromium, expect, type Page } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import assert from 'node:assert/strict';

// Real browser + dedicated real MySQL; never accepts a caller-supplied database URL.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = join(root, '.runtime/admin-preview');
const cfg = JSON.parse(await readFile(join(runtime, 'config.json'), 'utf8'));
assert.equal(cfg.database, 'shensi_admin_preview');
assert.match(cfg.name, /^shensi-admin-preview-[a-f0-9]{24}$/);
const requireBackend = createRequire(join(root, 'backend/package.json'));
const mysql = requireBackend('mysql2/promise');
const { TOTP, Secret } = requireBackend('otpauth');
const pool = mysql.createPool({ host: '127.0.0.1', port: cfg.mysqlPort, user: 'root', password: cfg.databasePassword, database: cfg.database });
const [[db]] = await pool.query('SELECT DATABASE() name'); assert.equal(db.name, cfg.database);
const origin = 'http://localhost:5681';
const suffix = Date.now().toString(36), enterprise = `合成验收企业-${suffix}`, account = `client_${suffix}`, member = `member_${suffix}`;
const password = randomBytes(18).toString('base64url'), nextPassword = randomBytes(18).toString('base64url');
const artifacts = join(runtime, 'artifacts'); await mkdir(artifacts, { recursive: true, mode: 0o700 });
const evidence: Record<string, unknown> = { syntheticOnly: true, database: cfg.database, enterprise, account, member, checks: [] };
const checks = evidence.checks as string[];
const browser = await chromium.launch();
const opsContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const clientContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const admin = await opsContext.newPage(), client = await clientContext.newPage();
const pageErrors: string[] = []; for (const page of [admin, client]) page.on('pageerror', error => pageErrors.push(error.name));
async function state() { const [[row]] = await pool.query('SELECT payload FROM platform_administration_state WHERE id=1'); return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; }
async function nav(label: string) { await admin.getByRole('navigation').getByRole('button', { name: label, exact: true }).click(); await expect(admin.getByRole('heading', { level: 1 })).toHaveText(label); }
async function operation(path: string, click: () => Promise<void>) {
  const received = admin.waitForResponse(r => new URL(r.url()).pathname === path && ['POST', 'PATCH'].includes(r.request().method()));
  await click(); const response = await received;
  assert.ok(response.status() === 200 || response.status() === 201, `${path}: ${response.status()} ${(await response.json()).message ?? ''}`);
  await expect(admin.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  return response.json();
}
const localDate = (stamp: number) => new Date(stamp - new Date(stamp).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
let workspaceId = '', planId = '', memberId = '';
async function grant(status = 'active', expiry = Date.now() + 86400000) {
  await nav('企业客户');
  await admin.getByRole('row').filter({ hasText: enterprise }).getByRole('button', { name: '管理', exact: true }).click();
  await admin.locator('select[name=status]').selectOption(status);
  await admin.locator('select[name=planVersionId]').selectOption(planId);
  await admin.getByLabel('生效时间', { exact: true }).fill(localDate(Date.now() - 86400000));
  await admin.getByLabel('到期时间', { exact: true }).fill(localDate(expiry));
  await admin.getByLabel('操作原因', { exact: true }).fill(`合成验收 ${status} ${expiry < Date.now() ? '到期' : '续期'}`);
  await operation(`/api/platform/v1/enterprises/${workspaceId}`, () => admin.getByRole('button', { name: '保存', exact: true }).click());
}
async function clientLogin(login = member, pass = password) {
  await clientContext.clearCookies();
  await client.goto(origin);
  await client.locator('#loginEmail').fill(login); await client.locator('#loginPassword').fill(pass);
  const response = client.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/login');
  await client.locator('#loginForm button[type=submit]').click();
  return (await response).status();
}
async function clientRequest(path: string, method = 'GET', body?: unknown) {
  return client.evaluate(async ({ path, method, body }) => {
    const csrf = document.cookie.split(';').map(p => p.trim()).find(p => p.startsWith('gj_csrf='))?.slice(8) ?? '';
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
}
try {
  await admin.goto(`${origin}/admin.html`);
  await admin.getByLabel('账号', { exact: true }).fill('preview_ops'); await admin.getByLabel('密码', { exact: true }).fill(cfg.operatorPassword);
  const lastCounter = (await state()).memberships.find((row: any) => row.userId === cfg.operatorId).lastOtpCounter;
  const otpTime = Math.max(Date.now(), (lastCounter + 1) * 30000);
  if (otpTime > Date.now() + 30000) await new Promise(r => setTimeout(r, otpTime - Date.now() - 29000));
  await admin.getByLabel('身份验证器验证码').fill(new TOTP({ secret: Secret.fromBase32(cfg.totpSecret) }).generate({ timestamp: otpTime }));
  await admin.getByRole('button', { name: '验证并进入' }).click(); await expect(admin.getByRole('button', { name: '创建企业', exact: true })).toBeVisible();
  checks.push('browser_password_and_mfa_login');
  await admin.getByRole('button', { name: '创建企业', exact: true }).click();
  for (const [label, value] of [['企业名称', enterprise], ['联系人', '合成联系人'], ['管理员账号', account], ['初始密码', password], ['操作原因', '合成浏览器创建企业']]) await admin.getByLabel(label, { exact: true }).fill(value);
  workspaceId = (await operation('/api/platform/v1/enterprises', () => admin.getByRole('button', { name: '保存', exact: true }).click())).id;
  assert.equal((await state()).workspaces.find((row: any) => row.id === workspaceId).status, 'pending');
  checks.push('create_enterprise_committed_mysql');
  await nav('账号'); await admin.getByRole('button', { name: '创建账号', exact: true }).click();
  await admin.getByLabel('搜索所属企业').fill(enterprise);
  await expect(admin.locator('select[name=workspaceId]').locator(`option[value="${workspaceId}"]`)).toBeAttached();
  await admin.locator('select[name=workspaceId]').selectOption(workspaceId);
  for (const [label, value] of [['成员姓名', '合成成员'], ['登录账号', member], ['初始密码', password], ['操作原因', '合成待开通成员创建']]) await admin.getByLabel(label, { exact: true }).fill(value);
  memberId = (await operation('/api/platform/v1/accounts', () => admin.getByRole('button', { name: '保存', exact: true }).click())).id;
  const [[memberRow]] = await pool.query('SELECT id,team_id FROM users WHERE id=?', [memberId]); assert.equal(memberRow.team_id, workspaceId);
  assert.equal(await clientLogin(), 200); assert.equal((await clientRequest('/api/customers')).body.code, 'workspace_pending');
  checks.push('create_member_before_grant_and_pending_denied');
  await nav('套餐授权'); await admin.getByRole('button', { name: '配置套餐版本' }).click();
  await admin.locator('select[name=code]').selectOption('trial');
  for (const feature of ['获客中心', '智能体中心', '星盘决策模拟', '客户管理', '经营管理', '社媒外联']) await admin.getByLabel(feature, { exact: true }).check();
  await admin.getByLabel('席位数').fill('2'); await admin.getByLabel('标准有效天数').fill('7'); await admin.getByLabel('发布此版本').check(); await admin.getByLabel('操作原因', { exact: true }).fill('仅隔离验收：全部模块、2席位、7天，不是真实商业配置');
  planId = (await operation('/api/platform/v1/plans', () => admin.getByRole('button', { name: '保存', exact: true }).click())).id;
  await grant();
  await nav('账号'); await admin.getByRole('button', { name: '创建账号', exact: true }).click();
  await admin.getByLabel('搜索所属企业').fill(enterprise); await admin.locator('select[name=workspaceId]').selectOption(workspaceId);
  for (const [label, value] of [['成员姓名', '超额合成成员'], ['登录账号', `extra_${suffix}`], ['初始密码', password], ['操作原因', '合成席位上限验收']]) await admin.getByLabel(label, { exact: true }).fill(value);
  const seatResponse = admin.waitForResponse(r => new URL(r.url()).pathname === '/api/platform/v1/accounts' && r.request().method() === 'POST');
  await admin.getByRole('button', { name: '保存', exact: true }).click(); assert.equal((await seatResponse).status(), 409);
  await expect(admin.getByRole('alert')).toContainText('席位'); await expect(admin.getByLabel('登录账号', { exact: true })).toHaveValue(`extra_${suffix}`);
  await admin.getByRole('button', { name: '取消', exact: true }).click();
  checks.push('seat_limit_business_reason_and_form_preserved');
  assert.equal(await clientLogin(), 200);
  await client.goto(`${origin}/#private-domain`);
  await client.getByRole('button', { name: '添加客户', exact: true }).click();
  const customerName = `合成业务客户-${suffix}`;
  await client.getByLabel('客户 / 公司名称', { exact: true }).fill(customerName);
  await client.getByLabel('联系人', { exact: true }).fill('合成客户联系人');
  const customerResponse = client.waitForResponse(r => new URL(r.url()).pathname === '/api/customers' && r.request().method() === 'POST');
  await client.locator('[data-private-domain-form=customer]').getByRole('button', { name: '保存', exact: true }).click();
  assert.equal((await customerResponse).status(), 200);
  await expect(client.getByText(customerName, { exact: true }).first()).toBeVisible();
  const [[business]] = await pool.query('SELECT team_id,owner_id FROM customers WHERE company=?', [customerName]); assert.equal(business.team_id, workspaceId); assert.equal(business.owner_id, memberId);
  await client.screenshot({ path: join(artifacts, 'customer-business.png') });
  checks.push('grant_login_customer_ui_write_committed_mysql');
  await nav('账号');
  async function accountAction(action: string) { const row = admin.getByRole('row').filter({ hasText: `${member}@shensi.local` }); await row.locator('input[name=reason]').fill(`合成验收${action}`); return operation(`/api/platform/v1/accounts/${memberId}`, () => row.getByRole('button', { name: action, exact: true }).click()); }
  await accountAction('停用'); assert.equal((await clientRequest('/api/auth/me')).status, 401); assert.notEqual(await clientLogin(), 200);
  await accountAction('恢复'); assert.equal(await clientLogin(), 200); checks.push('disable_restore_browser_and_session_revocation');
  await grant('suspended'); assert.equal(await clientLogin(), 200); assert.equal((await clientRequest('/api/customers')).body.code, 'workspace_suspended');
  await grant('active', Date.now() - 60000); assert.equal(await clientLogin(), 200);
  assert.equal((await clientRequest('/api/customers')).status, 200);
  assert.equal((await clientRequest('/api/customers', 'POST', { company: 'must_not_create_expired' })).body.code, 'subscription_expired');
  await client.goto(`${origin}/#private-domain`); await client.getByRole('button', { name: '添加客户', exact: true }).click();
  await client.getByLabel('客户 / 公司名称', { exact: true }).fill('must_not_create_expired_ui');
  const expiredResponse = client.waitForResponse(r => new URL(r.url()).pathname === '/api/customers' && r.request().method() === 'POST');
  await client.locator('[data-private-domain-form=customer]').getByRole('button', { name: '保存', exact: true }).click(); assert.equal((await expiredResponse).status(), 403);
  await expect(client.locator('[data-private-domain-form=customer] [role=alert]')).toBeVisible(); await client.screenshot({ path: join(artifacts, 'expired-write-denied.png') });
  checks.push('workspace_suspend_expiry_retained_read_and_ui_write_denied');
  await grant(); assert.equal(await clientLogin(), 200); assert.equal((await clientRequest('/api/customers', 'POST', { company: `续期合成客户-${suffix}` })).status, 200);
  checks.push('renewal_restores_execution');
  await nav('账号'); const row = admin.getByRole('row').filter({ hasText: `${member}@shensi.local` }); await row.locator('input[name=reason]').fill('合成一次性密码恢复');
  await operation(`/api/platform/v1/accounts/${memberId}/password-reset`, () => row.getByRole('button', { name: '密码恢复', exact: true }).click());
  const token = await admin.getByLabel('恢复凭证', { exact: true }).inputValue(); assert.equal((await clientRequest('/api/auth/me')).status, 401);
  assert.ok(!JSON.stringify(await state()).includes(token));
  const reset = await clientContext.newPage(); await reset.goto(`${origin}/admin.html#reset`);
  await reset.getByLabel('一次性恢复凭证', { exact: true }).fill(token); await reset.getByLabel('新密码', { exact: true }).fill(nextPassword); await reset.getByLabel('确认新密码', { exact: true }).fill(nextPassword); await reset.getByRole('button', { name: '更新密码' }).click();
  await expect(reset.getByRole('status')).toContainText('密码已更新');
  assert.equal((await clientRequest('/api/auth/reset-password', 'POST', { token, password: nextPassword })).status, 400);
  assert.notEqual(await clientLogin(member, password), 200); assert.equal(await clientLogin(member, nextPassword), 200);
  await admin.getByRole('button', { name: '已保存，关闭凭证' }).click(); await expect(admin.getByLabel('恢复凭证', { exact: true })).toHaveCount(0);
  checks.push('single_use_password_recovery_real_browser_and_replay_rejected');
  await nav('操作日志'); await admin.getByRole('textbox', { name: '搜索操作日志' }).fill(memberId); await admin.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(admin.getByRole('table')).toContainText('consume_password_reset'); await admin.screenshot({ path: join(artifacts, 'audit-query.png') });
  checks.push('audit_query_matches_persisted_recovery');
  await admin.getByRole('textbox', { name: '搜索操作日志' }).fill(''); await admin.getByRole('button', { name: '搜索', exact: true }).click(); await nav('企业客户');
  await admin.screenshot({ path: join(artifacts, 'admin-enterprises.png') });
  await admin.setViewportSize({ width: 390, height: 844 });
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await admin.screenshot({ path: join(artifacts, 'admin-mobile.png') });
  await writeFile(join(runtime, 'acceptance-credentials.json'), JSON.stringify({ account, member, password, memberPassword: nextPassword, enterprise, workspaceId, memberId }), { mode: 0o600 });
  await writeFile(join(runtime, 'operator-before-recovery.json'), JSON.stringify(await opsContext.storageState()), { mode: 0o600 });
  assert.deepEqual(pageErrors, []); evidence.passed = true;
  console.log(JSON.stringify(evidence));
} catch (error) {
  await admin.screenshot({ path: join(artifacts, 'failure-admin.png'), mask: [admin.locator('input[type=password],input[readonly],input[name=code]')] }).catch(() => {}); await client.screenshot({ path: join(artifacts, 'failure-client.png'), mask: [client.locator('input[type=password]')] }).catch(() => {});
  let message = error instanceof Error ? error.message : 'acceptance_failed';
  if (checks.length < 3) console.error('Workspace options: ' + JSON.stringify(await admin.locator('select[name=workspaceId] option').allTextContents()));
  for (const secret of [cfg.operatorPassword, password, nextPassword]) message = message.replaceAll(secret, '[redacted]');
  console.error(message.replace(/[A-Za-z0-9_-]{43}/g, '[redacted]')); process.exitCode = 1;
} finally {
  await writeFile(join(artifacts, 'browser-result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 }); await browser.close(); await pool.end();
}
