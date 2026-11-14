import { compareSemver, parseUpdateFeed, sanitizeReleaseText, artifactUrl, type UpdateFeed, type UpdateRelease } from "./app-update.ts";

export function publishDesktopUpdate(existingText: string | null, release: UpdateRelease): string {
  if (!artifactUrl(release.url) || sanitizeReleaseText(release.notes) !== release.notes
    || sanitizeReleaseText(release.title, 120) !== release.title) throw new Error("release_not_publishable");
  const existing = existingText ? parseUpdateFeed(JSON.parse(existingText)) : { feedVersion: 1 as const, channel: "stable" as const, releases: [] };
  if (!existing) throw new Error("existing_feed_invalid");
  const sameArch = existing.releases.filter((item) => item.arch === release.arch && item.platform === release.platform);
  const maxSequence = sameArch.reduce((max, item) => Math.max(max, item.releaseSequence), 0);
  if (release.releaseSequence <= maxSequence) throw new Error("sequence_not_newer");
  for (const item of sameArch) {
    if (compareSemver(release.version, item.version) === -1) throw new Error("version_downgrade");
  }
  const feed: UpdateFeed = { feedVersion: 1, channel: "stable", releases: [...existing.releases, release] };
  if (!parseUpdateFeed(feed)) throw new Error("release_not_publishable");
  return `${JSON.stringify(feed, null, 2)}\n`;
}
