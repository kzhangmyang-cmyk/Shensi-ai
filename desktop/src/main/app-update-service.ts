import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  DESKTOP_RELEASE, manualInstallInstructions, parseUpdateFeed, selectUpdate, UPDATE_FEED_URL, UPDATE_PUBLISHER_HOST,
  type InstalledRelease, type PublicUpdateState, type UpdatePhase, type UpdateProgress, type UpdateRelease
} from "../shared/app-update.ts";
import { downloadVerifiedArtifact, UpdateDownloadError } from "./app-update-download.ts";

const ERROR_TEXT: Record<string, string> = {
  cancelled: "下载已取消。",
  network: "下载中断，请重试。",
  http: "更新服务器没有返回安装包。",
  size: "安装包大小与发布清单不一致。",
  hash: "安装包校验失败，已删除未完成文件。",
  untrusted: "发布地址不在允许的下载域名内。",
  feed: "更新清单无法读取。",
  platform: "没有适用于当前系统的安装包。"
};

export function createAppUpdateService(options: {
  installed: InstalledRelease;
  directory: string;
  feedUrl?: string;
  allowedHost?: string;
  allowInsecureLoopback?: boolean;
  fetchImpl?: typeof fetch;
  reveal?: (filePath: string) => Promise<void>;
  onState?: (state: PublicUpdateState) => void;
}) {
  const feedUrl = options.feedUrl ?? UPDATE_FEED_URL;
  const allowedHost = options.allowedHost ?? UPDATE_PUBLISHER_HOST;
  let phase: UpdatePhase = "idle";
  let release: UpdateRelease | null = null;
  let progress: UpdateProgress | null = null;
  let error: string | null = null;
  let verified: { filePath: string; fileName: string } | null = null;
  let abort: AbortController | null = null;
  let flight: Promise<void> | null = null;

  const snapshot = (): PublicUpdateState => ({
    phase,
    installedVersion: options.installed.version,
    releaseSequence: options.installed.releaseSequence,
    availableVersion: release?.version ?? null,
    title: release?.title ?? null,
    notes: release?.notes ?? null,
    size: release?.size ?? null,
    progress,
    error,
    fileName: verified?.fileName ?? null,
    automaticInstallSupported: false,
    installMode: "manual-dmg",
    instructions: verified ? manualInstallInstructions(verified.fileName) : null
  });
  const publish = () => { options.onState?.(snapshot()); return snapshot(); };
  const fail = (code: string) => {
    phase = "failed";
    error = ERROR_TEXT[code] ?? ERROR_TEXT.network!;
    progress = null;
    abort = null;
    return publish();
  };

  async function loadFeed(signal?: AbortSignal): Promise<UpdateRelease | null> {
    const response = await (options.fetchImpl ?? globalThis.fetch)(feedUrl, { redirect: "error", signal });
    if (!response.ok) throw new Error("feed");
    const feed = parseUpdateFeed(await response.json(), options.allowInsecureLoopback
      ? { allowInsecureLoopbackHost: allowedHost } : undefined);
    if (!feed) throw new Error("feed");
    return selectUpdate(options.installed, feed);
  }

  return {
    getState: snapshot,
    identity: () => ({ ...DESKTOP_RELEASE, buildManifestSha256: options.installed.buildManifestSha256 }),
    async check() {
      if (flight) return snapshot();
      phase = "checking";
      error = null;
      publish();
      try {
        const next = await loadFeed();
        release = next;
        verified = null;
        phase = next ? "available" : "current";
        if (!next && options.installed.platform !== "darwin") {
          phase = "failed";
          error = ERROR_TEXT.platform!;
        }
      } catch {
        return fail("feed");
      }
      return publish();
    },
    download() {
      if (!release || flight) return Promise.resolve(snapshot());
      const selected = release;
      const controller = new AbortController();
      abort = controller;
      phase = "downloading";
      error = null;
      progress = { received: 0, total: selected.size };
      verified = null;
      publish();
      flight = (async () => {
        await mkdir(options.directory, { recursive: true, mode: 0o700 });
        const saved = await downloadVerifiedArtifact({
          release: selected,
          directory: options.directory,
          allowedHost,
          allowInsecureLoopback: options.allowInsecureLoopback,
          fetchImpl: options.fetchImpl,
          signal: controller.signal,
          onProgress: (value) => {
            phase = "downloading";
            progress = value;
            publish();
          }
        });
        verified = { filePath: saved.filePath, fileName: path.basename(saved.filePath) };
        phase = "verified";
        progress = { received: saved.size, total: saved.size };
        error = null;
      })().catch((reason: unknown) => {
        const code = reason instanceof UpdateDownloadError ? reason.code : "network";
        if (code === "cancelled") {
          phase = release ? "available" : "idle";
          error = ERROR_TEXT.cancelled!;
          progress = null;
          return;
        }
        phase = "failed";
        error = ERROR_TEXT[code] ?? ERROR_TEXT.network!;
        progress = null;
      }).finally(() => {
        abort = null;
        flight = null;
        publish();
      });
      return flight.then(() => snapshot());
    },
    cancel() {
      abort?.abort();
      return Promise.resolve(snapshot());
    },
    retry() {
      if (flight) return Promise.resolve(snapshot());
      return this.download();
    },
    async reveal() {
      if (!verified) return snapshot();
      await options.reveal?.(verified.filePath);
      return snapshot();
    }
  };
}

export function installedRelease(input: {
  platform: string;
  arch: string;
  buildManifestSha256: string | null;
}): InstalledRelease {
  return {
    version: DESKTOP_RELEASE.version,
    releaseSequence: DESKTOP_RELEASE.releaseSequence,
    platform: input.platform,
    arch: input.arch,
    buildManifestSha256: input.buildManifestSha256
  };
}
