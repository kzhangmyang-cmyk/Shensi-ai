import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface EmbeddedReferencePack { path: string; sha256: string; }
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const invalid = () => new Error('embedded_reference_pack_invalid');

/** Main-only, fixed read-only resources. Never accepts a renderer-selected path. */
export async function readEmbeddedReferencePack(resourcesPath: string): Promise<EmbeddedReferencePack> {
  try {
    if (!path.isAbsolute(resourcesPath)) throw invalid();
    const root = await realpath(resourcesPath);
    const directory = path.join(root, 'system-reference');
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
    const manifestHandle = await open(path.join(directory, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    let manifest;
    try {
      const stat = await manifestHandle.stat();
      if (!stat.isFile() || stat.size > 4096) throw invalid();
      manifest = JSON.parse(await manifestHandle.readFile('utf8'));
    } finally { await manifestHandle.close(); }
    const keys = ['version', 'file', 'sha256', 'sourceCount', 'corpusId', 'releaseId'];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || Object.keys(manifest).length !== keys.length || keys.some(key => !Object.hasOwn(manifest, key))
      || manifest.version !== 1 || manifest.file !== 'books.json.gz' || manifest.sourceCount !== 21
      || typeof manifest.sha256 !== 'string' || !HASH.test(manifest.sha256)
      || typeof manifest.corpusId !== 'string' || !UUID.test(manifest.corpusId)
      || typeof manifest.releaseId !== 'string' || !UUID.test(manifest.releaseId)) throw invalid();
    const packPath = path.join(directory, 'books.json.gz');
    const pack = await open(packPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await pack.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > 128 * 1024 * 1024) throw invalid();
      const hash = createHash('sha256');
      for await (const bytes of pack.createReadStream({ autoClose: false })) hash.update(bytes);
      if (hash.digest('hex') !== manifest.sha256) throw invalid();
    } finally { await pack.close(); }
    return { path: packPath, sha256: manifest.sha256 };
  } catch { throw invalid(); }
}

export function embeddedReferenceEnvironment(pack?: EmbeddedReferencePack): Readonly<Record<string, string>> {
  if (!pack) return {};
  if (!path.isAbsolute(pack.path) || path.basename(pack.path) !== 'books.json.gz' || !HASH.test(pack.sha256)) throw invalid();
  return { SHENSI_REFERENCE_MODE: 'embedded', SHENSI_REFERENCE_PACK: pack.path, SHENSI_REFERENCE_PACK_SHA256: pack.sha256 };
}
