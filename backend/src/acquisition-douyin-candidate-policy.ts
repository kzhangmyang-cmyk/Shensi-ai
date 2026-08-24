import type { BuyingStage } from "./acquisition-domain.js";

export type DouyinCandidatePolicyResult =
  | { status: "qualified"; buyingStage: BuyingStage; reason: null }
  | { status: "suppressed"; buyingStage: null; reason: string; retainDoNotContact: boolean };

const REFUSAL = /(?:勿扰|不需要|拒绝推销|请勿(?:联系|打扰)|不接受营销|别[来再]联系)/u;
const COMPLAINT = /(?:投诉|举报|骗子|骗人|维权|曝光)/u;
const MINOR_LABEL = /(?:未成年|小学生|初中生|高中生)/u;

/**
 * JavaScript `\b` only understands ASCII word characters, so it cannot
 * safely delimit Chinese age phrases. NFKC has already normalized full-width
 * digits; this parser then accepts ordinary punctuation/whitespace around an
 * explicit age and never infers an age from unrelated numbers.
 */
function statesMinorAge(text: string) {
  const ages = /(?:^|[^0-9])([0-9]{1,2})\s*岁(?=$|[^\p{L}\p{N}_])/gu;
  for (const match of text.matchAll(ages)) {
    const age = Number(match[1]);
    if (Number.isInteger(age) && age >= 0 && age < 18) return true;
  }
  return false;
}
const STAGES: Array<[RegExp, BuyingStage]> = [
  [/(?:正在采购|采购需求|招标|求购|马上购买|尽快上线|近期上线)/u, "purchase_ready"],
  [/(?:比价|对比|比较|询价|报价|方案选择)/u, "comparison"],
  [/(?:寻找(?:获客)?方案|了解(?:获客)?方案|调研|咨询|怎么做|解决方案)/u, "solution_research"],
  [/(?:获客难|成本高|需要|需求|痛点|缺少)/u, "problem_defined"]
];

/** Closed, deterministic gate run before any downstream model invocation. */
export function qualifyDouyinCrawlerCandidate(input: {
  text: string;
  hasOriginalPublicSource: boolean;
  hasKnownIdentity?: boolean;
  kind?: "creator" | "comment";
}): DouyinCandidatePolicyResult {
  const text = input.text.normalize("NFKC").trim();
  if (!input.hasOriginalPublicSource) {
    return { status: "suppressed", buyingStage: null, reason: "missing_original_public_source", retainDoNotContact: input.hasKnownIdentity !== false };
  }
  if (REFUSAL.test(text)) {
    return { status: "suppressed", buyingStage: null, reason: "explicit_refusal", retainDoNotContact: true };
  }
  if (COMPLAINT.test(text)) {
    return { status: "suppressed", buyingStage: null, reason: "complaint_signal", retainDoNotContact: true };
  }
  if (MINOR_LABEL.test(text) || statesMinorAge(text)) {
    return { status: "suppressed", buyingStage: null, reason: "minor_signal", retainDoNotContact: true };
  }
  if (input.kind === "creator") {
    return { status: "qualified", buyingStage: "awareness", reason: null };
  }
  const stage = STAGES.find(([matcher]) => matcher.test(text))?.[1];
  return stage
    ? { status: "qualified", buyingStage: stage, reason: null }
    : { status: "suppressed", buyingStage: null, reason: "buying_stage_not_allowed", retainDoNotContact: false };
}
