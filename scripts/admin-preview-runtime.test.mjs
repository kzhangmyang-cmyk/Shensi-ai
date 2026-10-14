import test from 'node:test';
import assert from 'node:assert/strict';
import { previewEnvironment } from './admin-preview-runtime.mjs';

test('preview environment selects only its own database and disables all execution switches', () => {
  const before = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'mysql://do-not-use.invalid/real';
  try {
    const env = previewEnvironment({ database: 'shensi_admin_preview', mysqlPort: 34999, databasePassword: 'synthetic-only', bootstrapPassword: 'synthetic-only', secrets: { JWT_SECRET: 'synthetic-key' } });
    assert.equal(env.DATABASE_URL, 'mysql://root:synthetic-only@127.0.0.1:34999/shensi_admin_preview');
    assert.equal(env.SHENSI_SKIP_LOCAL_ENV, 'true');
    assert.equal(env.CRM_SEED_DEVELOPMENT_DATA, 'false');
    assert.equal(env.CORS_ORIGINS, 'http://localhost:5681,http://127.0.0.1:5680');
    assert.equal(env.SHENSI_DESKTOP_CLIENT_ADMISSION_MODE, 'migration_locked');
    for (const key of ['DOUYIN_OUTREACH_ACTIONS_ENABLED', 'DOUYIN_OUTREACH_APPROVALS_ENABLED', 'DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED', 'DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED', 'PROSPECT_WORKER_ENABLED', 'PROSPECT_SCHEDULER_ENABLED']) assert.equal(env[key], 'false', key);
    assert.equal(env.MYSQL_URL, undefined);
  } finally { if (before === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = before; }
});

test('preview admits only an explicitly saved exact test package digest', () => {
  const cfg = { database: 'shensi_admin_preview', mysqlPort: 34999, databasePassword: 'synthetic', secrets: {} };
  const digest = 'a'.repeat(64);
  const env = previewEnvironment({ ...cfg, admittedBuildManifestSha256: digest });
  assert.equal(env.SHENSI_DESKTOP_CLIENT_ADMISSION_MODE, 'exact');
  assert.equal(env.SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256, digest);
  assert.equal(env.DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED, 'false');
  assert.throws(() => previewEnvironment({ ...cfg, admittedBuildManifestSha256: '*' }), /digest_invalid/);
});

test('password-only identity is scoped to the isolated backend environment', () => {
  const cfg = { database: 'shensi_admin_preview', mysqlPort: 34999, databasePassword: 'synthetic', secrets: {}, previewPasswordOnlyUserId: 'synthetic-preview-user' };
  assert.equal(previewEnvironment(cfg).SHENSI_ADMIN_PREVIEW_PASSWORD_ONLY_USER_ID, 'synthetic-preview-user');
  assert.equal(previewEnvironment({ ...cfg, previewPasswordOnlyUserId: undefined }).SHENSI_ADMIN_PREVIEW_PASSWORD_ONLY_USER_ID, '');
});
