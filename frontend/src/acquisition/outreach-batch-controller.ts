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
  reconcileAction(actionId: string): Promise<void>;
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
  let activeCommand: symbol | null = null;
  const emit = (patch: Partial<OutreachBatchState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener(state)); };
  const updateSilently = (patch: Partial<OutreachBatchState>) => { state = { ...state, ...patch }; };
  const drafts = (batch: OutreachBatch) => Object.fromEntries(batch.candidates.map((candidate) => [candidate.candidateId, { comment: candidate.comment, directMessage: candidate.directMessage }]));
  const hasUnsavedChanges = () => Boolean(state.batch?.candidates.some((candidate) => {
    const draft = state.drafts[candidate.candidateId];
    return draft && (draft.comment !== candidate.comment
      || draft.directMessage !== candidate.directMessage);
  }));
  const current = (value: number) => !state.closed && value === generation;
  const reset = () => { generation += 1; aborter.abort(); aborter = new AbortController(); if (timer) clearTimeout(timer); timer = null; return generation; };
  const adopt = (batch: OutreachBatch) => emit({ phase: "ready", batch, drafts: drafts(batch), error: null, conflict: false });
  const reloadConflict = async (error: unknown, own: number, batchId: string) => {
    if (!(error instanceof AcquisitionHttpError) || ![409, 412].includes(error.status)) throw error;
    const batch = await options.api.getBatch(batchId, aborter.signal);
    if (current(own)) {
      activeCommand = null;
      adopt(batch);
      emit({ conflict: true, error: "批次已被其他操作更新，已重新载入最新修订。" });
    }
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
    if (!state.batch || activeCommand) return;
    if (name === "approve" && hasUnsavedChanges()) {
      emit({ phase: "ready", error: "当前文案尚未保存，请先保存为新修订后再审批。", conflict: false });
      return;
    }
    const authority = {
      id: state.batch.id,
      revision: state.batch.revision,
      batchHash: state.batch.batchHash,
      etag: state.batch.etag
    };
    const command = Symbol(name);
    activeCommand = command;
    const own = generation; emit({ phase: name === "approve" ? "approving" : "saving", error: null, conflict: false });
    try {
      const batch = name === "approve"
        ? await options.api.approveBatch(authority.id, authority.revision, authority.batchHash, authority.etag, makeKey("outreach-approve"), aborter.signal)
        : name === "pause"
          ? await options.api.pauseBatch(authority.id, reason, authority.etag, makeKey("outreach-pause"), aborter.signal)
          : await options.api.resumeBatch(authority.id, authority.etag, makeKey("outreach-resume"), aborter.signal);
      if (!current(own)) return;
      if (activeCommand === command) activeCommand = null;
      adopt(batch);
      if (name !== "pause") void poll(batch.id, own);
    } catch (error) { try { await reloadConflict(error, own, authority.id); } catch (nested) { if (current(own)) emit({ phase: "error", error: errorText(nested) }); } }
    finally { if (activeCommand === command) activeCommand = null; }
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
      const own = reset(); emit({ phase: "loading", batch: null, drafts: {}, actions: [], error: null, conflict: false });
      try { const batch = await options.api.getBatch(batchId, aborter.signal); if (current(own)) { if (batch.id !== batchId) throw new Error("服务器返回的批次 ID 与请求不一致"); adopt(batch); if (["approved", "paused"].includes(batch.state)) void poll(batch.id, own); } }
      catch (error) { if (current(own)) emit({ phase: "error", error: errorText(error) }); }
    },
    editMessage(candidateId, field, value) {
      if (state.closed || activeCommand || state.batch?.state !== "awaiting_approval") return;
      updateSilently({ drafts: { ...state.drafts, [candidateId]: { ...(state.drafts[candidateId] ?? { comment: "", directMessage: "" }), [field]: value } } });
    },
    async saveRevision() {
      if (!state.batch || activeCommand || state.batch.state !== "awaiting_approval") return;
      const authority = { id: state.batch.id, etag: state.batch.etag };
      const candidates = state.batch.candidates.map((candidate) => ({ candidateId: candidate.candidateId, selected: candidate.selected, comment: state.drafts[candidate.candidateId]?.comment ?? candidate.comment, directMessage: state.drafts[candidate.candidateId]?.directMessage ?? candidate.directMessage }));
      const command = Symbol("save");
      activeCommand = command;
      const own = generation; emit({ phase: "saving", error: null, conflict: false });
      try {
        const batch = await options.api.updateBatch(authority.id, candidates, authority.etag, makeKey("outreach-revise"), aborter.signal);
        if (current(own)) {
          if (activeCommand === command) activeCommand = null;
          adopt(batch);
        }
      } catch (error) { try { await reloadConflict(error, own, authority.id); } catch (nested) { if (current(own)) emit({ phase: "error", error: errorText(nested) }); } }
      finally { if (activeCommand === command) activeCommand = null; }
    },
    approve: () => transition("approve"),
    pause: (reason = "人工暂停") => transition("pause", reason),
    resume: () => transition("resume"),
    async refreshActions() { if (state.batch) await poll(state.batch.id, generation); },
    async reconcileAction(actionId) {
      if (!state.batch || activeCommand || !options.api.reconcileAction) return;
      const action = state.actions.find((candidate) => candidate.id === actionId);
      if (!action || action.status !== "risk_paused"
        || !["action_unavailable", "douyin_action_timeout",
          "douyin_action_receipt_ambiguous"].includes(action.failureCode ?? "")) return;
      const authority = {
        id: action.id,
        batchRevision: action.batchRevision,
        approvalHash: action.approvalHash,
        contentHash: action.contentHash
      };
      const command = Symbol("reconcile");
      activeCommand = command;
      const own = generation;
      emit({ phase: "saving", error: null, conflict: false });
      try {
        const reconciled = await options.api.reconcileAction(
          state.batch.id,
          authority,
          makeKey("outreach-reconcile"),
          aborter.signal,
        );
        if (!current(own) || reconciled.id !== authority.id
          || reconciled.batchRevision !== authority.batchRevision
          || reconciled.approvalHash !== authority.approvalHash
          || reconciled.contentHash !== authority.contentHash
          || reconciled.status !== "succeeded") {
          if (current(own)) emit({ phase: "error", error: "只读回执核验结果与冻结动作不一致" });
          return;
        }
        if (activeCommand === command) activeCommand = null;
        emit({ phase: "ready", actions: state.actions.map((candidate) =>
          candidate.id === reconciled.id ? reconciled : candidate) });
      } catch (error) {
        if (current(own)) emit({ phase: "error", error: errorText(error) });
      } finally { if (activeCommand === command) activeCommand = null; }
    },
    abort() { if (!state.closed) reset(); },
    close() { if (state.closed) return; reset(); emit({ closed: true, phase: "idle" }); listeners.clear(); }
  };
}
