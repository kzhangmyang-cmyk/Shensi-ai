import { createHash } from "node:crypto";
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
const bareDomain = /(?:[\p{L}\p{N}-]+\.)+(?:xn--[a-z0-9-]{2,59}|[a-z]{2,63}|[\p{L}]{2,63})(?![\p{L}\p{N}-])/iu;
const phone = /(?:\+?\d[\s\-().]*){7,}\d/u;

function fail(): never { throw new Error("OUTREACH_DRAFT_INVALID"); }
function safetyProjection(value: string) {
  return value.normalize("NFKC").replace(/[\p{Cf}\p{Zs}\p{Zl}\p{Zp}]/gu, "");
}
function singleLine(value: unknown, maximum: number) {
  if (typeof value !== "string") fail();
  const text = value.normalize("NFKC").trim();
  const projected = safetyProjection(text);
  if (!text || [...text].length > maximum
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)
    || forbidden.test(projected) || url.test(projected) || bareDomain.test(projected) || phone.test(projected)
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
  const meaningful = (text: string) => text.split(/[，。；！？,.;!?\s]+/u)
    .map((part) => part.trim()).filter((part) => [...part].length >= 6);
  for (const sentence of messages.flatMap(meaningful)) {
    const factual = /(?:我们|本(?:公司|产品)|专业|已经|可以|提供|服务|客户|效果|提升|降低|贵(?:司|店|厂)|你(?:们|的)|该(?:公司|店|厂)|营收|销量|市场|全球|行业|年收入|年销售|恭喜|入选|高新技术企业)/u.test(sentence);
    const quotedEvidence = sentence.replace(/^(?:看到|根据(?:你|贵司)?公开提到|你公开提到)/u, "");
    if (factual && !evidenceRows.some((row) => row.includes(sentence) || row.includes(quotedEvidence))) fail();
  }
  const draft = Object.freeze({ candidateId: authority.candidateId, candidateRevision: authority.candidateRevision,
    evidenceHashes: Object.freeze(evidenceHashes), comment, directMessage,
    rationaleCodes: Object.freeze(codes(value.rationaleCodes)), modelSnapshotId: authority.modelSnapshotId,
    contentHash: "" });
  return Object.freeze({ ...draft, contentHash: outreachDraftContentHash(draft) });
}
