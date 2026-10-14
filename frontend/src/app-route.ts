import { parseGrowthHash } from "./growth/router";

const standalone = new Set([
  "home",
  "dashboard",
  "agents",
  "knowledge",
  "acquisition",
  "conversations",
  "private-domain",
  "enterprise-query",
  "decision-simulation",
  "conversion",
  "scripts",
  "trade-marketing",
  "settings"
]);

export function isStandaloneModuleHash(hash: string): boolean {
  return standalone.has(hash.replace(/^#/, ""));
}

export function douyinLiveLoginSessionId(hash: string): string | null {
  const route = hash.replace(/^#/, "");
  const [pathname, query = ""] = route.split("?", 2);
  if (pathname !== "douyin-live-login") return null;
  const sessionId = new URLSearchParams(query).get("sessionId")?.trim() ?? "";
  return sessionId && sessionId.length <= 512 ? sessionId : null;
}

export function normalizeAppHash(hash: string): string {
  if(hash===''||hash==='#')return '#home';
  const pathname = hash.replace(/^#/, "").split("?", 1)[0];
  if (pathname === "knowledge") return hash.startsWith("#") ? hash : `#${hash}`;
  if (pathname === "douyin-live-login") {
    return hash.startsWith("#") ? hash : `#${hash}`;
  }
  if (pathname === "growth/agents" || pathname.startsWith("growth/agents/")) {
    return "#agents";
  }
  if (pathname === "conversion") return "#growth/quotes";
  if (pathname === "scripts" || pathname === "trade-marketing") return "#agents";
  if (parseGrowthHash(hash)) return hash.startsWith("#") ? hash : `#${hash}`;
  return isStandaloneModuleHash(hash)
    ? `#${hash.replace(/^#/, "")}`
    : "#agents";
}
