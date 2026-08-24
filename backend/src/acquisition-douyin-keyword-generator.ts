import { ACQUISITION_OUTREACH_KEYWORD_TOOL, acquisitionOutreachModelRequest } from "./acquisition-outreach-model-content.js";
import type { AcquisitionPiGatewayPort } from "./acquisition-pi-gateway-runtime.js";

export function canonicalizeDouyinKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const identities = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const keyword = raw.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!keyword || [...keyword].length > 100) continue;
    const identity = keyword.toLocaleLowerCase("en-US");
    if (identities.has(identity)) continue;
    identities.add(identity);
    result.push(keyword);
    if (result.length === 20) break;
  }
  return result;
}

export function parseDouyinKeywordToolArguments(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OUTREACH_MODEL_RESPONSE_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !("keywords" in record)
    || !Array.isArray(record.keywords) || !record.keywords.length
    || record.keywords.length > 20
    || record.keywords.some((item) => typeof item !== "string")) {
    throw new Error("OUTREACH_MODEL_RESPONSE_INVALID");
  }
  const keywords = canonicalizeDouyinKeywords(record.keywords);
  if (!keywords.length) throw new Error("OUTREACH_MODEL_RESPONSE_INVALID");
  return keywords;
}

export async function generateDouyinKeywords(input: {
  gateway: AcquisitionPiGatewayPort;
  modelSnapshotId: string;
  business: string;
  icp: unknown;
}) {
  if (!input.modelSnapshotId.trim()) throw new Error("MODEL_SNAPSHOT_UNAVAILABLE");
  const request = acquisitionOutreachModelRequest({ operation: "keywords", payload: {
    business: input.business, icp: input.icp
  } });
  const result = await input.gateway.callTools({
    contentBinding: request.contentBinding, parallelToolCalls: false
  });
  if (result.toolCalls.length !== 1 || result.toolCalls[0]?.name !== ACQUISITION_OUTREACH_KEYWORD_TOOL) {
    throw new Error("OUTREACH_MODEL_RESPONSE_INVALID");
  }
  const keywords = parseDouyinKeywordToolArguments(result.toolCalls[0].arguments);
  return Object.freeze({ keywords: Object.freeze(keywords), modelSnapshotId: input.modelSnapshotId });
}
