import { parseGrowthHash } from "./growth/router";

const standalone = new Set([
  "agents",
  "acquisition",
  "conversations",
  "private-domain",
  "conversion",
  "scripts",
  "trade-marketing",
  "settings"
]);

export function isStandaloneModuleHash(hash: string): boolean {
  return standalone.has(hash.replace(/^#/, ""));
}

export function normalizeAppHash(hash: string): string {
  const pathname = hash.replace(/^#/, "").split("?", 1)[0];
  if (pathname === "growth/agents" || pathname.startsWith("growth/agents/")) {
    return "#agents";
  }
  if (parseGrowthHash(hash)) return hash.startsWith("#") ? hash : `#${hash}`;
  return isStandaloneModuleHash(hash)
    ? `#${hash.replace(/^#/, "")}`
    : "#agents";
}
