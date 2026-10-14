import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, stat, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as hooks from '../scripts/macos-release-hooks.mjs';
import {readDesktopBuildIdentity} from '../src/main/desktop-build-identity.ts';

test('packaged manifest permits Main startup and changes with packaged configuration', async () => {
  const resourcesPath = await realpath(await mkdtemp(path.join(tmpdir(),'shensi-packaged-identity-')));
  await mkdir(path.join(resourcesPath,'frontend'));
  await mkdir(path.join(resourcesPath,'sidecar'));
  await writeFile(path.join(resourcesPath,'frontend/index.html'),'<html>fixture</html>');
  await writeFile(path.join(resourcesPath,'sidecar/shensi-sidecar'),'fixture');
  await writeFile(path.join(resourcesPath,'app.asar'),'fixture');
  await writeFile(path.join(resourcesPath,'desktop-config.json'),'{"remoteOrigin":"http://127.0.0.1:5680"}\n');
  const input={resourcesPath,sourceRootHash:'a'.repeat(64),architecture:'arm64',bundleId:'com.shensi.desktop'};
  await hooks.writePackagedBuildIdentity(input);
  const first=await readDesktopBuildIdentity(resourcesPath);
  assert.match(first,/^[a-f0-9]{64}$/);
  const manifest=JSON.parse(await readFile(path.join(resourcesPath,'desktop-build-manifest.json'),'utf8'));
  assert.equal(manifest.kind,'packaged');
  assert.equal((await stat(path.join(resourcesPath,'desktop-build-manifest.json'))).mode&0o777,0o644);
  await writeFile(path.join(resourcesPath,'desktop-config.json'),'{"remoteOrigin":"http://127.0.0.1:5682"}\n');
  await hooks.writePackagedBuildIdentity(input);
  assert.notEqual(await readDesktopBuildIdentity(resourcesPath),first);
});

test('finalizing signed resources updates the sidecar fingerprint and preserves source identity', async () => {
  const appPath = await realpath(await mkdtemp(path.join(tmpdir(), 'shensi-signed-identity-')));
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  await mkdir(path.join(resourcesPath, 'frontend'), { recursive: true });
  await mkdir(path.join(resourcesPath, 'sidecar'));
  await writeFile(path.join(resourcesPath, 'frontend/index.html'), '<html>fixture</html>');
  await writeFile(path.join(resourcesPath, 'sidecar/shensi-sidecar'), 'fixture');
  await writeFile(path.join(resourcesPath, 'app.asar'), 'fixture');
  await writeFile(path.join(resourcesPath, 'desktop-config.json'), '{"remoteOrigin":"http://127.0.0.1:5680"}\n');
  await hooks.writePackagedBuildIdentity({ resourcesPath, sourceRootHash: 'a'.repeat(64), architecture: 'arm64', bundleId: 'com.shensi.desktop' });
  const first = await readDesktopBuildIdentity(resourcesPath);
  await writeFile(path.join(resourcesPath, 'sidecar/shensi-sidecar'), 'signed fixture');
  await hooks.finalizePackagedResources(appPath);
  assert.notEqual(await readDesktopBuildIdentity(resourcesPath), first);
  assert.equal(JSON.parse(await readFile(path.join(resourcesPath, 'desktop-build-manifest.json'), 'utf8')).sourceRootHash, 'a'.repeat(64));
});

test('standalone packaged identity includes the staged backend/runtime/reference resource manifest', async () => {
  const resourcesPath = await realpath(await mkdtemp(path.join(tmpdir(), 'shensi-standalone-identity-')));
  await mkdir(path.join(resourcesPath, 'frontend')); await mkdir(path.join(resourcesPath, 'sidecar'));
  await writeFile(path.join(resourcesPath, 'frontend/index.html'), '<html>fixture</html>');
  await writeFile(path.join(resourcesPath, 'sidecar/shensi-sidecar'), 'fixture');
  await writeFile(path.join(resourcesPath, 'app.asar'), 'fixture');
  await writeFile(path.join(resourcesPath, 'desktop-config.json'), '{"mode":"standalone"}\n');
  await writeFile(path.join(resourcesPath, 'standalone-resources.json'), '{"version":1,"roots":{"fixture":"a"}}\n');
  const input = { resourcesPath, sourceRootHash: 'a'.repeat(64), architecture: 'arm64', bundleId: 'com.shensi.desktop' };
  await hooks.writePackagedBuildIdentity(input); const first = await readDesktopBuildIdentity(resourcesPath);
  await writeFile(path.join(resourcesPath, 'standalone-resources.json'), '{"version":1,"roots":{"fixture":"b"}}\n');
  await assert.rejects(readDesktopBuildIdentity(resourcesPath), /desktop_build_identity_invalid/);
  await hooks.writePackagedBuildIdentity(input);
  assert.notEqual(await readDesktopBuildIdentity(resourcesPath), first);
});
