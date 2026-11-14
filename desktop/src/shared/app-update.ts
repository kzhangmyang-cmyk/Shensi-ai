/** Identity of this source tree. 0.1.0 was reused by unrelated packages, so order is releaseSequence. */
export const DESKTOP_RELEASE = Object.freeze({
  version: "0.2.0",
  releaseSequence: 1,
  channel: "stable" as const
});

export const UPDATE_CHANNELS = Object.freeze({
  getState: "shensi:update:get-state",
  check: "shensi:update:check",
  download: "shensi:update:download",
  cancel: "shensi:update:cancel",
  retry: "shensi:update:retry",
  reveal: "shensi:update:reveal",
  changed: "shensi:update:changed"
});

export const UPDATE_FEED_URL = "https://www.shensi.me/downloads/desktop-updates.json";
export const UPDATE_PUBLISHER_HOST = "www.shensi.me";
export const UPDATE_DOWNLOAD_PREFIX = "/downloads/";
export const MAX_UPDATE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_RELEASE_NOTES = 1000;

const SEMVER = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const DMG_NAME = /^Shensi-[0-9A-Za-z._+-]{1,80}\.dmg$/u;

export type DesktopArch = "arm64" | "x64";
export type UpdateInstallMode = "manual-dmg";

export interface UpdateRelease {
  releaseSequence: number;
  version: string;
  platform: "darwin";
  arch: DesktopArch;
  buildManifestSha256: string;
  gitSha?: string;
  url: string;
  sha256: string;
  size: number;
  publishedAt: string;
  title: string;
  notes: string;
}

export interface UpdateFeed {
  feedVersion: 1;
  channel: "stable";
  releases: readonly UpdateRelease[];
}

export interface InstalledRelease {
  version: string;
  releaseSequence: number;
  platform: string;
  arch: string;
  buildManifestSha256: string | null;
}

export interface UpdateProgress {
  received: number;
  total: number | null;
}

export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "verifying" | "verified" | "failed";

export interface PublicUpdateState {
  phase: UpdatePhase;
  installedVersion: string;
  releaseSequence: number;
  availableVersion: string | null;
  title: string | null;
  notes: string | null;
  size: number | null;
  progress: UpdateProgress | null;
  error: string | null;
  fileName: string | null;
  automaticInstallSupported: false;
  installMode: "manual-dmg";
  instructions: string | null;
}

const RELEASE_KEYS = ["releaseSequence", "version", "platform", "arch", "buildManifestSha256", "url", "sha256", "size", "publishedAt", "title", "notes"] as const;

export function parseSemver(value: string): [number, number, number] | null {
  const match = SEMVER.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(left: string, right: string): -1 | 0 | 1 | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
}

export function sanitizeReleaseText(value: string, max = MAX_RELEASE_NOTES): string {
  const cleaned = value
    .replace(/<[^>]*>/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export function artifactUrl(value: string, host = UPDATE_PUBLISHER_HOST): URL | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password
    || url.search || url.hash || !url.pathname.startsWith(UPDATE_DOWNLOAD_PREFIX)
    || url.pathname.includes("..")) return null;
  const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  if (!DMG_NAME.test(name)) return null;
  return url;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function loopbackDownloadUrl(value: string, host: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === host && !url.username && !url.password
      && !url.search && !url.hash && url.pathname.endsWith(".dmg");
  } catch { return false; }
}

function release(value: unknown, loopbackHost?: string): UpdateRelease | null {
  const item = record(value);
  if (!item) return null;
  const keys = Object.keys(item);
  if (keys.some((key) => !RELEASE_KEYS.includes(key as typeof RELEASE_KEYS[number]) && key !== "gitSha")) return null;
  if (!RELEASE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(item, key))) return null;
  const sequence = item.releaseSequence;
  const size = item.size;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1
    || typeof item.version !== "string" || !parseSemver(item.version)
    || item.platform !== "darwin" || (item.arch !== "arm64" && item.arch !== "x64")
    || typeof item.buildManifestSha256 !== "string" || !SHA256.test(item.buildManifestSha256)
    || typeof item.sha256 !== "string" || !SHA256.test(item.sha256)
    || typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_UPDATE_BYTES
    || typeof item.publishedAt !== "string" || Number.isNaN(Date.parse(item.publishedAt))
    || typeof item.title !== "string" || typeof item.notes !== "string"
    || typeof item.url !== "string"
    || !(artifactUrl(item.url) || (loopbackHost && loopbackDownloadUrl(item.url, loopbackHost)))) return null;
  if (item.gitSha !== undefined && (typeof item.gitSha !== "string" || !GIT_SHA.test(item.gitSha))) return null;
  const title = sanitizeReleaseText(item.title, 120);
  const notes = sanitizeReleaseText(item.notes);
  if (!title || title !== item.title || notes !== item.notes) return null;
  return {
    releaseSequence: sequence,
    version: item.version,
    platform: "darwin",
    arch: item.arch,
    buildManifestSha256: item.buildManifestSha256,
    ...(typeof item.gitSha === "string" ? { gitSha: item.gitSha } : {}),
    url: item.url,
    sha256: item.sha256,
    size,
    publishedAt: item.publishedAt,
    title,
    notes
  };
}

export function parseUpdateFeed(value: unknown, options?: { allowInsecureLoopbackHost?: string }): UpdateFeed | null {
  const feed = record(value);
  if (!feed || Object.keys(feed).length !== 3 || feed.feedVersion !== 1 || feed.channel !== "stable"
    || !Array.isArray(feed.releases) || feed.releases.length > 20) return null;
  const releases: UpdateRelease[] = [];
  const seen = new Set<number>();
  for (const item of feed.releases) {
    const parsed = release(item, options?.allowInsecureLoopbackHost);
    if (!parsed || seen.has(parsed.releaseSequence)) return null;
    seen.add(parsed.releaseSequence);
    releases.push(parsed);
  }
  return { feedVersion: 1, channel: "stable", releases };
}

/** Newer sequence only. A lower semver is never selected, even if its sequence is higher. */
export function selectUpdate(installed: InstalledRelease, feed: UpdateFeed): UpdateRelease | null {
  if (installed.platform !== "darwin" || (installed.arch !== "arm64" && installed.arch !== "x64")) return null;
  const candidates = feed.releases.filter((item) => item.arch === installed.arch
    && item.releaseSequence > installed.releaseSequence
    && item.buildManifestSha256 !== installed.buildManifestSha256
    && compareSemver(item.version, installed.version) !== -1
    && compareSemver(item.version, installed.version) !== null);
  candidates.sort((left, right) => right.releaseSequence - left.releaseSequence);
  return candidates[0] ?? null;
}

export function manualInstallInstructions(fileName: string): string {
  return `已校验 ${fileName}。当前安装包是 ad-hoc 签名，没有 Developer ID，也没有公证，应用不能替换正在运行的程序。请退出 Shensi，打开这个 DMG，把 Shensi 拖到“应用程序”文件夹后再打开。`;
}
