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

const forbidden = /(?:保证|承诺|第一名|最(?:好|低|快)|免费|加(?:微|微信)|微信|电话|联系方式|稳赚|官方认证)/u;
const url = /(?:https?:\/\/|www\.|(?:douyin|抖音)\.com)/iu;
const phone = /(?:\+?\d[\s-]*){7,}\d/u;

function fail(): never { throw new Error("OUTREACH_DRAFT_INVALID"); }
function singleLine(value: unknown, maximum: number) {
  if (typeof value !== "string") fail();
  const text = value.normalize("NFKC").trim();
  if (!text || [...text].length > maximum || /[\r\n\u2028\u2029]/u.test(text)
    || forbidden.test(text) || url.test(text) || phone.test(text)) fail();
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
  if (rows.some((item) => !/^[a-z][a-z0-9_]{0,63}$/u.test(item))
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
  const evidence = authority.evidenceText.join(" ").normalize("NFKC");
  const asserted = `${comment} ${directMessage}`.match(/(?:我们|本(?:公司|产品)|专业|已经|可以保证)[^，。；！？]{0,30}/gu) ?? [];
  if (asserted.some((claim) => !evidence.includes(claim))) fail();
  const draft = Object.freeze({ candidateId: authority.candidateId, candidateRevision: authority.candidateRevision,
    evidenceHashes: Object.freeze(evidenceHashes), comment, directMessage,
    rationaleCodes: Object.freeze(codes(value.rationaleCodes)), modelSnapshotId: authority.modelSnapshotId,
    contentHash: "" });
  return Object.freeze({ ...draft, contentHash: outreachDraftContentHash(draft) });
}
