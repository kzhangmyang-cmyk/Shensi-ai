import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import { downloadVerifiedArtifact } from "../src/main/app-update-download.ts";
import { createAppUpdateService } from "../src/main/app-update-service.ts";
import type { UpdateRelease } from "../src/shared/app-update.ts";

const payload = Buffer.from("shensi-update-bytes");
const digest = createHash("sha256").update(payload).digest("hex");
const directory = await mkdtemp(path.join(tmpdir(), "shensi-update-"));
let port = 0;
const server = createServer((request, response) => {
  if (request.url === "/feed") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ feedVersion: 1, channel: "stable", releases: [release(`http://127.0.0.1:${port}/Shensi-0.2.1-arm64.dmg`)] }));
    return;
  }
  if (request.url === "/slow.dmg") {
    response.write(payload.subarray(0, 4));
    return;
  }
  response.setHeader("content-length", String(payload.byteLength));
  response.end(payload);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no port");
port = address.port;

function release(url: string, overrides: Partial<UpdateRelease> = {}): UpdateRelease {
  return {
    releaseSequence: 2, version: "0.2.1", platform: "darwin", arch: "arm64",
    buildManifestSha256: "b".repeat(64), url, sha256: digest, size: payload.byteLength,
    publishedAt: "2026-11-14T00:00:00.000Z", title: "Shensi 0.2.1", notes: "校验后手动安装。",
    ...overrides
  };
}

const progress: number[] = [];
const saved = await downloadVerifiedArtifact({
  release: release(`http://127.0.0.1:${port}/Shensi-0.2.1-arm64.dmg`),
  directory, allowedHost: "127.0.0.1", allowInsecureLoopback: true,
  onProgress: (value) => progress.push(value.received)
});
assert.equal(saved.sha256, digest);
assert.deepEqual(await readFile(saved.filePath), payload);
assert.ok(progress.at(-1) === payload.byteLength);

await assert.rejects(downloadVerifiedArtifact({
  release: release(`http://127.0.0.1:${port}/Shensi-0.2.1-arm64.dmg`, { sha256: "d".repeat(64) }),
  directory, allowedHost: "127.0.0.1", allowInsecureLoopback: true
}), /hash/);

const controller = new AbortController();
const cancelled = downloadVerifiedArtifact({
  release: release(`http://127.0.0.1:${port}/slow.dmg`, { size: 100, sha256: "e".repeat(64) }),
  directory, allowedHost: "127.0.0.1", allowInsecureLoopback: true, signal: controller.signal
});
controller.abort();
await assert.rejects(cancelled, /cancelled/);

const service = createAppUpdateService({
  installed: { version: "0.2.0", releaseSequence: 1, platform: "darwin", arch: "arm64", buildManifestSha256: "a".repeat(64) },
  directory, feedUrl: `http://127.0.0.1:${address.port}/feed`, allowedHost: "127.0.0.1", allowInsecureLoopback: true,
  reveal: async (filePath) => { revealed = filePath; }
});
let revealed = "";
const available = await service.check();
assert.equal(available.phase, "available");
assert.equal(available.automaticInstallSupported, false);
const verified = await service.download();
assert.equal(verified.phase, "verified");
assert.match(verified.instructions ?? "", /Developer ID/);
assert.match(verified.instructions ?? "", /手动|拖到/);
await service.reveal();
assert.match(revealed, /Shensi-0\.2\.1-arm64\.dmg$/u);
server.close();
await rm(directory, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, suite: "app-update-download" }));
