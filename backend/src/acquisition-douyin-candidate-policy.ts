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
  if ([...value].every((character) => character >= "0" && character <= "9")) {
    return Number(value);
  }
  return chineseAge(value);
}

function hasRefusal(text: string) {
  const compact = compactPolicyText(text);
  const startsWithTarget = (offset: number, targets: readonly string[]) =>
    targets.some((target) => compact.startsWith(target, offset));
  const consumeModifiers = (offset: number, modifiers: readonly string[]) => {
    let cursor = offset;
    let advanced = true;
    while (advanced) {
      advanced = false;
      for (const modifier of modifiers) {
        if (compact.startsWith(modifier, cursor)) {
          cursor += modifier.length;
          advanced = true;
          break;
        }
      }
    }
    return cursor;
  };
  for (let offset = 0; offset < compact.length; offset += 1) {
    if (compact.startsWith("勿扰", offset)
      || compact.startsWith("不需要", offset)) return true;
    if (compact.startsWith("拒绝", offset)) {
      const targetOffset = consumeModifiers(offset + "拒绝".length, ["再", "被"]);
      if (startsWithTarget(targetOffset, ["联系", "推销", "营销", "打扰"])) {
        return true;
      }
    }
    if (compact.startsWith("请勿", offset)
      && startsWithTarget(offset + "请勿".length, ["联系", "打扰", "推销", "营销"])) {
      return true;
    }
    if (compact.startsWith("不接受", offset)
      && startsWithTarget(offset + "不接受".length, ["营销", "推销", "联系"])) {
      return true;
    }
    for (const prefix of ["不要", "不想", "别"] as const) {
      if (!compact.startsWith(prefix, offset)) continue;
      const targetOffset = consumeModifiers(offset + prefix.length, ["来", "再", "被"]);
      if (startsWithTarget(targetOffset, ["联系", "打扰", "推销", "营销"])) {
        return true;
      }
    }
  }
  return false;
}

function statesMinorAge(text: string) {
  const compact = compactPolicyText(text);
  const arabic = (character: string | undefined) =>
    character !== undefined && character >= "0" && character <= "9";
  const chinese = (character: string | undefined) =>
    character !== undefined && "零一二三四五六七八九十".includes(character);
  const readNumber = (offset: number) => {
    const isArabic = arabic(compact[offset]);
    const isChinese = chinese(compact[offset]);
    if (!isArabic && !isChinese) return null;
    let end = offset;
    while (isArabic ? arabic(compact[end]) : chinese(compact[end])) end += 1;
    const token = compact.slice(offset, end);
    const age = numberToken(token);
    return age === null || !Number.isFinite(age) ? null : { age, end };
  };
  const hasAgeUnit = (offset: number) => compact[offset] === "岁"
    ? offset + 1
    : compact.startsWith("周岁", offset) ? offset + 2 : null;
  for (let offset = 0; offset < compact.length; offset += 1) {
    const qualifier = compact.startsWith("未满", offset)
      ? "未满" : compact.startsWith("不满", offset) ? "不满" : null;
    if (qualifier) {
      const parsed = readNumber(offset + qualifier.length);
      if (parsed && hasAgeUnit(parsed.end) !== null
        && parsed.age >= 0 && parsed.age <= 18) return true;
    }
    const parsed = readNumber(offset);
    if (!parsed || hasAgeUnit(parsed.end) === null) continue;
    const previous = compact[offset - 1];
    if ((arabic(compact[offset]) && arabic(previous))
      || (chinese(compact[offset]) && chinese(previous))) continue;
    if (parsed.age >= 0 && parsed.age < 18) return true;
  }
  return false;
}
const STAGES: Array<[RegExp, BuyingStage]> = [
  [/(?:正在采购|采购需求|招标|求购|马上购买|尽快上线|近期上线)/u, "purchase_ready"],
  [/(?:比价|对比|比较|询价|报价|方案选择|多少钱|怎么收费)/u, "comparison"],
  [/(?:寻找(?:获客)?方案|了解(?:获客)?方案|调研|咨询|怎么做|解决方案|求推荐|有推荐的吗)/u, "solution_research"],
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
    return { status: "suppressed", buyingStage: null, reason: "creator_context_only", retainDoNotContact: false };
  }
  const stage = STAGES.find(([matcher]) => matcher.test(text))?.[1];
  return stage
    ? { status: "qualified", buyingStage: stage, reason: null }
    : { status: "suppressed", buyingStage: null, reason: "buying_stage_not_allowed", retainDoNotContact: false };
}
