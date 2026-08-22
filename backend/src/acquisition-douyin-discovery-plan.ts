import type {
  AcquisitionSubjectChannel,
  AcquisitionTargetPlatform
} from "./acquisition-plan-run-repository.js";

const SEARCH_TOOL_QUERY_MAX_LENGTH = 1_000;
const DOUYIN_ROOT_PREFIXES = [
  "site:douyin.com ",
  "site:iesdouyin.com "
] as const;
const DEFAULT_IGNORABLE_CODE_POINTS =
  /\p{Default_Ignorable_Code_Point}/gu;
const CONTROL_CHARACTERS = /\p{Cc}/gu;
const DEFAULT_IGNORABLE_CODE_POINT_PRESENT =
  /\p{Default_Ignorable_Code_Point}/u;
const CONTROL_CHARACTER_PRESENT = /\p{Cc}/u;
const SITE_CLAUSES =
  /(?<![\p{L}\p{N}_])[-+]?\s*site\s*:\s*(?:"[^"]*"|'[^']*'|[^\s)\]}>'",;\uff0c\u3002!?\uff01\uff1f]+)/giu;
const SITE_CLAUSE_REMAINS =
  /(?<![\p{L}\p{N}_])[-+]?\s*site\s*:/iu;
const SEMANTIC_CONTENT = /[\p{L}\p{N}]/u;

export interface AcquisitionDiscoveryQueryIntent {
  subjectChannel: AcquisitionSubjectChannel;
  query: string;
}

function normalizedQuery(value: string) {
  return value
    .normalize("NFKC")
    .replace(DEFAULT_IGNORABLE_CODE_POINTS, "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function stripSiteClauses(value: string) {
  return value
    .replace(SITE_CLAUSES, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function boundedQuery(value: string, maxLength: number) {
  let result = value.slice(0, maxLength);
  const finalCodeUnit = result.charCodeAt(result.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    result = result.slice(0, -1);
  }
  return result.trimEnd();
}

function addUnique(
  output: AcquisitionDiscoveryQueryIntent[],
  seen: Set<string>,
  subjectChannel: AcquisitionSubjectChannel,
  query: string
) {
  const key = `${subjectChannel}\u0000${query}`;
  if (seen.has(key)) return;
  seen.add(key);
  output.push({ subjectChannel, query });
}

export function compileAcquisitionDiscoveryQueries(input: {
  targetPlatform: AcquisitionTargetPlatform;
  queryIntents: readonly AcquisitionDiscoveryQueryIntent[];
}): AcquisitionDiscoveryQueryIntent[] {
  const output: AcquisitionDiscoveryQueryIntent[] = [];
  const seen = new Set<string>();
  for (const intent of input.queryIntents) {
    const normalized = normalizedQuery(intent.query);
    const semanticQuery = input.targetPlatform === "douyin"
      ? stripSiteClauses(normalized)
      : normalized;
    if (!semanticQuery || !SEMANTIC_CONTENT.test(semanticQuery)) {
      throw new Error("ACQUISITION_DISCOVERY_QUERY_EMPTY");
    }
    if (input.targetPlatform === "web") {
      const boundedSemantic = boundedQuery(
        semanticQuery,
        SEARCH_TOOL_QUERY_MAX_LENGTH
      );
      if (!boundedSemantic || !SEMANTIC_CONTENT.test(boundedSemantic)) {
        throw new Error("ACQUISITION_DISCOVERY_QUERY_EMPTY");
      }
      addUnique(
        output,
        seen,
        intent.subjectChannel,
        boundedSemantic
      );
      continue;
    }
    for (const prefix of DOUYIN_ROOT_PREFIXES) {
      const boundedSemantic = boundedQuery(
        semanticQuery,
        SEARCH_TOOL_QUERY_MAX_LENGTH - prefix.length
      );
      if (!boundedSemantic || !SEMANTIC_CONTENT.test(boundedSemantic)) {
        throw new Error("ACQUISITION_DISCOVERY_QUERY_EMPTY");
      }
      addUnique(
        output,
        seen,
        intent.subjectChannel,
        `${prefix}${boundedSemantic}`
      );
    }
  }
  return output;
}

export function isSafeDouyinSearchQuery(query: string) {
  if (!query
    || query.length > SEARCH_TOOL_QUERY_MAX_LENGTH
    || query !== query.normalize("NFKC")
    || DEFAULT_IGNORABLE_CODE_POINT_PRESENT.test(query)
    || CONTROL_CHARACTER_PRESENT.test(query)) {
    return false;
  }
  const prefix = DOUYIN_ROOT_PREFIXES.find((candidate) =>
    query.startsWith(candidate)
  );
  if (!prefix) return false;
  const semanticQuery = query.slice(prefix.length);
  return semanticQuery.trim().length > 0
    && SEMANTIC_CONTENT.test(semanticQuery)
    && semanticQuery === semanticQuery.trim()
    && !SITE_CLAUSE_REMAINS.test(` ${semanticQuery}`);
}
