import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const moduleUrl = new URL('../scripts/standalone-resources.mjs', import.meta.url).href;
test('standalone staging copies only production resources and verifies the exact default pack', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'shensi-stage-fixture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function file(name: string, content = 'fixture', executable = false) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content, { mode: executable ? 0o755 : 0o644 });
  }
  await file('production/backend/dist/server.js'); await file('production/backend/package.json', '{"name":"backend"}');
  await file('production/backend/node_modules/dependency/index.js');
  await file('production/backend/node_modules/.modules.yaml', 'storeDir: /Users/buildbot/install-store');
  await file('production/backend/node_modules/.pnpm-workspace-state-v1.json', '{"workspaceDir":"/Users/buildbot/workspace"}');
  await file('production/backend/node_modules/.package-map.json', '{"packages":{}}');
  await file('production/backend/node_modules/dependency/.modules.yaml', 'dependency-owned resource');
  await file('production/backend/node_modules/.bin/dependency', 'generated install wrapper', true);
  await file('production/backend/node_modules/dependency/node_modules/.bin/tool', 'generated nested wrapper', true);
  await file('production/backend/node_modules/dependency/bin/tool.js', 'original CLI implementation');
  await file('production/backend/.env', 'must never copy'); await file('production/backend/src/private.txt', 'must never copy');
  await file('contracts/openapi/ai-acquisition.v1.yaml'); await file('contracts/json-schema/knowledge.v1.schema.json', '{}');
  await file('contracts/releases/growth-advisor-quote-roi/1.0.41/manifest.json', '{}');
  await file('node/bin/node', 'fixture', true); await file('node/LICENSE');
  await file('mysql/bin/mysql', 'fixture', true); await file('mysql/bin/mysqld', 'fixture', true);
  await file('mysql/LICENSE'); await file('mysql/README'); await file('mysql/lib/library'); await file('mysql/share/charset');
  const bytes = gzipSync('synthetic fixture'); const sha256 = createHash('sha256').update(bytes).digest('hex');
  await file('reference/manifest.json', JSON.stringify({ version: 1, file: 'books.json.gz', sha256, sourceCount: 21,
    corpusId: '11111111-1111-4111-8111-111111111111', releaseId: '22222222-2222-4222-8222-222222222222' }));
  await writeFile(path.join(root, 'reference/books.json.gz'), bytes, { mode: 0o600 });
  const module = await import(moduleUrl).catch(() => ({}));
  assert.equal(typeof module.stageStandaloneResources, 'function');
  const outputDirectory = path.join(root, 'output');
  await module.stageStandaloneResources({ backendDirectory: path.join(root, 'production/backend'), contractsDirectory: path.join(root, 'contracts'),
    nodeExecutable: path.join(root, 'node/bin/node'), nodeLicense: path.join(root, 'node/LICENSE'),
    mysqlDirectory: path.join(root, 'mysql'), referenceDirectory: path.join(root, 'reference'), outputDirectory });
  assert.equal((await module.verifyStandaloneResources(outputDirectory)).sourceCount, 21);
  for (const name of ['.modules.yaml', '.pnpm-workspace-state-v1.json']) {
    await assert.rejects(readFile(path.join(outputDirectory, 'backend/node_modules', name)), { code: 'ENOENT' });
    assert.ok((await readFile(path.join(root, 'production/backend/node_modules', name))).length > 0);
  }
  assert.equal(await readFile(path.join(outputDirectory, 'backend/node_modules/.package-map.json'), 'utf8'), '{"packages":{}}');
  assert.equal(await readFile(path.join(outputDirectory, 'backend/node_modules/dependency/.modules.yaml'), 'utf8'), 'dependency-owned resource');
  await assert.rejects(stat(path.join(outputDirectory, 'backend/node_modules/.bin')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(outputDirectory, 'backend/node_modules/dependency/node_modules/.bin')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(outputDirectory, 'backend/node_modules/dependency/bin/tool.js'), 'utf8'), 'original CLI implementation');
  assert.equal((await stat(path.join(outputDirectory, 'system-reference/books.json.gz'))).mode & 0o777, 0o644);
  await assert.rejects(readFile(path.join(outputDirectory, 'backend/.env')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(outputDirectory, 'backend/src/private.txt')), { code: 'ENOENT' });
  const resources = path.join(root, 'new-app-resources'); await mkdir(resources);
  await module.installStagedStandaloneResources(outputDirectory, resources);
  assert.equal((await module.verifyStandaloneResources(resources)).sourceCount, 21);
  // Code signing changes executable bytes after staging. Final fingerprints must
  // be regenerated before the outer app is sealed, without weakening verification.
  const beforeSigning = await readFile(path.join(resources, 'standalone-resources.json'), 'utf8');
  await writeFile(path.join(resources, 'backend-runtime/node'), 'signed fixture');
  await assert.rejects(module.verifyStandaloneResources(resources), /standalone_resource_digest_mismatch/);
  assert.equal(typeof module.refreshStandaloneResourceManifest, 'function');
  await module.refreshStandaloneResourceManifest(resources);
  assert.notEqual(await readFile(path.join(resources, 'standalone-resources.json'), 'utf8'), beforeSigning);
  assert.equal((await module.verifyStandaloneResources(resources)).sourceCount, 21);
  assert.equal(await readFile(path.join(resources, 'backend/node_modules/dependency/index.js'), 'utf8'), 'fixture');
  await assert.rejects(module.installStagedStandaloneResources(outputDirectory, resources), { code: 'ERR_FS_CP_EEXIST' });
  await symlink(path.join(root, 'node/bin/node'), path.join(resources, 'backend/node_modules/escaping-node'));
  await assert.rejects(module.verifyStandaloneResources(resources), /standalone_resource_link_escape/);
  await writeFile(path.join(outputDirectory, 'backend/dist/server.js'), 'changed');
  await assert.rejects(module.verifyStandaloneResources(outputDirectory), /standalone_resource_digest_mismatch/);
});
