import type {
  FinancialCfoNarrative,
  FinancialCfoNarrativeInput,
  FinancialCfoNarrativeOutput
} from "./financial-council-model-port.js";
import {
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";

export interface FinancialCfoNarrativePort {
  synthesize(
    input: FinancialCfoNarrativeInput
  ): Promise<FinancialCfoNarrativeOutput>;
}

export async function synthesizeFinancialCfoNarrative(
  port: FinancialCfoNarrativePort,
  rawInput: FinancialCfoNarrativeInput
): Promise<FinancialCfoNarrative> {
  const input = immutableFinancialCouncilInput(rawInput);
  try {
    const output = immutableFinancialCouncilInput(await port.synthesize(input));
    if (!validNarrative(input, output)) return template(input, "model_invalid");
    return immutableFinancialCouncilValue({
      ...output,
      narrativeStatus: "model_valid"
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return template(input, code === "financial_council_model_output_invalid"
      ? "model_invalid"
      : "model_unavailable");
  }
}

function validNarrative(
  input: FinancialCfoNarrativeInput,
  output: FinancialCfoNarrativeOutput
): boolean {
  if (!plainExact(output, ["overallDiagnosis", "priorityFindingIds",
    "minorityFindingIds", "riskNotes"])
    || typeof output.overallDiagnosis !== "string"
    || !validIds(output.priorityFindingIds)
    || !validIds(output.minorityFindingIds)
    || !Array.isArray(output.riskNotes)
    || output.riskNotes.length > 24
    || output.riskNotes.some((note) => typeof note !== "string"
      || note.length < 1 || note.length > 1_000)) return false;
  const accepted = new Set(input.acceptedFindings.map((row) => row.findingId));
  const minority = new Set(input.minorityFindings.map((row) => row.findingId));
  if (output.priorityFindingIds.some((id) => !accepted.has(id))
    || output.minorityFindingIds.some((id) => !minority.has(id))) return false;
  const submittedMinority = new Set(output.minorityFindingIds);
  if (input.minorityFindings.some((row) => row.severity === "critical"
    && !submittedMinority.has(row.findingId))) return false;
  const allowedIds = new Set([
    ...accepted,
    ...minority,
    ...input.unresolvedConflicts.flatMap((row) => row.findingIds)
  ]);
  const texts = [output.overallDiagnosis, ...output.riskNotes];
  if (output.overallDiagnosis.length < 1
    || output.overallDiagnosis.length > 2_000
    || texts.some((text) => prohibitedNarrative(text, allowedIds))) return false;
  return output.overallDiagnosis.split(/\n\s*\n/u).every((paragraph) =>
    referenced(paragraph, allowedIds))
    && output.riskNotes.every((note) => referenced(note, allowedIds));
}

function prohibitedNarrative(
  text: string,
  allowedIds: ReadonlySet<string>
): boolean {
  let prose = text;
  for (const id of allowedIds) prose = prose.replaceAll(`[${id}]`, "");
  return /\d|[零〇一二三四五六七八九十百千万亿兆壹贰叁肆伍陆柒捌玖拾佰仟两元倍成¥$￥%]|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|grand|doubled?|tripled?|halved?)\b|\bbps\b|基点|金额|人民币|美元|\bminor\b|合规|compliant|compliance|执行|实施|批准|动作|\baction\b|状态|\bstatus\b|推理过程|思考过程|chain[ -]?of[ -]?thought|\breasoning\b/iu
    .test(prose);
}

function referenced(text: string, allowedIds: ReadonlySet<string>): boolean {
  for (const id of allowedIds) {
    if (text.includes(`[${id}]`)) return true;
  }
  return false;
}

function validIds(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 100
    && value.every((id) => typeof id === "string" && id.length > 0
      && id.length <= 255)
    && new Set(value).size === value.length;
}

function plainExact(value: unknown, keys: readonly string[]):
value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every((key) => typeof key === "string")
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function template(
  input: FinancialCfoNarrativeInput,
  narrativeStatus: "model_unavailable" | "model_invalid"
): FinancialCfoNarrative {
  const priorityFindingIds = input.acceptedFindings.map((row) => row.findingId)
    .sort(compare);
  const minorityFindingIds = input.minorityFindings.map((row) => row.findingId)
    .sort(compare);
  const diagnosisIds = [...priorityFindingIds, ...minorityFindingIds];
  const overallDiagnosis = diagnosisIds.length === 0
    ? "服务端已保留确定性审计结果。"
    : `服务端已保留确定性审计结果：${diagnosisIds
      .map((id) => `[${id}]`).join("、")}。`;
  const riskNotes = input.unresolvedConflicts.map((conflict) =>
    `未解决的审计冲突已保留：${conflict.findingIds.map((id) =>
      `[${id}]`).join("、")}。`);
  return immutableFinancialCouncilValue({
    overallDiagnosis,
    priorityFindingIds,
    minorityFindingIds,
    riskNotes,
    narrativeStatus
  });
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
