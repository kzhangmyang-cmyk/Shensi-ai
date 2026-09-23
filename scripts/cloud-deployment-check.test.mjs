import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { validateCloudConfiguration } from './cloud-deployment-check.mjs';
import { API_ONLY_CRYPTO_SECRET_BINDINGS } from './api-only-runtime.mjs';

function inputs() {
  const env = { SHENSI_CLOUD_HOSTNAME: 'api.shensi.example.com' };
  for (const key of ['BACKEND', 'FRONTEND', 'GATEWAY']) env[`SHENSI_CLOUD_${key}_IMAGE`] = `registry.example.com/${key.toLowerCase()}@sha256:${'a'.repeat(64)}`;
  for (const key of ['BACKEND_ENV_FILE', 'TLS_CERT_FILE', 'TLS_KEY_FILE', 'ADMIN_ALLOW_FILE']) env[`SHENSI_CLOUD_${key}`] = `/private/${key}`;
  const backend = { DATABASE_URL: 'mysql://synthetic:synthetic@db.example.com/shensi_overseas', MYSQL_SSL_MODE: 'verify_ca', MYSQL_SSL_CA: '-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----', SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: 'migration_locked', INITIAL_ADMIN_EMAIL: 'synthetic@example.com', INITIAL_ADMIN_PASSWORD: 'synthetic-only-password' };
  for (const key of Object.keys(API_ONLY_CRYPTO_SECRET_BINDINGS)) backend[key] = `${key}-${'a'.repeat(48)}`;
  return { env, backend };
}
test('cloud preflight rejects mutable images, placeholder hosts, unverified DB TLS and unbound admission', () => {
  const { env, backend } = inputs(); assert.equal(validateCloudConfiguration(env, backend).databaseTls, 'verified');
  assert.throws(() => validateCloudConfiguration({ ...env, SHENSI_CLOUD_HOSTNAME: 'api.example.invalid' }, backend), /hostname/);
  assert.throws(() => validateCloudConfiguration({ ...env, SHENSI_CLOUD_BACKEND_IMAGE: 'backend:latest' }, backend), /immutable/);
  assert.throws(() => validateCloudConfiguration(env, { ...backend, MYSQL_SSL_MODE: 'disabled' }), /tls/);
  assert.throws(() => validateCloudConfiguration(env, { ...backend, SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: 'exact' }), /digest/);
  assert.equal(validateCloudConfiguration(env, { ...backend, SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: 'exact', SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: 'b'.repeat(64) }).desktopAdmission, 'exact');
});
test('cloud services expose only TLS gateway and require initialized owner with outbound execution off', async () => {
  const compose = parse(await readFile(new URL('../deploy/compose.cloud.yaml', import.meta.url), 'utf8'));
  const { backend, frontend, gateway } = compose.services;
  assert.equal(backend.ports, undefined); assert.equal(frontend.ports, undefined);
  assert.equal(backend.environment.SHENSI_REQUIRE_PLATFORM_OWNER, 'true');
  for (const key of ['DOUYIN_OUTREACH_ACTIONS_ENABLED', 'DOUYIN_OUTREACH_APPROVALS_ENABLED', 'DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED', 'DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED']) assert.equal(backend.environment[key], 'false');
  assert.match(gateway.ports[0], /127\.0\.0\.1.*443:8443/);
  for (const service of [backend, frontend, gateway]) assert.equal(service.restart, 'unless-stopped');
  const dockerfile = await readFile(new URL('../deploy/docker/backend.Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY frontend\/src\/generated\/platform-admin\.ts/);
});
