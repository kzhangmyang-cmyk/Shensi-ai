import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { LocalApplicationRuntime } from '../src/main/local-application-runtime.ts';
import { LOCAL_BACKEND_SECRET_NAMES, type LocalInstallationSecrets } from '../src/main/local-installation-secrets.ts';

test('single-machine runtime rejects missing build identity before launching services', () => {
  assert.throws(() => new LocalApplicationRuntime({ buildDigest: '' } as never), /build_identity_invalid/);
});

test('runtime refuses invalid customer account before any database initialization', () => {
  const secret = () => randomBytes(32).toString('hex');
  assert.throws(() => new LocalApplicationRuntime({ databaseDirectory: '/unused', knowledgeDirectory: '/unused/knowledge', mysqlRuntimeDirectory: '/unused',
    nodeExecutable: process.execPath, backendEntrypoint: '/unused', port: 5000, buildDigest: secret(),
    secrets: { version: 1, mysqlRootPassword: secret(), mysqlAppPassword: secret(), bootstrapPassword: secret(),
      backend: {} as LocalInstallationSecrets['backend'] },
    initialAccount: { account: '', password: 'short' } }), /local_initial_account_invalid/);
});

test('runtime requires a Main-provided absolute knowledge directory', () => {
  assert.throws(() => new LocalApplicationRuntime({ buildDigest: 'a'.repeat(64), knowledgeDirectory: 'relative' } as never), /knowledge_directory_invalid/);
});

test('runtime rejects an invalid embedded pack before initializing a database', () => {
  const secret = () => randomBytes(32).toString('hex');
  assert.throws(() => new LocalApplicationRuntime({ databaseDirectory: '/unused', knowledgeDirectory: '/unused/knowledge',
    mysqlRuntimeDirectory: '/unused', nodeExecutable: process.execPath, backendEntrypoint: '/unused', port: 5000,
    buildDigest: secret(), secrets: { version: 1, mysqlRootPassword: secret(), mysqlAppPassword: secret(),
      bootstrapPassword: secret(), backend: {} as LocalInstallationSecrets['backend'] },
    embeddedReference: { path: '../books.json.gz', sha256: 'a'.repeat(64) } } as never), /embedded_reference_pack_invalid/);
});

test('product database and backend lifecycle supports login, persisted API write and complete restart',
  { skip: !process.env.SHENSI_TEST_MYSQL_RUNTIME }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'shensi-app-runtime-')));
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    await new Promise<void>(resolve => server.close(() => resolve()));
    const secret = () => randomBytes(32).toString('hex');
    const secrets: LocalInstallationSecrets = { version: 1, mysqlRootPassword: secret(), mysqlAppPassword: secret(),
      bootstrapPassword: secret(), backend: Object.fromEntries(LOCAL_BACKEND_SECRET_NAMES.map(name => [name, secret()])) as LocalInstallationSecrets['backend'] };
    const digest = secret();
    const customerPassword = 'synthetic-customer-password-123';
  const runtimeOptions = { databaseDirectory: join(root, 'database'), knowledgeDirectory: join(root, 'knowledge'),
      mysqlRuntimeDirectory: process.env.SHENSI_TEST_MYSQL_RUNTIME!, nodeExecutable: process.env.SHENSI_TEST_NODE_EXECUTABLE || process.execPath,
      backendEntrypoint: process.env.SHENSI_TEST_BACKEND_ENTRYPOINT || fileURLToPath(new URL('../../backend/dist/server.js', import.meta.url)),
      port: address.port, buildDigest: digest, secrets };
    let runtime = new LocalApplicationRuntime({ ...runtimeOptions,
      initialAccount: { account: 'customer_test', password: customerPassword } });
    t.after(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
    assert.throws(() => runtime.origin, /not_ready/);
    await runtime.start();
    async function login() {
      const response = await fetch(`${runtime.origin}/api/auth/login`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: runtime.origin, 'X-Shensi-Desktop-Build-Manifest-SHA256': digest },
        body: JSON.stringify({ email: 'customer_test', password: customerPassword }) });
      assert.equal(response.status, 200);
      const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const csrf = cookie.split('; ').find(value => value.startsWith('gj_csrf='))!.slice(8);
      return { Cookie: cookie, 'x-csrf-token': decodeURIComponent(csrf), Origin: runtime.origin,
        'Content-Type': 'application/json', 'X-Shensi-Desktop-Build-Manifest-SHA256': digest };
    }
    const headers = await login();
    async function assertBusinessWorkspace(authHeaders: Record<string, string>) {
      const result = await fetch(`${runtime.origin}/api/v1/growth/bootstrap`, { headers: authHeaders });
      assert.equal(result.status, 200);
      const bootstrap = await result.json();
      assert.equal(bootstrap.status, 'ready', 'first standalone customer must have a usable business workspace');
      assert.ok(bootstrap.workspaceId && bootstrap.workspaceId !== 'all');
      return bootstrap.workspaceId;
    }
    const workspaceId = await assertBusinessWorkspace(headers);
    const financeHeaders = { ...headers, 'X-Workspace-Id': workspaceId, 'Idempotency-Key': 'standalone-finance-preview' };
    const csv = 'externalId,factType,amount,currency,businessOccurredAt,provenance,status\nstandalone-fact,revenue_recognized,1000.00,CNY,2026-08-09,portal_export,pending';
    const preview = await fetch(`${runtime.origin}/api/v1/finance/imports/preview`, { method: 'POST', headers: financeHeaders,
      body: JSON.stringify({ kind: 'financial_fact', fileName: 'synthetic.csv', mediaType: 'text/csv',
        contentBase64: Buffer.from(csv).toString('base64'), mapping: { externalId: 'externalId', factType: 'factType',
          amount: 'amount', currency: 'currency', businessOccurredAt: 'businessOccurredAt', provenance: 'provenance', status: 'status' } }) });
    assert.equal(preview.status, 200, 'real financial import preview');
    const previewBody = await preview.json();
    assert.equal(previewBody.acceptedRows, 1);
    assert.equal(previewBody.rejectedRows, 0);
    const committedImport = await fetch(`${runtime.origin}/api/v1/finance/imports/${previewBody.previewId}/commit`, {
      method: 'POST', headers: { ...financeHeaders, 'Idempotency-Key': 'standalone-finance-commit' }, body: '{}' });
    assert.equal(committedImport.status, 202);
    const importId = (await committedImport.json()).id;
    const customerResponse = await fetch(`${runtime.origin}/api/customers`, { method: 'POST', headers,
      body: JSON.stringify({ company: '单机合成客户', country: '中国', contact: '合成联系人' }) });
    assert.equal(customerResponse.status, 200);
    const customerId = (await customerResponse.json()).customer.id;
    const activity = await fetch(`${runtime.origin}/api/customers/${customerId}/activities`, { method: 'POST', headers,
      body: JSON.stringify({ type: 'note', content: '单机离线业务验收记录' }) });
    assert.equal(activity.status, 200);
    const created = await fetch(`${runtime.origin}/api/todos`, { method: 'POST', headers,
      body: JSON.stringify({ title: '完整单机运行链路', type: 'customer', customerId }) });
    assert.equal(created.status, 200); const id = (await created.json()).todo.id;
    const completed = await fetch(`${runtime.origin}/api/todos/${id}/complete`, { method: 'POST', headers,
      body: JSON.stringify({ completionResult: '已核对合成客户' }) });
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).todo.done, true);
    await runtime.stop(); assert.throws(() => runtime.origin, /not_ready/);
    runtime = new LocalApplicationRuntime(runtimeOptions);
    await runtime.start();
    assert.equal(await assertBusinessWorkspace(await login()), workspaceId);
    const importRead = await fetch(`${runtime.origin}/api/v1/finance/imports/${importId}`, {
      headers: { ...await login(), 'X-Workspace-Id': workspaceId } });
    assert.equal(importRead.status, 200);
    const persistedImport = await importRead.json();
    assert.equal(persistedImport.id, importId);
    assert.equal(persistedImport.acceptedRows, 1);
    assert.equal(persistedImport.status, 'succeeded');
    const factsResponse = await fetch(`${runtime.origin}/api/v1/finance/facts`, {
      headers: { ...await login(), 'X-Workspace-Id': workspaceId } });
    assert.equal(factsResponse.status, 200);
    const importedFact = (await factsResponse.json()).items.find((item: { externalId: string }) => item.externalId === 'standalone-fact');
    assert.ok(importedFact, 'successful import must be visible in the financial facts API after restart');
    assert.equal(importedFact.amountMinor, 100000);
    assert.equal(importedFact.currency, 'CNY');
    console.log(JSON.stringify({ financePreview: 'accepted', persistedImportStatus: persistedImport.status }));
    const response = await fetch(`${runtime.origin}/api/todos`, { headers: await login() });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).todos.some((todo: { id: string; customerId: string; done: boolean }) => todo.id === id && todo.customerId === customerId && todo.done));
    const customerRead = await fetch(`${runtime.origin}/api/customers`, { headers: await login() });
    assert.equal(customerRead.status, 200);
    const persistedCustomer = (await customerRead.json()).customers.find((item: { id: string }) => item.id === customerId);
    assert.ok(persistedCustomer, 'created customer persists after complete runtime restart');
    assert.equal(persistedCustomer.company, '单机合成客户');
    assert.ok(persistedCustomer.activities.some((item: { content: string }) => item.content === '单机离线业务验收记录'));
    const bootstrapLogin = await fetch(`${runtime.origin}/api/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: runtime.origin, 'X-Shensi-Desktop-Build-Manifest-SHA256': digest },
      body: JSON.stringify({ email: 'bootstrap@shensi.local', password: secrets.bootstrapPassword }) });
    assert.equal(bootstrapLogin.status, 401);
  });
