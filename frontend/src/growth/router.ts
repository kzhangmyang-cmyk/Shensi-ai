export type GrowthRoute =
  | { name: "advisor" }
  | { name: "agents" }
  | { name: "catalog" }
  | { name: "finance" }
  | { name: "financial-council"; runId?: string }
  | {
      name: "quote";
      quoteCaseId?: string;
      candidateId?: string;
      dealId?: string;
    }
  | {
      name: "roi";
      cohortId?: string;
      currency?: string;
      closureVersionId?: string;
    };

export function parseGrowthHash(hash: string): GrowthRoute | null {
  const [pathname, query = ""] = hash.replace(/^#/, "").split("?", 2);
  const params = new URLSearchParams(query);
  if (pathname === "growth/advisor") return { name: "advisor" };
  if (pathname === "growth/agents"
    || /^growth\/agents\/[A-Za-z0-9_-]+$/u.test(pathname)) {
    return { name: "agents" };
  }
  if (pathname === "growth/catalog") return { name: "catalog" };
  if (pathname === "growth/finance") return { name: "finance" };
  if (pathname === "financial-council") return { name: "financial-council" };
  if (pathname.startsWith("financial-council/run/")) {
    const encodedRunId = pathname.slice("financial-council/run/".length);
    if (!encodedRunId || encodedRunId.includes("/")) return null;
    try {
      const runId = decodeURIComponent(encodedRunId);
      return runId ? { name: "financial-council", runId } : null;
    } catch {
      return null;
    }
  }
  if (pathname === "growth/quotes") {
    return Object.assign(
      { name: "quote" as const },
      params.get("case") ? { quoteCaseId: params.get("case")! } : null,
      params.get("candidate")
        ? { candidateId: params.get("candidate")! } : null,
      params.get("deal") ? { dealId: params.get("deal")! } : null
    );
  }
  if (pathname === "growth/roi") {
    return Object.assign(
      { name: "roi" as const },
      params.get("cohort") ? { cohortId: params.get("cohort")! } : null,
      params.get("currency") ? { currency: params.get("currency")! } : null,
      params.get("closure")
        ? { closureVersionId: params.get("closure")! } : null
    );
  }
  return null;
}

export function growthHash(route: GrowthRoute): string {
  switch (route.name) {
    case "advisor":
    case "agents":
    case "catalog":
    case "finance":
      return `#growth/${route.name}`;
    case "financial-council":
      return route.runId
        ? `#financial-council/run/${encodeURIComponent(route.runId)}`
        : "#financial-council";
    case "quote": {
      const params = new URLSearchParams();
      if (route.quoteCaseId) params.set("case", route.quoteCaseId);
      if (route.candidateId) params.set("candidate", route.candidateId);
      if (route.dealId) params.set("deal", route.dealId);
      const query = params.toString();
      return query ? `#growth/quotes?${query}` : "#growth/quotes";
    }
    case "roi": {
      const params = new URLSearchParams();
      if (route.cohortId) params.set("cohort", route.cohortId);
      if (route.currency) params.set("currency", route.currency);
      if (route.closureVersionId) params.set("closure", route.closureVersionId);
      const query = params.toString();
      return query ? `#growth/roi?${query}` : "#growth/roi";
    }
  }
}
