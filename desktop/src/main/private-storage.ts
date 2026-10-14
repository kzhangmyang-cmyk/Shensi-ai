import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const queues = new Map<string, Promise<unknown>>();
const maximumBytes = 64 * 1024;
const owned = (uid: number) => process.getuid !== undefined && uid === process.getuid();
export const storageError = () => new Error("desktop_private_storage_invalid");
export function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

// Main's single-instance lifecycle is the process owner. Also serialize separate
// store instances in that process so asynchronous updates cannot lose a lane.
export function serialized<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(directory) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(directory, next);
  void next.finally(() => { if (queues.get(directory) === next) queues.delete(directory); }).catch(() => undefined);
  return next;
}

export function storageDirectory(directory: string): string {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw storageError();
  return directory;
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  // Parents are supplied by Main, never a Renderer path. Refuse symlinked
  // ancestors as well as a symlink in the dedicated store directory itself.
  if (await realpath(dirname(directory)) !== dirname(directory)) throw storageError();
  let created = false;
  try { await mkdir(directory, { mode: 0o700 }); created = true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw storageError();
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || !owned(info.uid) || (info.mode & 0o7777) !== 0o700) throw storageError();
  if (created) await syncDirectory(dirname(directory));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function readPrivateFile(directory: string, name: string): Promise<string | null> {
  await ensurePrivateDirectory(directory);
  let handle;
  try { handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isMissing(error)) return null; throw storageError(); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || !owned(before.uid) || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600 || before.size > maximumBytes) throw storageError();
    const bytes = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    const pathInfo = await lstat(join(directory, name));
    if (bytesRead > maximumBytes || before.size !== bytesRead || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || pathInfo.dev !== before.dev || pathInfo.ino !== before.ino || pathInfo.isSymbolicLink()) throw storageError();
    const data = bytes.subarray(0, bytesRead); const text = data.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(data)) throw storageError();
    return text;
  } finally { await handle.close(); }
}

export async function writePrivateFile(directory: string, name: string, content: string, exclusive = false): Promise<boolean> {
  await ensurePrivateDirectory(directory);
  if (Buffer.byteLength(content, "utf8") > maximumBytes) throw storageError();
  const existing = await readPrivateFile(directory, name);
  if (exclusive && existing !== null) return false;
  const temporary = join(directory, `.pending-${randomBytes(16).toString("hex")}`);
  const destination = join(directory, name);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
    // Validate an existing destination again; never silently replace a symlink,
    // non-owner file or a file whose permissions were changed during the write.
    await readPrivateFile(directory, name);
    if (exclusive) {
      try { await link(temporary, destination); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      await unlink(temporary);
    } else { await rename(temporary, destination); }
    await syncDirectory(directory);
    return true;
  } finally {
    await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw storageError(); });
  }
}

export async function removePrivateFile(directory: string, name: string): Promise<void> {
  if (await readPrivateFile(directory, name) === null) return;
  await unlink(join(directory, name)); await syncDirectory(directory);
}

export async function privateFileNames(directory: string): Promise<string[]> {
  await ensurePrivateDirectory(directory);
  // A crash can leave an unpublished temporary file. It is never authoritative.
  return (await readdir(directory)).filter((name) => !/^\.pending-[a-f0-9]{32}$/u.test(name)).sort();
}

export function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw storageError();
  return value as Record<string, unknown>;
}
export function safeIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) throw storageError();
  return value;
}
export function positiveVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw storageError();
  return value;
}
export function parsePrivateJson(value: string): unknown {
  try { return JSON.parse(value); } catch { throw storageError(); }
}
