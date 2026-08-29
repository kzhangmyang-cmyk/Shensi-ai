import { AcquisitionHttpError } from "./douyin-automation-api";
import type {
  DirectMessageApprovalCommand,
  OutreachAction,
  OutreachBatch,
  OutreachBatchApi
} from "./outreach-batch-api";

export interface OutreachBatchState {
  phase: "idle" | "loading" | "ready" | "saving" | "approving" | "error";
  batch: OutreachBatch | null;
  drafts: Record<string, { comment: string; directMessage: string }>;
  actions: OutreachAction[];
  error: string | null;
  conflict: boolean;
  closed: boolean;
  directMessageDailyLimit?: number;
  directMessageConfirmed?: boolean;
  directMessageApprovalPhase?: "idle" | "approving" | "pending";
  directMessagePendingCandidateIds?: string[];
}
export interface OutreachBatchController {
  getState(): OutreachBatchState;
  subscribe(listener: (state: OutreachBatchState) => void): () => void;
  create(runId: string, candidateIds: string[]): Promise<void>;
  load(batchId: string): Promise<void>;
  editMessage(candidateId: string, field: "comment" | "directMessage", value: string): void;
  setDirectMessageDailyLimit(value: number): void;
  setDirectMessageConfirmed(value: boolean): void;
  saveRevision(): Promise<void>;
  approve(): Promise<void>;
  approveDirectMessages(): Promise<void>;
  pause(reason?: string): Promise<void>;
  resume(): Promise<void>;
  refreshActions(): Promise<void>;
  reconcileAction(actionId: string): Promise<void>;
  abort(): void;
  close(): void;
}
type OutreachBatchSetTimer = (
  callback: () => void,
  delay: number
) => ReturnType<typeof setTimeout>;
type OutreachBatchClearTimer = (
  timer: ReturnType<typeof setTimeout>
) => void;
const makeKey = (prefix: string) => `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
const projectionGateText: Record<string, string> = {
  outreach_candidate_projection_pending:
    "候选数据仍在采集中或等待最终入库。完成后再确认；当前不会排队真实评论或私信。评论成功后可再独立确认私信。",
  outreach_candidate_projection_unavailable:
    "本次采集没有形成可审批的最终候选数据，请重新运行采集后再生成评论批次。"
};
const projectionGateError = (error: unknown): error is AcquisitionHttpError =>
  error instanceof AcquisitionHttpError && error.code in projectionGateText;
const revisionConflictError = (
  error: unknown
): error is AcquisitionHttpError => error instanceof AcquisitionHttpError
  && ((error.status === 412 && error.code === "precondition_failed")
    || (error.status === 409 && [
      "outreach_batch_stale",
      "outreach_batch_conflict"
    ].includes(error.code)));
const errorText = (error: unknown) => projectionGateError(error)
  ? projectionGateText[error.code]!
  : error instanceof Error ? error.message.slice(0, 300) : "未知错误";
const terminalAction = (status: OutreachAction["status"]) => ["succeeded", "failed", "risk_paused"].includes(status);
const EMPTY_ACTION_POLL_ATTEMPTS = 20;
const DEFAULT_DIRECT_MESSAGE_DAILY_LIMIT = 20;
const validDirectMessageLimit = (value: number) => Number.isInteger(value)
  && value >= 1 && value <= 100;

function successfulCurrentComment(
  batch: OutreachBatch,
  candidate: OutreachBatch["candidates"][number],
  actions: readonly OutreachAction[]
): OutreachAction | null {
  if (batch.state !== "approved" || !batch.approvalHash) return null;
  return actions.find((action) => action.kind === "comment"
    && action.batchId === batch.id
    && action.candidateId === candidate.candidateId
    && action.batchRevision === batch.revision
    && action.contentHash === candidate.commentHash
    && action.approvalHash === batch.approvalHash
    && action.status === "succeeded"
    && Boolean(action.platformReceiptReference?.trim())) ?? null;
}

function eligibleDirectMessageCandidates(
  batch: OutreachBatch,
  actions: readonly OutreachAction[]
) {
  return batch.candidates.filter((candidate) => candidate.selected
    && successfulCurrentComment(batch, candidate, actions)
    && !actions.some((action) => action.kind === "direct_message"
      && action.candidateId === candidate.candidateId)
  );
}

export function createOutreachBatchController(options: {
  api: OutreachBatchApi;
  pollDelayMs?: number;
  setTimer?: OutreachBatchSetTimer;
  clearTimer?: OutreachBatchClearTimer;
}): OutreachBatchController {
  type InternalState = OutreachBatchState & Required<Pick<OutreachBatchState,
    "directMessageDailyLimit" | "directMessageConfirmed"
    | "directMessageApprovalPhase" | "directMessagePendingCandidateIds">>;
  let state: InternalState = {
    phase: "idle",
    batch: null,
    drafts: {},
    actions: [],
    error: null,
    conflict: false,
    closed: false,
    directMessageDailyLimit: DEFAULT_DIRECT_MESSAGE_DAILY_LIMIT,
    directMessageConfirmed: false,
    directMessageApprovalPhase: "idle",
    directMessagePendingCandidateIds: []
  };
  const listeners = new Set<(state: OutreachBatchState) => void>();
  let generation = 0;
  let aborter = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pollEpoch = 0;
  let activeCommand: symbol | null = null;
  let confirmedDirectMessageIntentFingerprint: string | null = null;
  let lastDirectMessageIntentFingerprint: string | null = null;
  let lastDirectMessageIdempotencyKey: string | null = null;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const emit = (patch: Partial<InternalState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener(state)); };
  const updateSilently = (patch: Partial<InternalState>) => { state = { ...state, ...patch }; };
  const drafts = (batch: OutreachBatch) => Object.fromEntries(batch.candidates.map((candidate) => [candidate.candidateId, { comment: candidate.comment, directMessage: candidate.directMessage }]));
  const hasUnsavedChanges = () => Boolean(state.batch?.candidates.some((candidate) => {
    const draft = state.drafts[candidate.candidateId];
    return draft && (draft.comment !== candidate.comment
      || draft.directMessage !== candidate.directMessage);
  }));
  const directMessageIntent = (
    actions: readonly OutreachAction[] = state.actions
  ) => {
    const batch = state.batch;
    if (!batch || batch.state !== "approved" || !batch.approvalHash
      || !validDirectMessageLimit(state.directMessageDailyLimit)) return null;
    const eligible = eligibleDirectMessageCandidates(batch, actions);
    if (eligible.length === 0
      || eligible.length > state.directMessageDailyLimit) return null;
    const candidates = eligible.map((candidate) => ({
      candidateId: candidate.candidateId,
      directMessage: state.drafts[candidate.candidateId]?.directMessage
        ?? candidate.directMessage
    }));
    if (candidates.some((candidate) =>
      candidate.directMessage.trim().length < 1
      || candidate.directMessage.length > 800)) return null;
    const authority = {
      id: batch.id,
      revision: batch.revision,
      batchHash: batch.batchHash,
      commentApprovalHash: batch.approvalHash,
      etag: batch.etag,
      accountId: batch.accountId,
      accountLoginStateVersion: batch.accountLoginStateVersion,
      policyVersionId: batch.policyVersionId
    };
    const commandBody: DirectMessageApprovalCommand = {
      batchRevision: authority.revision,
      batchHash: authority.batchHash,
      commentApprovalHash: authority.commentApprovalHash,
      dailyLimit: state.directMessageDailyLimit,
      candidates,
      confirm: true
    };
    const predecessors = eligible.map((candidate) => {
      const action = successfulCurrentComment(batch, candidate, actions)!;
      return {
        candidateId: candidate.candidateId,
        actionId: action.id,
        receipt: action.platformReceiptReference,
        contentHash: action.contentHash,
        approvalHash: action.approvalHash
      };
    });
    return {
      authority,
      commandBody,
      candidates,
      fingerprint: JSON.stringify({ authority, commandBody, predecessors })
    };
  };
  const current = (value: number) => !state.closed && value === generation;
  const reset = () => {
    generation += 1;
    pollEpoch += 1;
    aborter.abort();
    aborter = new AbortController();
    if (timer) clearTimer(timer);
    timer = null;
    activeCommand = null;
    confirmedDirectMessageIntentFingerprint = null;
    lastDirectMessageIntentFingerprint = null;
    lastDirectMessageIdempotencyKey = null;
    return generation;
  };
  const adopt = (batch: OutreachBatch) => {
    confirmedDirectMessageIntentFingerprint = null;
    emit({
      phase: "ready",
      batch,
      drafts: drafts(batch),
      error: null,
      conflict: false,
      directMessageDailyLimit: DEFAULT_DIRECT_MESSAGE_DAILY_LIMIT,
      directMessageConfirmed: false,
      directMessageApprovalPhase: "idle",
      directMessagePendingCandidateIds: []
    });
  };
  const reloadConflict = async (error: unknown, own: number, batchId: string) => {
    if (!revisionConflictError(error)) throw error;
    const batch = await options.api.getBatch(batchId, aborter.signal);
    if (current(own)) {
      activeCommand = null;
      adopt(batch);
      emit({
        actions: [],
        conflict: true,
        error: null
      });
    }
  };
  const poll = async (
    batchId: string,
    own: number,
    epoch: number,
    emptyAttemptsRemaining = EMPTY_ACTION_POLL_ATTEMPTS
  ) => {
    const currentPoll = () => current(own) && epoch === pollEpoch;
    if (!currentPoll()) return;
    try {
      const result = await options.api.listActions(batchId, aborter.signal);
      if (!currentPoll()) return;
      const nextIntentFingerprint = directMessageIntent(result.items)?.fingerprint
        ?? null;
      const confirmationRemainsCurrent = state.directMessageConfirmed
        && confirmedDirectMessageIntentFingerprint !== null
        && confirmedDirectMessageIntentFingerprint === nextIntentFingerprint;
      if (!confirmationRemainsCurrent) {
        confirmedDirectMessageIntentFingerprint = null;
      }
      const pendingCandidateIds = state.directMessagePendingCandidateIds.filter(
        (candidateId) => !result.items.some((action) =>
          action.kind === "direct_message" && action.candidateId === candidateId)
      );
      const directMessageActionsObserved = state.directMessageApprovalPhase === "pending"
        && state.directMessagePendingCandidateIds.length > 0
        && pendingCandidateIds.length === 0;
      emit({
        actions: result.items,
        directMessageConfirmed: confirmationRemainsCurrent,
        ...(directMessageActionsObserved ? {
          directMessageApprovalPhase: "idle" as const,
          directMessagePendingCandidateIds: []
        } : {}),
        ...(state.phase === "error" ? { phase: "ready", error: null } : {})
      });
      const hasPendingAction = result.items.some((action) =>
        !terminalAction(action.status));
      const waitingForInitialActions = result.items.length === 0
        && emptyAttemptsRemaining > 0;
      const waitingForDirectMessageActions = state.directMessageApprovalPhase === "pending"
        && state.directMessagePendingCandidateIds.length > 0
        && emptyAttemptsRemaining > 0;
      if (hasPendingAction || waitingForInitialActions || waitingForDirectMessageActions) {
        const nextEmptyAttempts = waitingForInitialActions || waitingForDirectMessageActions
          ? emptyAttemptsRemaining - 1
          : EMPTY_ACTION_POLL_ATTEMPTS;
        const nextTimer = setTimer(() => {
          if (timer === nextTimer) timer = null;
          void poll(batchId, own, epoch, nextEmptyAttempts);
        }, options.pollDelayMs ?? 3_000);
        timer = nextTimer;
      }
    } catch (error) {
      if (!currentPoll()) return;
      emit({ error: errorText(error), phase: "error" });
      if (emptyAttemptsRemaining > 0) {
        const nextTimer = setTimer(() => {
          if (timer === nextTimer) timer = null;
          void poll(batchId, own, epoch, emptyAttemptsRemaining - 1);
        }, options.pollDelayMs ?? 3_000);
        timer = nextTimer;
      }
    }
  };
  const startPoll = (batchId: string, own: number) => {
    pollEpoch += 1;
    if (timer) clearTimer(timer);
    timer = null;
    return poll(batchId, own, pollEpoch);
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
      if (name !== "pause") void startPoll(batch.id, own);
    } catch (error) {
      if (projectionGateError(error)) {
        if (current(own)) emit({
          phase: "ready",
          error: errorText(error),
          conflict: false
        });
      } else {
        try { await reloadConflict(error, own, authority.id); }
        catch (nested) {
          if (current(own)) emit({ phase: "error", error: errorText(nested) });
        }
      }
    }
    finally { if (activeCommand === command) activeCommand = null; }
  };
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    async create(runId, candidateIds) {
      const own = reset(); emit({
        phase: "loading",
        batch: null,
        drafts: {},
        actions: [],
        error: null,
        conflict: false,
        directMessageDailyLimit: DEFAULT_DIRECT_MESSAGE_DAILY_LIMIT,
        directMessageConfirmed: false,
        directMessageApprovalPhase: "idle",
        directMessagePendingCandidateIds: []
      });
      try { const batch = await options.api.createBatch(runId, [...candidateIds], makeKey("outreach-create"), aborter.signal); if (current(own)) adopt(batch); }
      catch (error) { if (current(own)) emit({ phase: "error", error: errorText(error) }); }
    },
    async load(batchId) {
      const own = reset(); emit({
        phase: "loading",
        batch: null,
        drafts: {},
        actions: [],
        error: null,
        conflict: false,
        directMessageDailyLimit: DEFAULT_DIRECT_MESSAGE_DAILY_LIMIT,
        directMessageConfirmed: false,
        directMessageApprovalPhase: "idle",
        directMessagePendingCandidateIds: []
      });
      try { const batch = await options.api.getBatch(batchId, aborter.signal); if (current(own)) { if (batch.id !== batchId) throw new Error("服务器返回的批次 ID 与请求不一致"); adopt(batch); if (["approved", "paused"].includes(batch.state)) void startPoll(batch.id, own); } }
      catch (error) { if (current(own)) emit({ phase: "error", error: errorText(error) }); }
    },
    editMessage(candidateId, field, value) {
      if (state.closed || activeCommand || !state.batch) return;
      const candidate = state.batch.candidates.find((item) =>
        item.candidateId === candidateId);
      if (!candidate) return;
      const mayEditComment = field === "comment"
        && state.batch.state === "awaiting_approval";
      const mayEditDirectMessage = field === "directMessage"
        && (state.batch.state === "awaiting_approval"
          || eligibleDirectMessageCandidates(state.batch, state.actions)
            .some((item) => item.candidateId === candidateId));
      if (!mayEditComment && !mayEditDirectMessage) return;
      updateSilently({
        drafts: {
          ...state.drafts,
          [candidateId]: {
            ...(state.drafts[candidateId] ?? {
              comment: candidate.comment,
              directMessage: candidate.directMessage
            }),
            [field]: value
          }
        },
        ...(field === "directMessage"
          ? { directMessageConfirmed: false }
          : {})
      });
      if (field === "directMessage") {
        confirmedDirectMessageIntentFingerprint = null;
      }
    },
    setDirectMessageDailyLimit(value) {
      if (state.closed || activeCommand) return;
      updateSilently({
        directMessageDailyLimit: value,
        directMessageConfirmed: false
      });
      confirmedDirectMessageIntentFingerprint = null;
    },
    setDirectMessageConfirmed(value) {
      if (state.closed || activeCommand || !state.batch) return;
      const intent = directMessageIntent();
      const confirmed = value
        && state.directMessageApprovalPhase === "idle"
        && intent !== null;
      confirmedDirectMessageIntentFingerprint = confirmed
        ? intent.fingerprint
        : null;
      updateSilently({ directMessageConfirmed: confirmed });
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
    async approveDirectMessages() {
      if (!state.batch || state.closed || activeCommand
        || state.directMessageApprovalPhase !== "idle"
        || !state.directMessageConfirmed
        || state.batch.state !== "approved"
        || !state.batch.approvalHash
        || !options.api.approveDirectMessages
        || !validDirectMessageLimit(state.directMessageDailyLimit)) return;
      const intent = directMessageIntent();
      if (!intent
        || confirmedDirectMessageIntentFingerprint !== intent.fingerprint) {
        confirmedDirectMessageIntentFingerprint = null;
        updateSilently({ directMessageConfirmed: false });
        return;
      }
      const { authority, candidates, commandBody, fingerprint } = intent;
      if (fingerprint !== lastDirectMessageIntentFingerprint
        || !lastDirectMessageIdempotencyKey) {
        lastDirectMessageIntentFingerprint = fingerprint;
        lastDirectMessageIdempotencyKey = makeKey("outreach-direct-message-approve");
      }
      const command = Symbol("approve-direct-messages");
      activeCommand = command;
      confirmedDirectMessageIntentFingerprint = null;
      const own = generation;
      emit({
        phase: "approving",
        error: null,
        conflict: false,
        directMessageConfirmed: false,
        directMessageApprovalPhase: "approving",
        directMessagePendingCandidateIds: candidates.map((candidate) =>
          candidate.candidateId)
      });
      try {
        const response = await options.api.approveDirectMessages(
          authority.id,
          commandBody,
          authority.etag,
          lastDirectMessageIdempotencyKey,
          aborter.signal
        );
        if (!current(own) || activeCommand !== command) return;
        if (response.id !== authority.id
          || response.revision !== authority.revision
          || response.batchHash !== authority.batchHash
          || response.approvalHash !== authority.commentApprovalHash
          || response.etag !== authority.etag
          || response.accountId !== authority.accountId
          || response.accountLoginStateVersion !== authority.accountLoginStateVersion
          || response.policyVersionId !== authority.policyVersionId) {
          throw new Error("服务器返回的私信授权批次与已核对权限不一致");
        }
        activeCommand = null;
        emit({
          phase: "ready",
          batch: response,
          directMessageApprovalPhase: "pending"
        });
        await startPoll(authority.id, own);
      } catch (error) {
        try {
          await reloadConflict(error, own, authority.id);
          if (current(own) && state.batch
            && ["approved", "paused"].includes(state.batch.state)) {
            await startPoll(state.batch.id, own);
          }
        } catch (nested) {
          if (current(own)) emit({
            phase: "ready",
            error: errorText(nested),
            directMessageConfirmed: false,
            directMessageApprovalPhase: "idle",
            directMessagePendingCandidateIds: []
          });
        }
      } finally {
        if (activeCommand === command) activeCommand = null;
      }
    },
    pause: (reason = "人工暂停") => transition("pause", reason),
    resume: () => transition("resume"),
    async refreshActions() { if (state.batch) await startPoll(state.batch.id, generation); },
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
