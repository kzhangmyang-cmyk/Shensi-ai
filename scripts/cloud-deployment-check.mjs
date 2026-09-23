import { readFile, lstat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { API_ONLY_CRYPTO_SECRET_BINDINGS } from './api-only-runtime.mjs';

// Read-only checks; never starts containers or prints private configuration.
export function validateCloudConfiguration(env, backend) {
  const hostname = env.SHENSI_CLOUD_HOSTNAME ?? '';
  if (!/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(hostname) || /(?:\.invalid|\.localhost|\.test)$/.test(hostname) || hostname === 'localhost' || /^\d+(\.\d+){3}$/.test(hostname)) throw new Error('fixed_public_hostname_required');
  for (const key of ['BACKEND', 'FRONTEND', 'GATEWAY']) if (!/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(env[`SHENSI_CLOUD_${key}_IMAGE`] ?? '')) throw new Error(`immutable_${key.toLowerCase()}_image_required`);
  for (const key of ['BACKEND_ENV_FILE', 'TLS_CERT_FILE', 'TLS_KEY_FILE', 'ADMIN_ALLOW_FILE']) if (!isAbsolute(env[`SHENSI_CLOUD_${key}`] ?? '')) throw new Error('absolute_private_paths_required');
  for (const key of Object.keys(API_ONLY_CRYPTO_SECRET_BINDINGS)) if ((backend[key]?.length ?? 0) < 32 || /replace|example/i.test(backend[key])) throw new Error(`stable_${key}_required`);
  const values = Object.keys(API_ONLY_CRYPTO_SECRET_BINDINGS).map(key => backend[key]);
  if (new Set(values).size !== values.length) throw new Error('distinct_security_keys_required');
  let db; try { db = new URL(backend.DATABASE_URL); } catch { throw new Error('database_configuration_required'); }
  if (db.protocol !== 'mysql:' || !db.hostname || !db.username || !db.password || db.pathname.length < 2) throw new Error('database_configuration_required');
  if (backend.MYSQL_SSL_MODE !== 'verify_ca' || !backend.MYSQL_SSL_CA?.includes('-----BEGIN CERTIFICATE-----')) throw new Error('verified_remote_mysql_tls_required');
  const mode = backend.SHENSI_DESKTOP_CLIENT_ADMISSION_MODE;
  if (!['migration_locked', 'exact'].includes(mode)) throw new Error('desktop_admission_configuration_required');
  const digest = backend.SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256 ?? '';
  if (mode === 'exact' ? !/^[a-f0-9]{64}$/.test(digest) : digest !== '') throw new Error('desktop_admission_digest_invalid');
  if (!backend.INITIAL_ADMIN_EMAIL || (backend.INITIAL_ADMIN_PASSWORD?.length ?? 0) < 12) throw new Error('private_bootstrap_account_required');
  return { hostname, databaseTls: 'verified', desktopAdmission: mode, publicBind: !['127.0.0.1', '::1', undefined].includes(env.SHENSI_CLOUD_BIND_ADDRESS) };
}

async function main() {
  const env = process.env;
  for (const key of ['BACKEND_ENV_FILE', 'TLS_CERT_FILE', 'TLS_KEY_FILE', 'ADMIN_ALLOW_FILE']) {
    const path = env[`SHENSI_CLOUD_${key}`];
    if (!path || !isAbsolute(path)) throw new Error('absolute_private_paths_required');
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('regular_private_files_required');
    if (['BACKEND_ENV_FILE', 'TLS_KEY_FILE'].includes(key) && (stat.mode & 0o077)) throw new Error('private_file_permissions_required');
  }
  const backend = parseEnv(await readFile(env.SHENSI_CLOUD_BACKEND_ENV_FILE, 'utf8'));
  const summary = validateCloudConfiguration(env, backend);
  const allow = await readFile(env.SHENSI_CLOUD_ADMIN_ALLOW_FILE, 'utf8');
  if (!/^\s*deny\s+all\s*;/m.test(allow) || /^\s*allow\s+(?:all|0\.0\.0\.0\/0|::\/0)\s*;/m.test(allow)) throw new Error('restricted_admin_network_required');
  console.log(JSON.stringify({ code: 'SHENSI_CLOUD_STATIC_CHECK_OK', ...summary, note: 'No deployment, certificate trust, DNS, MySQL connection or image execution was performed.' }));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(() => { console.error('Cloud configuration check failed. Check private files, immutable images, fixed hostname, TLS and admission configuration. No private values were printed.'); process.exitCode = 1; });
