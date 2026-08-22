import { createHash } from "node:crypto";
import type { ModelProviderId } from "./types.js";

export interface ModelCallErrorRecord {
  code: string;
  status: number | null;
  retryable: boolean;
  retryAfterMs: number | null;
}

export interface ModelCallCost {
  amountMinor: number;
  currency: string;
  kind: "estimated" | "actual" | "unknown";
}

export interface ModelCallRecord {
  id: string;
  ownerId: string;
  teamId: string;
  jobId: string;
  attemptId: string;
  connectionId: string;
  credentialVersion: number;
  capabilitySnapshotHash: string;
  provider: ModelProviderId;
  baseUrlFingerprint: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  requestId: string;
  providerRequestId: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  status: "succeeded" | "failed";
  error: ModelCallErrorRecord | null;
  cost: ModelCallCost;
  parameterHash: string;
  resultHash: string;
  createdAt: string;
}

export type NewModelCallRecord = Omit<ModelCallRecord, "id" | "createdAt">;

export interface ModelCallLedger {
  append(record: NewModelCallRecord): ModelCallRecord;
  readonly records: readonly ModelCallRecord[];
}

export interface AppendOnlyModelCallLedgerOptions {
  idFactory?: () => string;
  now?: () => string;
}

let fallbackRecordSequence = 0;

export class AppendOnlyModelCallLedger implements ModelCallLedger {
  readonly #items: ModelCallRecord[] = [];
  readonly #idFactory: () => string;
  readonly #now: () => string;

  constructor(options: AppendOnlyModelCallLedgerOptions = {}) {
    this.#idFactory = options.idFactory
      ?? (() => `model_call_${Date.now()}_${++fallbackRecordSequence}`);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  append(record: NewModelCallRecord) {
    const stored = Object.freeze({
      ...record,
      error: record.error ? Object.freeze({ ...record.error }) : null,
      cost: Object.freeze({ ...record.cost }),
      id: this.#idFactory(),
      createdAt: this.#now()
    });
    this.#items.push(stored);
    return stored;
  }

  get records(): readonly ModelCallRecord[] {
    return Object.freeze([...this.#items]);
  }
}

export function hashModelCallValue(value: unknown) {
  const serialized = typeof value === "string"
    ? value
    : JSON.stringify(value);
  return `sha256:${createHash("sha256")
    .update(serialized ?? "undefined")
    .digest("hex")}`;
}
