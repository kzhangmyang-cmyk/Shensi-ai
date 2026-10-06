import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, unlink } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import type { FileHandle } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { GrowthHttpError } from '../growth-command-context.js';
import { assertKnowledgeScope, KNOWLEDGE_MAX_BYTES, type KnowledgeScope, type KnowledgeVersionRecord } from './domain.js';
import { createKnowledgeCrypto } from './crypto.js';

const MAGIC = Buffer.from('SHKB001\0'), HEADER_BYTES = MAGIC.length + 12, TAG_BYTES = 16;
const invalid = () => new Error('knowledge_storage_invalid');
function fileWriter(handle: FileHandle, start = 0) {
  let position = start;
  return new Writable({ write(chunk: Buffer, _encoding, callback) {
    (async () => {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, position);
        if (!bytesWritten) throw invalid(); offset += bytesWritten; position += bytesWritten;
      }
    })().then(() => callback(), callback);
  } });
}
async function* fileReader(handle: FileHandle, start: number, end: number) {
  for (let position = start; position < end;) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, end - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) throw invalid(); position += bytesRead; yield buffer.subarray(0, bytesRead);
  }
}
async function privateEntry(path: string, directory: boolean) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (directory ? !info.isDirectory() : !info.isFile())
    || (info.mode & 0o7777) !== (directory ? 0o700 : 0o600)) throw invalid();
  return info;
}
async function privateDirectory(path: string) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await privateEntry(path, true);
}
function ownVersion(ctx: KnowledgeScope, version: KnowledgeVersionRecord, capability: 'knowledge.read' | 'knowledge.upload' | 'knowledge.manage_own') {
  assertKnowledgeScope(ctx, capability);
  if (version.workspaceId !== ctx.workspaceId || version.actorId !== ctx.actorId) throw new GrowthHttpError(404, 'knowledge_not_found');
  if (!Number.isSafeInteger(version.bytes) || version.bytes < 1 || version.bytes > KNOWLEDGE_MAX_BYTES) throw invalid();
}
function fileAad(version: KnowledgeVersionRecord) {
  return { workspaceId: version.workspaceId, actorId: version.actorId,
    kind: `original:${version.format}:${version.bytes}`, id: version.documentId, versionId: version.id };
}
export function createKnowledgeFileStore(options: { root: string; secret: string }) {
  if (!isAbsolute(options.root)) throw new Error('knowledge_storage_root_required');
  const crypto = createKnowledgeCrypto(options.secret);
  async function directories() {
    await privateDirectory(options.root);
    const root = await realpath(options.root), originals = join(root, 'originals'), temporary = join(root, 'temporary');
    await privateDirectory(originals); await privateDirectory(temporary);
    return { originals, temporary };
  }
  function originalPath(directory: string, version: KnowledgeVersionRecord) {
    if (!version.storageKey || !/^[A-Za-z0-9_-]{1,191}$/u.test(version.storageKey)) throw invalid();
    return join(directory, `${version.storageKey}.enc`);
  }
  return Object.freeze({
    async prepare() { await directories(); },
    async writeOriginal(ctx: KnowledgeScope, version: KnowledgeVersionRecord, source: Readable, signal?: AbortSignal) {
      ownVersion(ctx, version, 'knowledge.upload'); signal?.throwIfAborted();
      const { originals } = await directories(), storageKey = randomUUID();
      const pending = join(originals, `.pending-${storageKey}`), committed = join(originals, `${storageKey}.enc`);
      const handle = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const iv = randomBytes(12), cipher = crypto.fileCipher(fileAad(version), iv), hash = createHash('sha256');
      let bytes = 0, linked = false;
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > KNOWLEDGE_MAX_BYTES) return callback(new Error('knowledge_upload_too_large'));
        if (bytes > version.bytes) return callback(new Error('knowledge_upload_size_invalid'));
        hash.update(chunk); callback(null, chunk);
      } });
      try {
        await handle.write(Buffer.concat([MAGIC, iv]), 0, HEADER_BYTES, 0);
        await pipeline(source, meter, cipher, fileWriter(handle, HEADER_BYTES), { signal });
        if (bytes !== version.bytes) throw new Error('knowledge_upload_size_invalid');
        await handle.write(cipher.getAuthTag(), 0, TAG_BYTES, HEADER_BYTES + bytes); await handle.sync();
        await handle.close(); signal?.throwIfAborted();
        // Link, rather than rename, cannot replace an existing private original.
        await link(pending, committed); linked = true; await unlink(pending);
        return { storageKey, sourceHash: hash.digest('hex'), bytes };
      } catch (error) {
        await handle.close().catch(() => {}); await unlink(pending).catch(() => {});
        if (linked) await unlink(committed).catch(() => {}); throw error;
      }
    },
    async withOriginal<T>(ctx: KnowledgeScope, version: KnowledgeVersionRecord, consume: (path: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
      ownVersion(ctx, version, 'knowledge.read'); signal?.throwIfAborted();
      if (!version.uploadComplete || !version.sourceHash) throw invalid();
      const { originals, temporary } = await directories(), path = originalPath(originals, version);
      await privateEntry(path, false);
      const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let scratch: string | undefined;
      try {
        const info = await input.stat();
        if (!info.isFile() || info.size !== HEADER_BYTES + version.bytes + TAG_BYTES) throw invalid();
        const header = Buffer.alloc(HEADER_BYTES), tag = Buffer.alloc(TAG_BYTES);
        await input.read(header, 0, HEADER_BYTES, 0); await input.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES);
        if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw invalid();
        scratch = await mkdtemp(join(temporary, 'read-'));
        const plaintext = join(scratch, `original.${version.format}`);
        const output = await open(plaintext, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        let bytes = 0; const hash = createHash('sha256');
        const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > version.bytes) return callback(invalid()); hash.update(chunk); callback(null, chunk);
        } });
        try {
          const decipher = crypto.fileDecipher(fileAad(version), header.subarray(MAGIC.length), tag);
          await pipeline(Readable.from(fileReader(input, HEADER_BYTES, info.size - TAG_BYTES)),
            decipher, meter, fileWriter(output), { signal });
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new Error('knowledge_authentication_invalid');
        } finally { await output.close().catch(() => {}); }
        if (bytes !== version.bytes || hash.digest('hex') !== version.sourceHash) throw new Error('knowledge_authentication_invalid');
        signal?.throwIfAborted();
        // Neither parser nor download consumer receives unauthenticated bytes.
        return await consume(plaintext);
      } finally {
        await input.close();
        if (scratch) await rm(scratch, { recursive: true, force: true });
      }
    },
    async removeOriginal(ctx: KnowledgeScope, version: KnowledgeVersionRecord) {
      ownVersion(ctx, version, 'knowledge.manage_own');
      if (!version.storageKey) return;
      const { originals } = await directories(), path = originalPath(originals, version);
      try { await privateEntry(path, false); await unlink(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  });
}
export type KnowledgeFileStore = ReturnType<typeof createKnowledgeFileStore>;
