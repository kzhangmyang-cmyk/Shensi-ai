import { createHash } from "node:crypto";
import { exactObject, parsePrivateJson, positiveVersion, privateFileNames, readPrivateFile, removePrivateFile, safeIdentifier, serialized, storageDirectory, storageError, writePrivateFile } from "./private-storage.js";

export interface OutreachActionRecoveryRecord {
  version: 1; actionId: string; workspaceId: string; accountId: string;
  requestHash: string; leaseVersion: number; bindingGeneration: number; loginStateVersion: number;
  phase: "claimed" | "central_started" | "sidecar_completed";
  receiptHash: string | null; updatedAt: string;
}
export interface OutreachActionCleanupFence { actionId: string; requestHash: string; receiptHash: string; }
export interface OutreachActionUnstartedReleaseFence { actionId: string; requestHash: string; leaseVersion: number; }
export interface OutreachActionJournalStore {
  save(record: OutreachActionRecoveryRecord): Promise<void>;
  load(accountId: string): Promise<OutreachActionRecoveryRecord | null>;
  list(): Promise<OutreachActionRecoveryRecord[]>;
  // Caller must first durably complete centrally and acknowledge the exact
  // Sidecar receipt. Storage checks the fence, not those external authorities.
  remove(accountId: string, fence: OutreachActionCleanupFence): Promise<void>;
  // Only a centrally verified released disposition authorizes this operation.
  // It cannot clear a started record or substitute for receipt acknowledgement.
  releaseUnstarted(accountId: string, fence: OutreachActionUnstartedReleaseFence): Promise<void>;
}
const phases = { claimed: 0, central_started: 1, sidecar_completed: 2 } as const;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const filename = (accountId: string) => `${createHash("sha256").update(`shensi-desktop-outreach-account\0${safeIdentifier(accountId)}`, "utf8").digest("hex")}.json`;
function decode(value: unknown): OutreachActionRecoveryRecord {
  const data = exactObject(value, ["version", "actionId", "workspaceId", "accountId", "requestHash", "leaseVersion", "bindingGeneration", "loginStateVersion", "phase", "receiptHash", "updatedAt"]);
  if (data.version !== 1 || !hash(data.requestHash) || typeof data.phase !== "string" || !Object.hasOwn(phases, data.phase)
    || (data.phase === "sidecar_completed" ? !hash(data.receiptHash) : data.receiptHash !== null)
    || typeof data.updatedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(data.updatedAt)
    || !Number.isFinite(Date.parse(data.updatedAt)) || new Date(data.updatedAt).toISOString() !== data.updatedAt) throw storageError();
  return { version: 1, actionId: safeIdentifier(data.actionId), workspaceId: safeIdentifier(data.workspaceId), accountId: safeIdentifier(data.accountId),
    requestHash: data.requestHash, leaseVersion: positiveVersion(data.leaseVersion), bindingGeneration: positiveVersion(data.bindingGeneration),
    loginStateVersion: positiveVersion(data.loginStateVersion), phase: data.phase as OutreachActionRecoveryRecord["phase"],
    receiptHash: data.receiptHash as string | null, updatedAt: data.updatedAt };
}
export function createOutreachActionJournalStore(directory: string): OutreachActionJournalStore {
  storageDirectory(directory);
  async function list(): Promise<OutreachActionRecoveryRecord[]> {
    const names = await privateFileNames(directory); const records: OutreachActionRecoveryRecord[] = [];
    if (names.length > 2) throw new Error("desktop_action_lane_limit");
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw storageError();
      const text = await readPrivateFile(directory, name);
      if (text === null) throw storageError();
      const record = decode(parsePrivateJson(text));
      if (filename(record.accountId) !== name || records.some((value) => value.accountId === record.accountId || value.actionId === record.actionId)) throw storageError();
      records.push(record);
    }
    return records;
  }
  return {
    list: () => serialized(directory, list),
    load: (accountId) => serialized(directory, async () => { safeIdentifier(accountId); return (await list()).find((value) => value.accountId === accountId) ?? null; }),
    save: (input) => serialized(directory, async () => {
      const record = decode(input); const records = await list();
      const current = records.find((value) => value.accountId === record.accountId);
      if (!current) {
        if (records.length >= 2) throw new Error("desktop_action_lane_limit");
        if (records.some((value) => value.actionId === record.actionId)) throw new Error("desktop_action_journal_conflict");
      } else {
        const immutable = ["actionId", "workspaceId", "accountId", "requestHash", "leaseVersion", "bindingGeneration", "loginStateVersion"] as const;
        if (immutable.some((key) => current[key] !== record[key]) || phases[record.phase] < phases[current.phase]
          || record.updatedAt < current.updatedAt || (current.receiptHash !== null && current.receiptHash !== record.receiptHash)) throw new Error("desktop_action_journal_conflict");
      }
      await writePrivateFile(directory, filename(record.accountId), `${JSON.stringify(record)}\n`);
    }),
    releaseUnstarted: (accountId, fence) => serialized(directory, async () => {
      safeIdentifier(accountId); exactObject(fence, ["actionId", "requestHash", "leaseVersion"]);
      safeIdentifier(fence.actionId); positiveVersion(fence.leaseVersion);
      if (!hash(fence.requestHash)) throw storageError();
      const current = (await list()).find((value) => value.accountId === accountId);
      if (!current) return;
      if (current.phase !== "claimed" || current.receiptHash !== null
        || current.actionId !== fence.actionId || current.requestHash !== fence.requestHash
        || current.leaseVersion !== fence.leaseVersion) throw new Error("desktop_action_journal_conflict");
      await removePrivateFile(directory, filename(accountId));
    }),
    remove: (accountId, fence) => serialized(directory, async () => {
      safeIdentifier(accountId); exactObject(fence, ["actionId", "requestHash", "receiptHash"]);
      if (!hash(fence.requestHash) || !hash(fence.receiptHash)) throw storageError();
      safeIdentifier(fence.actionId);
      const current = (await list()).find((value) => value.accountId === accountId);
      if (!current) return;
      if (current.phase !== "sidecar_completed" || current.actionId !== fence.actionId || current.requestHash !== fence.requestHash || current.receiptHash !== fence.receiptHash) throw new Error("desktop_action_journal_conflict");
      await removePrivateFile(directory, filename(accountId));
    })
  };
}
