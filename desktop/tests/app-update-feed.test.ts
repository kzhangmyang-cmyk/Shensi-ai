import { strict as assert } from "node:assert";
import { parseUpdateFeed, selectUpdate, sanitizeReleaseText, type UpdateRelease } from "../src/shared/app-update.ts";
import { publishDesktopUpdate } from "../src/shared/publish-desktop-update.ts";

const release = (overrides: Partial<UpdateRelease> = {}): UpdateRelease => ({
  releaseSequence: 2,
  version: "0.2.0",
  platform: "darwin",
  arch: "arm64",
  buildManifestSha256: "b".repeat(64),
  url: "https://www.shensi.me/downloads/Shensi-0.2.0-arm64.dmg",
  sha256: "c".repeat(64),
  size: 100,
  publishedAt: "2026-11-14T00:00:00.000Z",
  title: "Shensi 0.2.0",
  notes: "修复登录提示。",
  ...overrides
});

const feed = (item: UpdateRelease) => parseUpdateFeed({ feedVersion: 1, channel: "stable", releases: [item] });

assert.equal(feed(release())?.releases.length, 1);
assert.equal(parseUpdateFeed({ feedVersion: 1, channel: "stable", releases: [release({ url: "http://www.shensi.me/downloads/Shensi.dmg" })] }), null);
assert.equal(parseUpdateFeed({ feedVersion: 1, channel: "stable", releases: [release({ url: "https://downloads.example/Shensi-0.2.0-arm64.dmg" })] }), null);
assert.equal(parseUpdateFeed({ feedVersion: 1, channel: "stable", releases: [release()], extra: true }), null);
assert.equal(parseUpdateFeed({ feedVersion: 1, channel: "stable", releases: [release({ notes: "<script>alert(1)</script>" })] }), null);
assert.equal(sanitizeReleaseText("第一行\n<script>x</script>"), "第一行\nx");

const installed = { version: "0.2.0", releaseSequence: 1, platform: "darwin", arch: "arm64", buildManifestSha256: "a".repeat(64) };
assert.equal(selectUpdate(installed, feed(release({ releaseSequence: 1 }))!), null);
assert.equal(selectUpdate(installed, feed(release({ version: "0.1.0", releaseSequence: 9 }))!), null);
assert.equal(selectUpdate(installed, feed(release({ buildManifestSha256: installed.buildManifestSha256 }))!)?.releaseSequence, undefined);
assert.equal(selectUpdate({ ...installed, arch: "x64" }, feed(release())!), null);
assert.equal(selectUpdate(installed, feed(release({ version: "0.2.0", releaseSequence: 3 }))!)?.releaseSequence, 3);
assert.equal(selectUpdate({ ...installed, platform: "linux" }, feed(release())!), null);

const published = publishDesktopUpdate(null, release());
assert.match(published, /"releaseSequence": 2/);
assert.throws(() => publishDesktopUpdate(published, release({ releaseSequence: 2 })), /sequence_not_newer/);
assert.throws(() => publishDesktopUpdate(published, release({ releaseSequence: 4, version: "0.1.9" })), /version_downgrade/);
console.log(JSON.stringify({ ok: true, suite: "app-update-feed" }));
