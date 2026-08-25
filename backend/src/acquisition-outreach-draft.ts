import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import { parse as parseDomain } from "tldts";
import { canonicalJsonStringify } from "./canonical-json.js";

export interface AcquisitionOutreachDraft {
  candidateId: string;
  candidateRevision: number;
  evidenceHashes: readonly string[];
  comment: string;
  directMessage: string;
  rationaleCodes: readonly string[];
  modelSnapshotId: string;
  contentHash: string;
}

const forbidden = /(?:保证|承诺|第一名|最(?:好|低|快)|免费|加(?:微|微信)|微信|电话|联系方式|稳赚|官方认证|转化率|成交率|服务了|客户数)/u;
const url = /(?:https?:\/\/|www\.|(?:douyin|抖音)\.com)/iu;
const phone = /(?:\+?\d[\s\-().]*){7,}\d/u;
const genericTemplateClauses = new Set([
  "祝进展顺利",
  "如愿意",
  "如你愿意",
  "方便的话",
  "可交流公开场景里的思路",
  "可以交流公开场景里的思路",
  "期待交流"
]);
const evidenceReportingPrefixes = [
  "看到你公开提到",
  "根据你公开提到",
  "根据贵司公开提到",
  "你公开提到"
] as const;

function fail(): never { throw new Error("OUTREACH_DRAFT_INVALID"); }
function safetyProjection(value: string) {
  return value.normalize("NFKC")
    .replace(/[。．｡﹒․︒]/gu, ".")
    .replace(/[\p{Cf}\p{Zs}\p{Zl}\p{Zp}]/gu, "");
}
function containsDomain(value: string) {
  const candidates = value.match(/[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu) ?? [];
  return candidates.some((candidate) => {
    const ascii = domainToASCII(candidate.toLowerCase());
    if (!ascii || ascii.length > 253) return false;
    const labels = ascii.split(".");
    if (labels.length < 2 || labels.some((label) => !label || label.length > 63
      || label.startsWith("-") || label.endsWith("-")
      || ![...label].every((character) => /[a-z0-9-]/u.test(character)))) {
      return false;
    }
    return parseDomain(ascii, {
      extractHostname: false,
      validateHostname: false
    }).isIcann === true;
  });
}
function singleLine(value: unknown, maximum: number) {
  if (typeof value !== "string") fail();
  const text = value.normalize("NFKC").trim();
  const projected = safetyProjection(text);
  if (!text || [...text].length > maximum
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)
    || forbidden.test(projected) || url.test(projected) || containsDomain(projected) || phone.test(projected)
    || /(?:\d+(?:\.\d+)?\s*%|百分之[零一二三四五六七八九十百千万]+)/u.test(projected)) fail();
  return text;
}
function hashes(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) fail();
  const rows = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (rows.some((item) => !/^sha256:[a-fA-F0-9]{1,64}$/u.test(item))
    || new Set(rows).size !== rows.length) fail();
  return rows.sort();
}
function codes(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) fail();
  const rows = value.map((item) => typeof item === "string" ? item.trim() : "");
  const allowed = new Set(["evidence_grounded", "public_need_signal", "manual_review_required"]);
  if (rows.some((item) => !allowed.has(item))
    || new Set(rows).size !== rows.length) fail();
  return rows.sort();
}

export function outreachDraftContentHash(input: Omit<AcquisitionOutreachDraft, "contentHash">) {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(input), "utf8").digest("hex")}`;
}

export function validateAcquisitionOutreachDraft(
  value: Omit<AcquisitionOutreachDraft, "contentHash">,
  authority: { candidateId: string; candidateRevision: number; evidenceHashes: string[]; evidenceText: string[]; modelSnapshotId: string; }
): Readonly<AcquisitionOutreachDraft> {
  if (!value || value.candidateId !== authority.candidateId
    || value.candidateRevision !== authority.candidateRevision
    || value.modelSnapshotId !== authority.modelSnapshotId
    || !Number.isSafeInteger(value.candidateRevision) || value.candidateRevision < 1) fail();
  const evidenceHashes = hashes(value.evidenceHashes);
  if (canonicalJsonStringify(evidenceHashes) !== canonicalJsonStringify([...authority.evidenceHashes].sort())) fail();
  const comment = singleLine(value.comment, 300);
  const directMessage = singleLine(value.directMessage, 800);
  const evidenceRows = authority.evidenceText.map(safetyProjection);
  const messages = [comment, directMessage].map(safetyProjection);
  const clauses = (text: string) => text.split(/[，；！？,.;!?]+/u)
    .map((part) => part.trim()).filter(Boolean);
  for (const clause of messages.flatMap(clauses)) {
    if (genericTemplateClauses.has(clause)) continue;
    const prefix = evidenceReportingPrefixes.find((candidate) =>
      clause.startsWith(candidate));
    const groundedPhrase = prefix ? clause.slice(prefix.length).trim() : clause;
    if (!groundedPhrase
      || !evidenceRows.some((row) => row.includes(groundedPhrase))) fail();
  }
  const draft = Object.freeze({ candidateId: authority.candidateId, candidateRevision: authority.candidateRevision,
    evidenceHashes: Object.freeze(evidenceHashes), comment, directMessage,
    rationaleCodes: Object.freeze(codes(value.rationaleCodes)), modelSnapshotId: authority.modelSnapshotId,
    contentHash: "" });
  return Object.freeze({ ...draft, contentHash: outreachDraftContentHash(draft) });
}
