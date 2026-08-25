import type { BuyingStage } from "./acquisition-domain.js";

export type DouyinCandidatePolicyResult =
  | { status: "qualified"; buyingStage: BuyingStage; reason: null }
  | { status: "suppressed"; buyingStage: null; reason: string; retainDoNotContact: boolean };

const COMPLAINT = /(?:投诉|举报|骗子|骗人|维权|曝光)/u;
const MINOR_LABEL = /(?:未成年|小学生|初中生|高中生)/u;

/**
 * JavaScript `\b` only understands ASCII word characters, so it cannot
 * safely delimit Chinese age phrases. NFKC has already normalized full-width
 * digits; this parser then accepts ordinary punctuation/whitespace around an
 * explicit age and never infers an age from unrelated numbers.
 */
function chineseAge(value: string) {
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value in digits) return digits[value]!;
  const ten = value.indexOf("十");
  if (ten < 0 || value.split("十").length !== 2) return null;
  const left = value.slice(0, ten);
  const right = value.slice(ten + 1);
  if ((left && !(left in digits)) || (right && !(right in digits))) return null;
  return (left ? digits[left]! : 1) * 10 + (right ? digits[right]! : 0);
}

function compactPolicyText(value: string) {
  return value.normalize("NFKC").replace(/[\s\p{Cf}\p{Zs}\p{Zl}\p{Zp}]+/gu, "");
}

function numberToken(value: string) {
  if (/^[0-9]+$/u.test(value)) return Number(value);
  return chineseAge(value);
}

function hasRefusal(text: string) {
  const compact = compactPolicyText(text);
  return ["勿扰", "不需要", "拒绝推销", "拒绝联系", "拒绝联系我", "拒绝被联系", "请勿联系", "请勿打扰", "不接受营销", "别联系", "别再联系", "不要联系", "不要再联系", "不想联系", "不想被联系"].some((phrase) => compact.includes(phrase));
}

function statesMinorAge(text: string) {
  const compact = compactPolicyText(text);
  for (const match of compact.matchAll(/(?:未满|不满)([0-9零一二三四五六七八九十]+)岁/gu)) {
    const age = numberToken(match[1]!);
    if (age !== null && Number.isFinite(age) && age <= 18) return true;
  }
  const ages = /(?<![0-9])([0-9]+)岁/gu;
  for (const match of compact.matchAll(ages)) {
    const age = Number(match[1]);
    if (Number.isInteger(age) && age >= 0 && age < 18) return true;
  }
  const chineseAges = /([零一二三四五六七八九十]+)岁/gu;
  for (const match of compact.matchAll(chineseAges)) {
    const age = chineseAge(match[1]!);
    if (age !== null && age >= 0 && age < 18) return true;
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
  if (hasRefusal(text)) {
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
