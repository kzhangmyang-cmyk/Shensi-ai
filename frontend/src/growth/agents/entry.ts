export type AgentsRoute =
  | { view: "overview" }
  | { view: "report" }
  | { view: "detail"; agentId: string };

export function parseAgentsHash(hash: string): AgentsRoute | null {
  const pathname = hash.replace(/^#/, "").split("?")[0];
  if (pathname === "growth/agents") return { view: "overview" };
  if (pathname === "growth/agents/report") return { view: "report" };
  const match = /^growth\/agents\/([A-Za-z0-9_-]+)$/u.exec(pathname);
  if (match) return { view: "detail", agentId: match[1]! };
  return null;
}
