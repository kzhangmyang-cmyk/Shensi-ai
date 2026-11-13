import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const moduleUrl = new URL('../src/main/embedded-reference-pack.ts', import.meta.url).href;

test('standalone reads only the fixed packaged reference and supplies its verified digest', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'shensi-embedded-pack-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'system-reference');
  await mkdir(directory);
  const bytes = gzipSync('synthetic reference fixture');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(directory, 'books.json.gz'), bytes);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: 1,
    file: 'books.json.gz', sha256, sourceCount: 21,
    corpusId: '11111111-1111-4111-8111-111111111111', releaseId: '22222222-2222-4222-8222-222222222222' }));
  const module = await import(moduleUrl).catch(() => ({}));
  assert.equal(typeof module.readEmbeddedReferencePack, 'function');
  const pack = await module.readEmbeddedReferencePack(root);
  assert.deepEqual(pack, { path: path.join(directory, 'books.json.gz'), sha256 });
  assert.deepEqual(module.embeddedReferenceEnvironment(pack), { SHENSI_REFERENCE_MODE: 'embedded',
    SHENSI_REFERENCE_PACK: pack.path, SHENSI_REFERENCE_PACK_SHA256: sha256 });
  assert.deepEqual(module.embeddedReferenceEnvironment(), {});
  await writeFile(path.join(directory, 'books.json.gz'), gzipSync('changed fixture'));
  await assert.rejects(module.readEmbeddedReferencePack(root), /embedded_reference_pack_invalid/);
});

for (const mutation of ['path', 'unknown', 'sourceCount', 'symlink', 'missing'] as const) {
  test(`invalid ${mutation} cannot become a default reference resource`, async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'shensi-invalid-pack-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'system-reference'); await mkdir(directory);
    const bytes = gzipSync('fixture'); const sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifest: Record<string, unknown> = { version: 1, file: 'books.json.gz', sha256, sourceCount: 21,
      corpusId: '11111111-1111-4111-8111-111111111111', releaseId: '22222222-2222-4222-8222-222222222222' };
    if (mutation === 'path') manifest.file = '../private.json';
    if (mutation === 'unknown') manifest.originals = 'private';
    if (mutation === 'sourceCount') manifest.sourceCount = 22;
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    if (mutation === 'symlink') {
      await writeFile(path.join(root, 'outside.gz'), bytes);
      await symlink('../outside.gz', path.join(directory, 'books.json.gz'));
    } else if (mutation !== 'missing') await writeFile(path.join(directory, 'books.json.gz'), bytes);
    const module = await import(moduleUrl);
    await assert.rejects(module.readEmbeddedReferencePack(root), /embedded_reference_pack_invalid/);
  });
}
