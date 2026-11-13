// Isolated local acceptance runtime. Never reads the desktop/trial database config.
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { API_ONLY_CRYPTO_SECRET_BINDINGS } from './api-only-runtime.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const runtime = join(repo, '.runtime/admin-preview');
const configPath = join(runtime, 'config.json');
const requireBackend = createRequire(join(repo, 'backend/package.json'));
const label = 'io.shensi.admin-preview.owner';
const origin = 'http://localhost:5681';
const baseEnv = () => Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
async function privateFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error('preview_private_file_invalid');
}
async function config() {
  await privateFile(configPath);
  const value = JSON.parse(await readFile(configPath, 'utf8'));
  if (value.version !== 1 || !/^[a-f0-9]{24}$/.test(value.owner) || value.name !== `shensi-admin-preview-${value.owner}` || value.database !== 'shensi_admin_preview'
    || !/^unix:\/\//.test(value.dockerHost) || !/^[a-f0-9]{64}$/.test(value.engine)) throw new Error('preview_config_invalid');
  return value;
}
function docker(cfg, args, additional = {}) {
  return execFileSync('docker', args, { env: { ...baseEnv(), DOCKER_HOST: cfg.dockerHost, ...additional }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
}
function engine(cfg) { return createHash('sha256').update(docker(cfg, ['info', '--format', '{{.ID}}']).trim()).digest('hex'); }
function assertOwned(cfg) {
  if (engine(cfg) !== cfg.engine) throw new Error('preview_engine_changed');
  const actual = docker(cfg, ['inspect', '--format', `{{index .Config.Labels "${label}"}}`, cfg.name]).trim();
  if (actual !== cfg.owner) throw new Error('preview_container_owner_mismatch');
  const port = docker(cfg, ['port', cfg.name, '3306/tcp']).trim();
  if (port !== `127.0.0.1:${cfg.mysqlPort}`) throw new Error('preview_mysql_port_changed');
}
export function previewEnvironment(cfg) {
  const admitted = cfg.admittedBuildManifestSha256;
  if (admitted !== undefined && !/^[a-f0-9]{64}$/.test(admitted)) throw new Error('preview_admitted_digest_invalid');
  return { ...baseEnv(), ...cfg.secrets, NODE_ENV: 'production', SHENSI_SKIP_LOCAL_ENV: 'true', SHENSI_REQUIRE_PLATFORM_OWNER: 'true', CRM_STORE: 'mysql', CRM_SEED_DEVELOPMENT_DATA: 'false',
    DATABASE_URL: `mysql://root:${cfg.databasePassword}@127.0.0.1:${cfg.mysqlPort}/${cfg.database}`, MYSQL_SSL_MODE: 'disabled',
    INITIAL_ADMIN_EMAIL: 'isolated-bootstrap@example.test', INITIAL_ADMIN_PASSWORD: cfg.bootstrapPassword,
    SESSION_COOKIE_SECURE: 'false', BACKEND_HOST: '127.0.0.1', PORT: '5680', CORS_ORIGINS: `${origin},http://127.0.0.1:5680`,
    SHENSI_ADMIN_PREVIEW_PASSWORD_ONLY_USER_ID: cfg.previewPasswordOnlyUserId ?? '',
    SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: admitted ? 'exact' : 'migration_locked',
    SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: admitted ?? '',
    DOUYIN_OUTREACH_ACTIONS_ENABLED: 'false', DOUYIN_OUTREACH_APPROVALS_ENABLED: 'false', DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: 'false', DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: 'false',
    PROSPECT_WORKER_ENABLED: 'false', PROSPECT_SCHEDULER_ENABLED: 'false', PROSPECT_QUEUE_REQUIRED: 'false', ENABLE_API_DOCS: 'false', REDIS_URL: '' };
}
async function available(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}
async function waitHttp(url) {
  for (let i = 0; i < 60; i++) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('preview_http_not_ready');
}
async function seed(cfg) {
  Object.assign(process.env, previewEnvironment(cfg));
  const { createMysqlStore } = await import(pathToFileURL(join(repo, 'backend/dist/mysql-store.js')));
  const { hashPassword } = await import(pathToFileURL(join(repo, 'backend/dist/auth.js')));
  const { bootstrapPlatformOwner, platformState } = await import(pathToFileURL(join(repo, 'backend/dist/platform-admin-service.js')));
  const store = await createMysqlStore({ processRole: 'api' });
  try {
    if (platformState(store).memberships.length) {
      if (!platformState(store).memberships.some(row => row.userId === cfg.operatorId)) throw new Error('preview_operator_mismatch');
      return;
    }
    if (!store.users.some(row => row.id === cfg.operatorId)) {
      store.users.push({ id: cfg.operatorId, name: '合成运营员', email: 'preview_ops@shensi.local', role: 'admin', teamId: `preview_ops_${cfg.owner}`, avatar: '验', status: 'active', authVersion: 1, password: await hashPassword(cfg.operatorPassword) });
      await store.persist();
    }
    await bootstrapPlatformOwner(store, cfg.operatorId, cfg.totpSecret);
  } finally { await store.close?.(); }
}
async function gateway(cfg) {
  const express = requireBackend('express');
  const { TOTP, Secret } = requireBackend('otpauth');
  const app = express();
  app.use((req, res, next) => {
    if (req.headers.host !== 'localhost:5681' || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') { res.sendStatus(403); return; }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); next();
  });
  app.get('/preview-access', (_req, res) => {
    const code = new TOTP({ secret: Secret.fromBase32(cfg.totpSecret) }).generate();
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>神思隔离验收入口</title><main style="font:16px system-ui;max-width:700px;margin:60px auto;line-height:2"><h1>神思 · 本地隔离验收</h1><p>真实独立MySQL，仅合成数据。以下凭据仅用于本机验收；未连接真实客户库，所有外联执行关闭。</p><p>运营账号：<code>preview_ops</code><br>密码：<code>${cfg.operatorPassword}</code><br>当前验证码：<code>${code}</code>（30秒更新，使用后不能重复；刷新本页获取）</p><p><a href="/admin.html" target="_blank">打开账号运营后台</a> · <a href="/" target="_blank">打开客户应用</a></p><p>客户与运营登录请使用不同浏览器/无痕窗口，避免覆盖同源会话。</p></main>`);
  });
  app.use('/api', (req, res) => {
    const upstream = http.request({ host: '127.0.0.1', port: 5680, path: req.originalUrl, method: req.method, headers: { ...req.headers, host: '127.0.0.1:5680' } }, response => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.status(502).json({ message: '隔离后端正在启动，请稍后刷新' }); else res.end(); }); req.pipe(upstream);
  });
  for (const path of ['/', '/admin.html']) app.get(path, async (_req, res) => {
    const html = await readFile(join(repo, 'frontend/dist', path === '/' ? 'index.html' : 'admin.html'), 'utf8');
    res.type('html').send(html.replace('<body>', '<body><div style="position:relative;z-index:9999;padding:8px 16px;background:#fff3cd;color:#684f00;font:13px sans-serif">隔离MySQL验收 · 仅合成数据 · <a href="/preview-access" target="_blank">测试登录说明</a></div>'));
  });
  app.use(express.static(join(repo, 'frontend/dist')));
  app.listen(5681, '127.0.0.1', () => console.log(`PREVIEW_GATEWAY_READY ${origin}`));
}
async function start() {
  if (!process.env.DOCKER_HOST) throw new Error('explicit_docker_host_required');
  await available(5680); await available(5681);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const dir = await lstat(runtime);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700) throw new Error('preview_directory_invalid');
  let cfg;
  try { cfg = await config(); if (cfg.dockerHost !== process.env.DOCKER_HOST) throw new Error('preview_docker_host_changed'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const { TOTP } = requireBackend('otpauth');
    const owner = randomBytes(12).toString('hex');
    cfg = { version: 1, owner, name: `shensi-admin-preview-${owner}`, dockerHost: process.env.DOCKER_HOST, database: 'shensi_admin_preview', databasePassword: randomBytes(32).toString('hex'), bootstrapPassword: randomBytes(32).toString('hex'), operatorPassword: randomBytes(18).toString('base64url'), operatorId: `preview_ops_${owner}`, totpSecret: new TOTP().secret.base32, secrets: Object.fromEntries(Object.keys(API_ONLY_CRYPTO_SECRET_BINDINGS).map(key => [key, randomBytes(48).toString('hex')])) };
    cfg.engine = engine(cfg);
    docker(cfg, ['run', '-d', '--name', cfg.name, '--label', `${label}=${cfg.owner}`, '--restart', 'unless-stopped', '--mount', 'type=volume,target=/var/lib/mysql', '-p', '127.0.0.1::3306', '-e', 'MYSQL_ROOT_PASSWORD', '-e', `MYSQL_DATABASE=${cfg.database}`, 'mysql:8.4.11'], { MYSQL_ROOT_PASSWORD: cfg.databasePassword });
    const mapping = docker(cfg, ['port', cfg.name, '3306/tcp']).trim();
    if (!/^127\.0\.0\.1:\d+$/.test(mapping)) throw new Error('preview_port_invalid');
    cfg.mysqlPort = Number(mapping.split(':').at(-1));
    await writeFile(configPath, JSON.stringify(cfg), { mode: 0o600, flag: 'wx' });
  }
  assertOwned(cfg);
  const mysql = requireBackend('mysql2/promise');
  const pool = mysql.createPool(previewEnvironment(cfg).DATABASE_URL);
  let ready = false;
  try { for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); ready = true; break; } catch { await new Promise(r => setTimeout(r, 1000)); } } }
  finally { await pool.end(); }
  if (!ready) throw new Error('preview_mysql_not_ready');
  const passwordOnlyPath = join(runtime, 'adminkamiran-mfa.json');
  try {
    await privateFile(passwordOnlyPath);
    const identity = JSON.parse(await readFile(passwordOnlyPath, 'utf8'));
    if (identity.account !== 'adminkamiran' || typeof identity.userId !== 'string' || !identity.userId) throw new Error('preview_password_only_identity_invalid');
    cfg.previewPasswordOnlyUserId = identity.userId;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'seed'], { cwd: repo, env: previewEnvironment(cfg), stdio: ['ignore', 'pipe', 'pipe'] });
  const launch = (name, argv, env) => { const fd = openSync(join(runtime, `${name}.log`), 'a', 0o600); const child = spawn(process.execPath, argv, { cwd: repo, env, detached: true, stdio: ['ignore', fd, fd] }); child.unref(); return child.pid; };
  const backendPid = launch('backend', [join(repo, 'backend/dist/server.js')], previewEnvironment(cfg));
  await writeFile(join(runtime, 'pids.json'), JSON.stringify({ backendPid }), { mode: 0o600 });
  await waitHttp('http://127.0.0.1:5680/api/health');
  const gatewayPid = launch('gateway', [fileURLToPath(import.meta.url), 'gateway'], baseEnv());
  await writeFile(join(runtime, 'pids.json'), JSON.stringify({ backendPid, gatewayPid }), { mode: 0o600 });
  await waitHttp(`${origin}/admin.html`);
  console.log(JSON.stringify({ mysql: 'isolated-persistent', admin: `${origin}/admin.html`, access: `${origin}/preview-access`, backendPid, gatewayPid }));
}
async function stop() {
  const cfg = await config(); assertOwned(cfg);
  const pids = JSON.parse(await readFile(join(runtime, 'pids.json'), 'utf8'));
  for (const [key, port] of [['gatewayPid', 5681], ['backendPid', 5680]]) {
    const pid = pids[key];
    if (!Number.isInteger(pid) || pid <= 1) throw new Error('preview_pid_invalid');
    let listeners;
    try { listeners = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP:' + port, '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { continue; }
    if (!listeners.split('\n').includes(`n127.0.0.1:${port}`)) throw new Error('preview_listener_identity_invalid');
    process.kill(pid, 'SIGTERM');
    let closed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await available(port); closed = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!closed) throw new Error('preview_stop_timeout');
  }
  console.log('PREVIEW_PROCESSES_STOP_REQUESTED; dedicated MySQL data retained');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2];
  if (command === 'start') await start();
  else if (command === 'stop') await stop();
  else if (command === 'seed') { const cfg = await config(); assertOwned(cfg); await seed(cfg); }
  else if (command === 'gateway') await gateway(await config());
  else if (command === 'admit') {
    const cfg = await config(); assertOwned(cfg);
    const digest = process.argv[3];
    if (!/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('explicit_preview_build_digest_required');
    await writeFile(configPath, JSON.stringify({ ...cfg, admittedBuildManifestSha256: digest }), { mode: 0o600 });
    console.log('PREVIEW_BUILD_ADMISSION_SAVED; restart only this isolated runtime to apply');
  }
  else throw new Error('use_start_or_stop');
}
