import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHarnessDirectory, harnessEnvironment } from './council-pdf-native-harness-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await createHarnessDirectory();
await Promise.all([
  build({ entryPoints: [path.join(root, 'scripts/council-pdf-native-harness-main.ts')], outfile: path.join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['electron'] }),
  build({ entryPoints: [path.join(root, 'src/preload/preload.ts')], outfile: path.join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
]);
console.log(`Isolated harness files/profile (retained after exit): ${directory}`);
if (!process.argv.includes('--prepare-only')) {
  const electron = createRequire(import.meta.url)('electron');
  const child = spawn(electron, [path.join(directory, 'main.mjs'), directory,
    path.resolve(root, '../outputs/financial-council-collaboration-sample/collaboration.json'),
    ...(process.argv.includes('--smoke') ? ['--smoke'] : [])],
  { cwd: root, env: harnessEnvironment(process.env), stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { if (child.exitCode === null) child.kill(signal); });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}
