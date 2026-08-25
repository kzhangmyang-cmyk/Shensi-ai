import { AcquisitionHttpError } from "./douyin-automation-api";
import type { OutreachAction, OutreachBatch, OutreachBatchApi } from "./outreach-batch-api";

export interface OutreachBatchState {
  phase: "idle" | "loading" | "ready" | "saving" | "approving" | "error";
  batch: OutreachBatch | null;
  drafts: Record<string, { comment: string; directMessage: string }>;
  actions: OutreachAction[];
  error: string | null;
  conflict: boolean;
  closed: boolean;
}
export interface OutreachBatchController {
  getState(): OutreachBatchState;
  subscribe(listener: (state: OutreachBatchState) => void): () => void;
  create(runId: string, candidateIds: string[]): Promise<void>;
  load(batchId: string): Promise<void>;
  editMessage(candidateId: string, field: "comment" | "directMessage", value: string): void;
  saveRevision(): Promise<void>;
  approve(): Promise<void>;
  pause(reason?: string): Promise<void>;
  resume(): Promise<void>;
  refreshActions(): Promise<void>;
  abort(): void;
  close(): void;
}
const makeKey = (prefix: string) => `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
const errorText = (error: unknown) => error instanceof Error ? error.message.slice(0, 300) : "未知错误";
const terminalAction = (status: OutreachAction["status"]) => ["succeeded", "failed", "risk_paused"].includes(status);

export function createOutreachBatchController(options: { api: OutreachBatchApi; pollDelayMs?: number }): OutreachBatchController {
  let state: OutreachBatchState = { phase: "idle", batch: null, drafts: {}, actions: [], error: null, conflict: false, closed: false };
  const listeners = new Set<(state: OutreachBatchState) => void>();
  let generation = 0;
  let aborter = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const emit = (patch: Partial<OutreachBatchState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener(state)); };
  const drafts = (batch: OutreachBatch) => Object.fromEntries(batch.candidates.map((candidate) => [candidate.candidateId, { comment: candidate.comment, directMessage: candidate.directMessage }]));
  const current = (value: number) => !state.closed && value === generation;
  const reset = () => { generation += 1; aborter.abort(); aborter = new AbortController(); if (timer) clearTimeout(timer); timer = null; return generation; };
  const adopt = (batch: OutreachBatch) => emit({ phase: "ready", batch, drafts: drafts(batch), error: null, conflict: false });
  const reloadConflict = async (error: unknown, own: number) => {
    if (!(error instanceof AcquisitionHttpError) || ![409, 412].includes(error.status) || !state.batch) throw error;
    const batch = await options.api.getBatch(state.batch.id, aborter.signal);
    if (current(own)) { adopt(batch); emit({ conflict: true, error: "批次已被其他操作更新，已重新载入最新修订。" }); }
  };
  const poll = async (batchId: string, own: number) => {
    if (!current(own)) return;
    try {
      const result = await options.api.listActions(batchId, aborter.signal);
      if (!current(own)) return;
      emit({ actions: result.items });
      if (result.items.some((action) => !terminalAction(action.status))) timer = setTimeout(() => void poll(batchId, own), options.pollDelayMs ?? 3_000);
    } catch (error) { if (current(own)) emit({ error: errorText(error), phase: "error" }); }
  };
  const transition = async (name: "approve" | "pause" | "resume", reason = "") => {
    if (!state.batch) return;
    const own = generation; emit({ phase: name === "approve" ? "approving" : "saving", error: null, conflict: false });
    try {
      const batch = name === "approve"
        ? await options.api.approveBatch(state.batch.id, state.batch.revision, state.batch.batchHash, state.batch.etag, makeKey("outreach-approve"), aborter.signal)
        : name === "pause"
          ? await options.api.pauseBatch(state.batch.id, reason, state.batch.etag, makeKey("outreach-pause"), aborter.signal)
          : await options.api.resumeBatch(state.batch.id, state.batch.etag, makeKey("outreach-resume"), aborter.signal);
      if (!current(own)) return;
      adopt(batch);
      if (name !== "pause") void poll(batch.id, own);
    } catch (error) { try { await reloadConflict(error, own); } catch (nested) { if (current(own)) emit({ phase: "error", error: errorText(nested) }); } }
  };
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    async create(runId, candidateIds) {
      const own = reset(); emit({ phase: "loading", batch: null, actions: [], error: null, conflict: false });
      try { const batch = await options.api.createBatch(runId, [...candidateIds], makeKey("outreach-create"), aborter.signal); if (current(own)) adopt(batch); }
      catch (error) { if (current(own)) emit({ phase: "error", error: errorText(error) }); }
    },
    async load(batchId) {
      const own = reset(); emit({ phase: "loading", error: null, conflict: false });
      try { const batch = await options.api.getBatch(batchId, aborter.signal); if (current(own)) { adopt(batch); void poll(batch.id, own); } }
      catch (error) { if (current(own)) emit({ phase: "error", error: errorText(error) }); }
    },
    editMessage(candidateId, field, value) { emit({ drafts: { ...state.drafts, [candidateId]: { ...(state.drafts[candidateId] ?? { comment: "", directMessage: "" }), [field]: value } } }); },
    async saveRevision() {
      if (!state.batch) return; const own = generation; emit({ phase: "saving", error: null, conflict: false });
      try {
        const candidates = state.batch.candidates.map((candidate) => ({ candidateId: candidate.candidateId, selected: candidate.selected, comment: state.drafts[candidate.candidateId]?.comment ?? candidate.comment, directMessage: state.drafts[candidate.candidateId]?.directMessage ?? candidate.directMessage }));
        const batch = await options.api.updateBatch(state.batch.id, candidates, state.batch.etag, makeKey("outreach-revise"), aborter.signal);
        if (current(own)) adopt(batch);
      } catch (error) { try { await reloadConflict(error, own); } catch (nested) { if (current(own)) emit({ phase: "error", error: errorText(nested) }); } }
    },
    approve: () => transition("approve"),
    pause: (reason = "人工暂停") => transition("pause", reason),
    resume: () => transition("resume"),
    async refreshActions() { if (state.batch) await poll(state.batch.id, generation); },
    abort() { if (!state.closed) reset(); },
    close() { if (state.closed) return; reset(); emit({ closed: true, phase: "idle" }); listeners.clear(); }
  };
}
