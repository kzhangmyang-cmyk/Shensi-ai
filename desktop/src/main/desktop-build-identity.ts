import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const HASH = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 4 * 1024 * 1024;
const invalid = () => new Error("desktop_build_identity_invalid");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type SourceRecord = Readonly<{ path: string; mode: number; size: number; sha256: string }>;
interface Common { version: 1; sourceRootHash: string; architecture: "arm64" | "x64"; bundleId: string; }
export type DesktopBuildManifest = Readonly<Common & ({ kind: "development"; records: readonly SourceRecord[] }
  | { kind: "packaged"; rendererSha256: string; mainSha256: string; sidecarSha256: string; runtimeConfigSha256: string; standaloneResourcesSha256?: string })>;

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw invalid();
  return value as Record<string, unknown>;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) throw invalid();
  return value;
}

// Both the development producer and Main use this exact versioned decoder.
// No App-tree digest is embedded: the canonical-file identity is non-self-referential.
export function decodeDesktopBuildManifest(text: string): DesktopBuildManifest {
  try {
    if (Buffer.byteLength(text) > MAX_BYTES) throw invalid();
    const parsed: unknown = JSON.parse(text);
    const kind = (parsed as { kind?: unknown } | null)?.kind;
    const hasStandalone = !!parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'standaloneResourcesSha256');
    const value = object(parsed, kind === "development"
      ? ["version", "kind", "sourceRootHash", "records", "architecture", "bundleId"]
      : ["version", "kind", "sourceRootHash", "rendererSha256", "mainSha256", "sidecarSha256", "runtimeConfigSha256", ...(hasStandalone ? ['standaloneResourcesSha256'] : []), "architecture", "bundleId"]);
    if (value.version !== 1 || !["development", "packaged"].includes(String(kind))
      || (value.architecture !== "arm64" && value.architecture !== "x64")
      || typeof value.bundleId !== "string" || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(value.bundleId)) throw invalid();
    const sourceRootHash = digest(value.sourceRootHash);
    let manifest: DesktopBuildManifest;
    if (kind === "development") {
      if (!Array.isArray(value.records) || value.records.length === 0) throw invalid();
      let previous = "";
      const records = value.records.map((item: unknown): SourceRecord => {
        const record = object(item, ["path", "mode", "size", "sha256"]);
        if (typeof record.path !== "string" || record.path <= previous || /[\\\u0000-\u001f\u007f]/u.test(record.path)
          || record.path.split("/").some((segment) => ["", ".", ".."].includes(segment))
          || typeof record.mode !== "number" || !Number.isSafeInteger(record.mode) || record.mode < 0 || record.mode > 0o777
          || typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size < 0) throw invalid();
        previous = record.path;
        return Object.freeze({ path: record.path, mode: record.mode, size: record.size, sha256: digest(record.sha256) });
      });
      // Task 1's canonical desktop-app content-manifest projection, unchanged.
      if (sha256(records.map((record) => `${record.path}\0${record.mode}\0${record.size}\0${record.sha256}\n`).join("")) !== sourceRootHash) throw invalid();
      manifest = { version: 1, kind: "development", sourceRootHash, records: Object.freeze(records), architecture: value.architecture, bundleId: value.bundleId };
    } else {
      manifest = { version: 1, kind: "packaged", sourceRootHash, rendererSha256: digest(value.rendererSha256), mainSha256: digest(value.mainSha256), sidecarSha256: digest(value.sidecarSha256), runtimeConfigSha256: digest(value.runtimeConfigSha256),
        ...(hasStandalone ? { standaloneResourcesSha256: digest(value.standaloneResourcesSha256) } : {}), architecture: value.architecture, bundleId: value.bundleId };
    }
    if (text !== `${JSON.stringify(manifest)}\n`) throw invalid();
    return Object.freeze(manifest);
  } catch { throw invalid(); }
}

async function directory(directoryPath: string, privateMode: boolean | "shared" = false): Promise<Stats> {
  if (!path.isAbsolute(directoryPath) || path.resolve(directoryPath) !== directoryPath
    || await fs.realpath(directoryPath) !== directoryPath) throw invalid();
  const info = await fs.lstat(directoryPath);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (privateMode && ((!process.getuid || info.uid !== process.getuid())
      || (privateMode === "shared" ? (info.mode & 0o7022) !== 0 : (info.mode & 0o7777) !== 0o700)))) throw invalid();
  return info;
}
function same(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
    && left.uid === right.uid && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
async function readManifest(manifestPath: string): Promise<{ manifest: DesktopBuildManifest; digest: string }> {
  const parent = path.dirname(manifestPath);
  const parentInfo = await directory(parent);
  const handle = await fs.open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o7777) !== 0o644 || before.size > MAX_BYTES) throw invalid();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    const named = await fs.lstat(manifestPath);
    const parentAfter = await directory(parent);
    if (bytesRead !== before.size || !same(before, after) || !same(before, named)
      || parentInfo.dev !== parentAfter.dev || parentInfo.ino !== parentAfter.ino) throw invalid();
    const bytes = buffer.subarray(0, bytesRead);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw invalid();
    return { manifest: decodeDesktopBuildManifest(text), digest: sha256(bytes) };
  } finally { await handle.close(); }
}

export async function readDesktopBuildIdentity(resourcesPath: string): Promise<string> {
  try {
    await directory(resourcesPath);
    const value = await readManifest(path.join(resourcesPath, "desktop-build-manifest.json"));
    if (value.manifest.kind !== "packaged") throw invalid();
    if (value.manifest.standaloneResourcesSha256) {
      const standalone = await fs.readFile(path.join(resourcesPath, 'standalone-resources.json'));
      if (standalone.length > 4096 || sha256(standalone) !== value.manifest.standaloneResourcesSha256) throw invalid();
    }
    return value.digest;
  } catch { throw invalid(); }
}

export async function readDevelopmentDesktopBuildIdentity(repositoryRoot: string, manifestPath: string): Promise<string> {
  try {
    await directory(repositoryRoot);
    const runtime = path.join(repositoryRoot, ".runtime");
    const devRoot = path.join(runtime, "desktop-dev");
    const relative = path.relative(devRoot, manifestPath);
    const segments = relative.split(path.sep);
    if (!path.isAbsolute(manifestPath) || path.resolve(manifestPath) !== manifestPath || segments.length !== 2
      || !HASH.test(segments[0]!) || segments[1] !== "desktop-build-manifest.json") throw invalid();
    const directories = [runtime, devRoot, path.dirname(manifestPath)];
    const before = await Promise.all(directories.map((entry, index) => directory(entry, index === 0 ? "shared" : true)));
    const value = await readManifest(manifestPath);
    for (const [index, entry] of directories.entries()) {
      const after = await directory(entry, index === 0 ? "shared" : true);
      if (before[index]!.dev !== after.dev || before[index]!.ino !== after.ino) throw invalid();
    }
    if (value.manifest.kind !== "development" || value.manifest.sourceRootHash !== segments[0]) throw invalid();
    return value.digest;
  } catch { throw invalid(); }
}
