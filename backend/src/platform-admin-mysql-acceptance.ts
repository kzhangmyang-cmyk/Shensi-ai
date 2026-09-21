import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// This runner never accepts a database URL: it creates and owns its whole target.
let stage = 'preflight';
async function main() {
  if (process.env.SHENSI_ADMIN_SYNTHETIC_ACCEPTANCE !== '1') throw new Error('explicit_synthetic_acceptance_required');
  if (!process.env.DOCKER_HOST) throw new Error('explicit_docker_host_required');
  const nonce = randomUUID(), name = `shensi-admin-accept-${nonce}`;
  const password = randomBytes(32).toString('hex');
  const env = { ...process.env, MYSQL_ROOT_PASSWORD: password, MYSQL_PWD: password };
  const docker = (args: string[], input?: Buffer) => execFileSync('docker', args, { env, input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  const directory = await mkdtemp(join(tmpdir(), 'shensi-admin-synthetic-'));
  let owned = false;
  let store: Awaited<ReturnType<typeof import('./mysql-store.js').createMysqlStore>> | undefined;
  let pool: import('mysql2/promise').Pool | undefined;
  try {
    docker(['run', '-d', '--name', name, '--label', `shensi.admin.synthetic=${nonce}`, '--mount', 'type=volume,target=/var/lib/mysql', '-p', '127.0.0.1::3306', '-e', 'MYSQL_ROOT_PASSWORD', '-e', 'MYSQL_DATABASE=shensi_admin_synthetic', 'mysql:8.4.11']);
    owned = true;
    const portText = docker(['port', name, '3306/tcp']).toString().trim();
    assert.match(portText, /^127\.0\.0\.1:\d+$/);
    const port = Number(portText.split(':').at(-1));
    process.env.NODE_ENV = 'production';
    process.env.CRM_SEED_DEVELOPMENT_DATA = 'false';
    process.env.INITIAL_ADMIN_EMAIL = 'synthetic-bootstrap@example.test';
    process.env.INITIAL_ADMIN_PASSWORD = randomBytes(32).toString('hex');
    process.env.MYSQL_SSL_MODE = 'disabled';
    process.env.DATABASE_URL = `mysql://root:${password}@127.0.0.1:${port}/shensi_admin_synthetic`;
    delete process.env.MYSQL_URL;
    for (const key of ['JWT_SECRET', 'PROVIDER_CREDENTIAL_KEY', 'AGENT_JOB_ENCRYPTION_KEY', 'ACQUISITION_MASTER_SECRET', 'ORGANIZATION_IDENTITY_MASTER_SECRET', 'PROSPECT_SOURCE_RAW_ENVELOPE_SECRET', 'PROSPECT_COVERAGE_MASTER_SECRET']) process.env[key] = randomBytes(32).toString('hex');
    const mysql = await import('mysql2/promise');
    pool = mysql.createPool(process.env.DATABASE_URL);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await pool.query('SELECT 1'); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    assert.ok(ready, 'synthetic_mysql_not_ready');
    const { createMysqlStore } = await import('./mysql-store.js');
    const { hashPassword, publicUser } = await import('./auth.js');
    const { TOTP } = await import('otpauth');
    const { bootstrapPlatformOwner, createPlatformEnterprise, platformState, savePlatformPlan, updatePlatformEnterprise, platformAccountAccess } = await import('./platform-admin-service.js');
    const { createAccount, updateAccountAccess } = await import('./account-command.js');
    const { evaluatePlatformAccess } = await import('./platform-admin-domain.js');
    stage = 'create_store';
    store = await createMysqlStore({ processRole: 'api' });
    const owner = { id: `synthetic_${randomUUID()}`, name: 'Synthetic operator', email: 'operator@example.test', password: await hashPassword('synthetic-password'), role: 'admin' as const, teamId: `operator_${randomUUID()}`, avatar: 'SO', status: 'active' as const, authVersion: 1 };
    store.users.push(owner); await store.persist();
    stage = 'bootstrap';
    await bootstrapPlatformOwner(store, owner.id, new TOTP().secret.base32);
    stage = 'lifecycle';
    const enterprise = await createPlatformEnterprise(store, owner.id, platformState(store).revision, { name: 'Synthetic enterprise', contact: '', account: 'synthetic_client', password: 'synthetic-password' }, 'synthetic acceptance');
    const customer = store.users.find(user => user.teamId === enterprise.id)!;
    const plan = await savePlatformPlan(store, owner.id, platformState(store).revision, { code: 'trial', features: ['crm', 'agents'], seatLimit: 2, durationDays: 7, published: true }, 'synthetic plan');
    const grant = { status: 'active', planVersionId: plan.id, startsAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
    await updatePlatformEnterprise(store, owner.id, platformState(store).revision, enterprise.id, grant, 'synthetic grant');
    await platformAccountAccess(store, owner.id, platformState(store).revision, customer.id, 'disable', 'synthetic disable');
    await platformAccountAccess(store, owner.id, platformState(store).revision, customer.id, 'enable', 'synthetic restore');
    assert.equal(customer.authVersion, 4);
    const retained = JSON.stringify(platformState(store));
    stage = 'restart';
    await store.close?.(); store = await createMysqlStore({ processRole: 'api' });
    assert.deepEqual(platformState(store), JSON.parse(retained));
    assert.equal(store.users.find(user => user.id === customer.id)?.authVersion, 4);
    assert.equal(evaluatePlatformAccess(await store.readPlatformAdminState!(), enterprise.id, 'acquisition', 'execute', Date.now()).allowed, false);
    // Fail the audit INSERT in the real database and prove the user write rolls back.
    stage = 'rollback';
    const member = await createAccount(store, publicUser(owner), { name: 'Synthetic member', email: 'member@example.test', password: 'synthetic-password', role: 'sales' });
    await pool.query("CREATE TRIGGER reject_synthetic_audit BEFORE INSERT ON account_administration_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic audit failure'");
    await assert.rejects(updateAccountAccess(store, publicUser(owner), member.id, 'disable'));
    assert.equal(member.status, 'active');
    const [persisted] = await pool.query<import('mysql2/promise').RowDataPacket[]>('SELECT status,auth_version FROM users WHERE id=?', [member.id]);
    assert.equal(persisted[0].status, 'active'); assert.equal(persisted[0].auth_version, 1);
    await pool.query('DROP TRIGGER reject_synthetic_audit');
    await store.close?.(); store = undefined;
    // Encrypted dump -> distinct empty target. No plaintext dump touches disk.
    stage = 'backup_restore';
    const dump = docker(['exec', '-e', 'MYSQL_PWD', name, 'mysqldump', '-uroot', '--single-transaction', '--skip-lock-tables', '--no-tablespaces', 'shensi_admin_synthetic']);
    const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(dump), cipher.final()]); dump.fill(0);
    const backupPath = join(directory, 'backup.enc'); await writeFile(backupPath, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600 });
    await pool.query('CREATE DATABASE shensi_admin_restored CHARACTER SET utf8mb4');
    const backup = await readFile(backupPath), decipher = createDecipheriv('aes-256-gcm', key, backup.subarray(0, 12)); decipher.setAuthTag(backup.subarray(12, 28));
    const restoredSql = Buffer.concat([decipher.update(backup.subarray(28)), decipher.final()]);
    docker(['exec', '-i', '-e', 'MYSQL_PWD', name, 'mysql', '-uroot', 'shensi_admin_restored'], restoredSql); restoredSql.fill(0); key.fill(0);
    const [comparison] = await pool.query<import('mysql2/promise').RowDataPacket[]>(`SELECT (SELECT COUNT(*) FROM shensi_admin_synthetic.users) source_users,(SELECT COUNT(*) FROM shensi_admin_restored.users) target_users,(SELECT COUNT(*) FROM shensi_admin_synthetic.account_administration_audit) source_audit,(SELECT COUNT(*) FROM shensi_admin_restored.account_administration_audit) target_audit`);
    assert.equal(comparison[0].source_users, comparison[0].target_users); assert.equal(comparison[0].source_audit, comparison[0].target_audit);
    const [restored] = await pool.query<import('mysql2/promise').RowDataPacket[]>('SELECT payload FROM shensi_admin_restored.platform_administration_state WHERE id=1');
    const [source] = await pool.query<import('mysql2/promise').RowDataPacket[]>('SELECT payload FROM shensi_admin_synthetic.platform_administration_state WHERE id=1');
    assert.deepEqual(restored[0].payload, source[0].payload);
    console.log(JSON.stringify({ syntheticOnly: true, restartPersistence: true, userAuditRollback: true, encryptedBackupRestore: true, sourcePreserved: true, userCount: comparison[0].source_users, auditCount: comparison[0].source_audit }));
  } finally {
    await store?.close?.(); await pool?.end();
    if (owned) { const label = docker(['inspect', '--format', '{{index .Config.Labels "shensi.admin.synthetic"}}', name]).toString().trim(); if (label !== nonce) throw new Error('synthetic_ownership_mismatch'); docker(['rm', '-f', '-v', name]); }
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch(error => { const code = String(error?.code ?? error?.name ?? 'unknown').replace(/[^A-Za-z0-9_]/g, '').slice(0, 80); console.error(`SYNTHETIC_ACCEPTANCE_FAILED stage=${stage} code=${code}`); process.exitCode = 1; });
