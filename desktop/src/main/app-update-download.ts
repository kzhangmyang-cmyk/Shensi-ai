import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { artifactUrl, type UpdateProgress, type UpdateRelease } from "../shared/app-update.ts";

export class UpdateDownloadError extends Error {
  constructor(readonly code: "cancelled" | "network" | "http" | "size" | "hash" | "untrusted" | "redirect") {
    super(code);
    this.name = "UpdateDownloadError";
  }
}

export async function downloadVerifiedArtifact(options: {
  release: UpdateRelease;
  directory: string;
  allowedHost: string;
  allowInsecureLoopback?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: UpdateProgress) => void;
}): Promise<{ filePath: string; sha256: string; size: number }> {
  const url = trustedDownloadUrl(options.release, options.allowedHost, options.allowInsecureLoopback === true);
  if (options.release.size < 1) throw new UpdateDownloadError("size");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const partial = path.join(options.directory, `.partial-${options.release.sha256}`);
  const finalPath = path.join(options.directory, url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: "error", signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) throw new UpdateDownloadError("cancelled");
    throw error instanceof UpdateDownloadError ? error : new UpdateDownloadError("network");
  }
  if (!response.ok || !response.body) throw new UpdateDownloadError("http");
  const declared = response.headers.get("content-length");
  if (declared !== null && declared !== String(options.release.size)) throw new UpdateDownloadError("size");
  const hash = createHash("sha256");
  const stream = createWriteStream(partial, { flags: "w", mode: 0o644 });
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      if (options.signal?.aborted) throw new UpdateDownloadError("cancelled");
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > options.release.size) throw new UpdateDownloadError("size");
      hash.update(chunk.value);
      await writeChunk(stream, chunk.value);
      options.onProgress?.({ received, total: options.release.size });
    }
    await finishStream(stream);
  } catch (error) {
    stream.destroy();
    await rm(partial, { force: true });
    if (options.signal?.aborted) throw new UpdateDownloadError("cancelled");
    throw error instanceof UpdateDownloadError ? error : new UpdateDownloadError("network");
  }
  if (received !== options.release.size) {
    await rm(partial, { force: true });
    throw new UpdateDownloadError("size");
  }
  const digest = hash.digest("hex");
  if (digest !== options.release.sha256) {
    await rm(partial, { force: true });
    throw new UpdateDownloadError("hash");
  }
  await rename(partial, finalPath);
  const info = await stat(finalPath);
  if (info.size !== options.release.size) throw new UpdateDownloadError("size");
  return { filePath: finalPath, sha256: digest, size: info.size };
}

function trustedDownloadUrl(release: UpdateRelease, allowedHost: string, allowInsecureLoopback: boolean): URL {
  if (allowInsecureLoopback && (allowedHost === "127.0.0.1" || allowedHost === "localhost")) {
    let url: URL;
    try { url = new URL(release.url); } catch { throw new UpdateDownloadError("untrusted"); }
    if (url.protocol !== "http:" || url.hostname !== allowedHost || url.username || url.password
      || url.search || url.hash || !url.pathname.endsWith(".dmg")) throw new UpdateDownloadError("untrusted");
    return url;
  }
  const url = artifactUrl(release.url, allowedHost);
  if (!url || url.toString() !== release.url) throw new UpdateDownloadError("untrusted");
  return url;
}

function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(Buffer.from(chunk), (error) => error ? reject(error) : resolve());
  });
}

function finishStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((error?: Error | null) => error ? reject(error) : resolve());
  });
}
