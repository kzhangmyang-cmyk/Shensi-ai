import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readEmbeddedReferencePack } from '../src/main/embedded-reference-pack.ts';

const ROOTS = ['backend', 'backend-runtime', 'contracts', 'mysql', 'system-reference'];
// pnpm installation state is not used by the packaged Node runtime and contains host paths.
const PNPM_INSTALL_METADATA = ['.modules.yaml', '.pnpm-workspace-state-v1.json'];
const HASH = /^[a-f0-9]{64}$/u;
const deniedName = /^(?:\.env(?:\..*)?|\.git|\.runtime|cookies?\.json|local-secrets|browser-session|\.DS_Store)$/iu;
const deniedExtension = /\.(?:p12|p8|key|pem|ibd|myd|sqlite|sqlite3|db|log|pdf|docx|xlsx)$/iu;
const error = code => new Error(code);

async function readableBundleModes(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) await readableBundleModes(candidate);
    else if (entry.isFile()) {
      const info = await lstat(candidate);
      await chmod(candidate, info.mode & 0o111 ? 0o755 : 0o644);
    }
  }
  await chmod(root, 0o755);
}

async function digestTree(root) {
  const base = await realpath(root); const records = []; let count = 0;
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(base, relative), { withFileTypes: true })) {
      if (++count > 200000 || deniedName.test(entry.name) || deniedExtension.test(entry.name)) throw error('standalone_resource_forbidden');
      const name = path.join(relative, entry.name); const candidate = path.join(base, name); const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) {
        const target = await readlink(candidate); const resolved = await realpath(candidate);
        if (path.isAbsolute(target) || !resolved.startsWith(`${base}${path.sep}`)) throw error('standalone_resource_link_escape');
        records.push([name, 'link', target]);
      } else if (stat.isDirectory()) await visit(name);
      else if (stat.isFile()) {
        const hash = createHash('sha256'); for await (const bytes of createReadStream(candidate)) hash.update(bytes);
        records.push([name, 'file', stat.mode & 0o777, stat.size, hash.digest('hex')]);
      } else throw error('standalone_resource_type_invalid');
    }
  }
  await visit();
  return createHash('sha256').update(JSON.stringify(records.sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
}

async function requiredFile(root, relative, executable = false) {
  const candidate = path.join(root, relative); const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink() || (executable && !(info.mode & 0o111))) throw error('standalone_resource_required');
}

export async function verifyStandaloneResources(root) {
  const canonical = await realpath(root);
  const manifestPath = path.join(canonical, 'standalone-resources.json'); const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw error('standalone_manifest_invalid');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest || manifest.version !== 1 || Object.keys(manifest).sort().join() !== 'roots,version'
    || !manifest.roots || Object.keys(manifest.roots).sort().join() !== [...ROOTS].sort().join()
    || ROOTS.some(name => typeof manifest.roots[name] !== 'string' || !HASH.test(manifest.roots[name]))) throw error('standalone_manifest_invalid');
  for (const name of ROOTS) {
    const rootInfo = await lstat(path.join(canonical, name));
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw error('standalone_resource_type_invalid');
    if (await digestTree(path.join(canonical, name)) !== manifest.roots[name]) throw error('standalone_resource_digest_mismatch');
  }
  for (const file of ['backend/dist/server.js', 'backend/package.json', 'backend-runtime/LICENSE', 'mysql/LICENSE',
    'contracts/openapi/ai-acquisition.v1.yaml']) await requiredFile(canonical, file);
  for (const file of ['backend-runtime/node', 'mysql/bin/mysql', 'mysql/bin/mysqld']) await requiredFile(canonical, file, true);
  const modules = await lstat(path.join(canonical, 'backend/node_modules'));
  if (!modules.isDirectory() || modules.isSymbolicLink()) throw error('standalone_production_dependencies_missing');
  await readEmbeddedReferencePack(canonical);
  return { sourceCount: 21, roots: manifest.roots };
}

/** Copy a previously prepared production deploy, never an existing App or a user-data directory. */
export async function stageStandaloneResources(options) {
  const { backendDirectory, contractsDirectory, nodeExecutable, nodeLicense, mysqlDirectory, referenceDirectory, outputDirectory } = options;
  for (const input of [backendDirectory, contractsDirectory, nodeExecutable, nodeLicense, mysqlDirectory, referenceDirectory, outputDirectory]) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.split(path.sep).some(part => part.endsWith('.app')))
      throw error('standalone_staging_input_invalid');
  }
  const output = path.resolve(outputDirectory);
  if (output === path.parse(output).root) throw error('standalone_staging_output_invalid');
  await mkdir(output, { mode: 0o700 }); // Refuse an existing output: never replace an old artifact.
  const copy = async (source, destination, productionModules = false) => {
    const original = await realpath(source);
    if (original === output || original.startsWith(`${output}${path.sep}`)) throw error('standalone_staging_input_invalid');
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(original, destination, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true,
      filter: candidate => {
        if (!productionModules) return true;
        const relative = path.relative(original, candidate);
        // Preserve actual packages and their links; generated pnpm CLI wrappers embed install paths.
        return !PNPM_INSTALL_METADATA.includes(relative) && relative !== '.bin'
          && !relative.endsWith(`${path.sep}node_modules${path.sep}.bin`);
      },
    });
  };
  for (const name of ['dist', 'node_modules', 'package.json']) await copy(path.join(backendDirectory, name), path.join(output, 'backend', name),
    name === 'node_modules');
  for (const name of ['openapi', 'json-schema', 'releases']) await copy(path.join(contractsDirectory, name), path.join(output, 'contracts', name));
  await copy(nodeExecutable, path.join(output, 'backend-runtime/node'));
  await copy(nodeLicense, path.join(output, 'backend-runtime/LICENSE'));
  for (const name of ['bin', 'lib', 'share', 'LICENSE', 'README']) await copy(path.join(mysqlDirectory, name), path.join(output, 'mysql', name));
  for (const name of ['manifest.json', 'books.json.gz']) await copy(path.join(referenceDirectory, name), path.join(output, 'system-reference', name));
  const roots = {};
  for (const name of ROOTS) {
    await readableBundleModes(path.join(output, name));
    roots[name] = await digestTree(path.join(output, name));
  }
  await writeFile(path.join(output, 'standalone-resources.json'), `${JSON.stringify({ version: 1, roots })}\n`, { mode: 0o644, flag: 'wx' });
  return verifyStandaloneResources(output);
}

/** Builder can omit production node_modules; copy the verified standalone tree explicitly after pack. */
export async function installStagedStandaloneResources(stagingRoot, resourcesPath) {
  await verifyStandaloneResources(stagingRoot);
  for (const name of [...ROOTS, 'standalone-resources.json']) {
    await cp(path.join(stagingRoot, name), path.join(resourcesPath, name), {
      recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true,
    });
  }
  return verifyStandaloneResources(resourcesPath);
}

/** Packaging only: nested code has just been signed; seal its final bytes before outer app signing. */
export async function refreshStandaloneResourceManifest(resourcesPath) {
  const roots = {};
  for (const name of ROOTS) roots[name] = await digestTree(path.join(resourcesPath, name));
  await writeFile(path.join(resourcesPath, 'standalone-resources.json'), `${JSON.stringify({ version: 1, roots })}\n`, { mode: 0o644 });
  return verifyStandaloneResources(resourcesPath);
}
