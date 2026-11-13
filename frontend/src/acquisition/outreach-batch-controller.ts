import { AcquisitionHttpError } from "./douyin-automation-api";
import type {
  DirectMessageApprovalCommand,
  OutreachAction,
  OutreachAccountRecovery,
  OutreachBatch,
  OutreachBatchApi,
  OutreachExecutionGate,
  RecoverAccountActionsCommand
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
  directMessageSelectedCandidateIds?: string[];
  directMessageSender?: OutreachDirectMessageSender | null;
  executionGate?: OutreachExecutionGate | null;
  recoveryConfirmed?: boolean;
  recoveryNotice?: string | null;
}
export interface OutreachDirectMessageSender {
  accountId: string;
  accountLoginStateVersion: number;
}
export interface OutreachBatchController {
  getState(): OutreachBatchState;
  subscribe(listener: (state: OutreachBatchState) => void): () => void;
  create(runId: string, candidateIds: string[]): Promise<void>;
  load(batchId: string): Promise<void>;
  editMessage(candidateId: string, field: "comment" | "directMessage", value: string): void;
  setDirectMessageDailyLimit(value: number): void;
  setDirectMessageCandidateSelected(candidateId: string, selected: boolean): void;
  setDirectMessageConfirmed(value: boolean): void;
  refreshDirectMessageSender(): void;
  setRecoveryConfirmed(value: boolean): void;
  saveRevision(): Promise<void>;
  approve(): Promise<void>;
  approveDirectMessages(): Promise<void>;
  pause(reason?: string): Promise<void>;
  cancelPending?(): Promise<void>;
  resume(): Promise<void>;
  refreshActions(): Promise<void>;
  recoverAccountActions(): Promise<void>;
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
    "候选数据仍在采集中或等待最终入库。完成后再确认；当前不会排队真实评论或私信。私信可在候选人与当前发送账号就绪后单独确认。",
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
const DEFAULT_DIRECT_MESSAGE_DAILY_LIMIT = 50;
const RECOVERY_REASON = "人工已核对账号与历史回执，仅恢复当前批次安全评论";
const validDirectMessageLimit = (value: number) => Number.isInteger(value)
  && value >= 1 && value <= 100;
const sameIds = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const executionGateFromRecovery = (
  value: OutreachAccountRecovery
): OutreachExecutionGate => ({
  accountId: value.accountId,
  accountLoginStateVersion: value.accountLoginStateVersion,
  riskPaused: value.riskPaused,
  pendingActionIds: [...value.pendingActionIds],
  unresolvedActions: value.unresolvedActions.map((action) => ({ ...action }))
});

function eligibleDirectMessageCandidates(
  batch: OutreachBatch,
  actions: readonly OutreachAction[]
) {
  return batch.candidates.filter((candidate) =>
    !actions.some((action) => action.kind === "direct_message"
      && action.candidateId === candidate.candidateId)
  );
}

export function createOutreachBatchController(options: {
  api: OutreachBatchApi;
  pollDelayMs?: number;
  setTimer?: OutreachBatchSetTimer;
  clearTimer?: OutreachBatchClearTimer;
  currentSender?: () => OutreachDirectMessageSender | null;
  directMessageCandidateScope?: () => readonly string[] | null;
}): OutreachBatchController {
  type InternalState = OutreachBatchState & Required<Pick<OutreachBatchState,
    "directMessageDailyLimit" | "directMessageConfirmed"
    | "directMessageApprovalPhase" | "directMessagePendingCandidateIds"
    | "directMessageSelectedCandidateIds" | "directMessageSender"
    | "executionGate" | "recoveryConfirmed" | "recoveryNotice">>;
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
    directMessagePendingCandidateIds: [],
    directMessageSelectedCandidateIds: [],
    directMessageSender: null,
    executionGate: null,
    recoveryConfirmed: false,
    recoveryNotice: null
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
  let confirmedRecoveryIntentFingerprint: string | null = null;
  let lastRecoveryIntentFingerprint: string | null = null;
  let lastRecoveryIdempotencyKey: string | null = null;
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
  const readCurrentSender = (): OutreachDirectMessageSender | null => {
    const sender = options.currentSender?.() ?? (state.batch ? {
      accountId: state.batch.accountId,
      accountLoginStateVersion: state.batch.accountLoginStateVersion
    } : null);
    return sender && sender.accountId.trim().length > 0
      && Number.isInteger(sender.accountLoginStateVersion)
      && sender.accountLoginStateVersion >= 1
      ? { ...sender }
      : null;
  };
  const directMessageIntent = (
    actions: readonly OutreachAction[] = state.actions
  ) => {
    const batch = state.batch;
    const sender = readCurrentSender();
    if (!batch || !["awaiting_approval", "approved"].includes(batch.state)
      || !sender || sender.accountId !== batch.accountId
      || !validDirectMessageLimit(state.directMessageDailyLimit)) return null;
    const eligible = eligibleDirectMessageCandidates(batch, actions);
    const selected = state.directMessageSelectedCandidateIds.map((candidateId) =>
      eligible.find((candidate) => candidate.candidateId === candidateId));
    if (selected.length === 0 || new Set(state.directMessageSelectedCandidateIds).size
      !== state.directMessageSelectedCandidateIds.length
      || selected.some((candidate) => !candidate)
      || selected.length > state.directMessageDailyLimit) return null;
    const candidates = selected.map((candidate) => ({
      candidateId: candidate!.candidateId,
      directMessage: state.drafts[candidate!.candidateId]?.directMessage
        ?? candidate!.directMessage
    }));
    if (candidates.some((candidate) =>
      candidate.directMessage.trim().length < 1
      || candidate.directMessage.length > 800)) return null;
    const authority = {
      id: batch.id,
      revision: batch.revision,
      batchHash: batch.batchHash,
      etag: batch.etag,
      accountId: batch.accountId,
      frozenAccountLoginStateVersion: batch.accountLoginStateVersion,
      accountLoginStateVersion: sender.accountLoginStateVersion,
      policyVersionId: batch.policyVersionId
    };
    const commandBody: DirectMessageApprovalCommand = {
      batchRevision: authority.revision,
      batchHash: authority.batchHash,
      accountLoginStateVersion: authority.accountLoginStateVersion,
      dailyLimit: state.directMessageDailyLimit,
      candidates,
      confirm: true
    };
    return {
      authority,
      commandBody,
      candidates,
      fingerprint: JSON.stringify({ authority, commandBody })
    };
  };
  const recoveryIntent = (
    gate: OutreachExecutionGate | null = state.executionGate,
    actions: readonly OutreachAction[] = state.actions
  ) => {
    const batch = state.batch;
    if (!batch || batch.state !== "approved" || !batch.approvalHash
      || !gate?.riskPaused || !options.api.recoverAccountActions
      || gate.accountId !== batch.accountId
      || gate.accountLoginStateVersion !== batch.accountLoginStateVersion
      || gate.pendingActionIds.length < 1) return null;
    const pendingActionIds = [...gate.pendingActionIds].sort();
    const acknowledgedUncertainActionIds = gate.unresolvedActions
      .map((action) => action.actionId).sort();
    if (new Set(acknowledgedUncertainActionIds).size
      !== acknowledgedUncertainActionIds.length) return null;
    const actionsById = new Map(actions.map((action) => [action.id, action]));
    const pendingActions = pendingActionIds.map((id) => actionsById.get(id));
    if (pendingActions.some((action) => !action
      || action.kind !== "comment"
      || action.batchId !== batch.id
      || action.batchRevision !== batch.revision
      || action.accountId !== batch.accountId
      || action.accountLoginStateVersion !== batch.accountLoginStateVersion
      || action.approvalHash !== batch.approvalHash
      || action.attemptCount !== 0
      || !(action.status === "queued" || (action.status === "risk_paused"
        && action.failureCode === "account_risk_paused")))) return null;
    const commandBody: RecoverAccountActionsCommand = {
      batchRevision: batch.revision,
      accountLoginStateVersion: batch.accountLoginStateVersion,
      pendingActionIds,
      acknowledgedUncertainActionIds,
      reason: RECOVERY_REASON,
      confirm: true
    };
    const authority = {
      id: batch.id,
      etag: batch.etag,
      accountId: batch.accountId,
      accountLoginStateVersion: batch.accountLoginStateVersion
    };
    return {
      authority,
      commandBody,
      fingerprint: JSON.stringify({ authority, commandBody })
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
    confirmedRecoveryIntentFingerprint = null;
    lastRecoveryIntentFingerprint = null;
    lastRecoveryIdempotencyKey = null;
    return generation;
  };
  const adopt = (batch: OutreachBatch, phase: "ready" | "loading" = "ready") => {
    confirmedDirectMessageIntentFingerprint = null;
    emit({
      phase,
      batch,
      drafts: drafts(batch),
      error: null,
      conflict: false,
      directMessageDailyLimit: DEFAULT_DIRECT_MESSAGE_DAILY_LIMIT,
      directMessageConfirmed: false,
      directMessageApprovalPhase: "idle",
      directMessagePendingCandidateIds: [],
      directMessageSelectedCandidateIds: batch.candidates
        .filter((candidate) => candidate.selected
          && (options.directMessageCandidateScope?.() ?? batch.candidates
            .map((item) => item.candidateId)).includes(candidate.candidateId))
        .map((candidate) => candidate.candidateId),
      directMessageSender: readCurrentSender(),
      executionGate: null,
      recoveryConfirmed: false,
      recoveryNotice: null
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
      const eligibleIds = new Set(state.batch
        ? eligibleDirectMessageCandidates(state.batch, result.items)
          .map((candidate) => candidate.candidateId)
        : []);
      const directMessageSelectedCandidateIds =
        state.directMessageSelectedCandidateIds.filter((id) =>
          eligibleIds.has(id));
      if (!sameIds(directMessageSelectedCandidateIds,
        state.directMessageSelectedCandidateIds)) {
        state = { ...state, directMessageSelectedCandidateIds };
      }
      const nextIntentFingerprint = directMessageIntent(result.items)?.fingerprint
        ?? null;
      const confirmationRemainsCurrent = state.directMessageConfirmed
        && confirmedDirectMessageIntentFingerprint !== null
        && confirmedDirectMessageIntentFingerprint === nextIntentFingerprint;
      if (!confirmationRemainsCurrent) {
        confirmedDirectMessageIntentFingerprint = null;
      }
      const executionGate = result.executionGate ?? null;
      const nextRecoveryFingerprint = recoveryIntent(
        executionGate,
        result.items
      )?.fingerprint ?? null;
      const recoveryConfirmationRemainsCurrent = state.recoveryConfirmed
        && confirmedRecoveryIntentFingerprint !== null
        && confirmedRecoveryIntentFingerprint === nextRecoveryFingerprint;
      if (!recoveryConfirmationRemainsCurrent) {
        confirmedRecoveryIntentFingerprint = null;
      }
      const pendingCandidateIds = state.directMessagePendingCandidateIds.filter(
        (candidateId) => !result.items.some((action) =>
          action.kind === "direct_message" && action.candidateId === candidateId)
      );
      const directMessageActionsObserved = state.directMessageApprovalPhase === "pending"
        && state.directMessagePendingCandidateIds.length > 0
        && pendingCandidateIds.length === 0;
      const pollPatch: Partial<InternalState> = {
        actions: result.items,
        directMessageSelectedCandidateIds,
        executionGate,
        recoveryConfirmed: recoveryConfirmationRemainsCurrent,
        directMessageConfirmed: confirmationRemainsCurrent,
        ...(directMessageActionsObserved ? {
          directMessageApprovalPhase: "idle" as const,
          directMessagePendingCandidateIds: []
        } : {}),
        ...(["error", "loading"].includes(state.phase) ? { phase: "ready", error: null } : {})
      };
      // A receipt observation is not a user edit. Re-emitting identical state
      // rebuilds conversation views and clears the native reconciliation check.
      if (JSON.stringify({ ...state, ...pollPatch }) !== JSON.stringify(state)) {
        emit(pollPatch);
      }
      const hasPendingAction = !executionGate?.riskPaused
        && result.items.some((action) => !terminalAction(action.status));
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
  const startPoll = (batchId: string, own: number, emptyAttempts = EMPTY_ACTION_POLL_ATTEMPTS) => {
    pollEpoch += 1;
    if (timer) clearTimer(timer);
    timer = null;
    return poll(batchId, own, pollEpoch, emptyAttempts);
  };
  const transition = async (name: "approve" | "pause" | "resume" | "reject", reason = "") => {
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
        : name === "reject"
          ? await options.api.rejectBatch(authority.id, reason, authority.etag, makeKey("outreach-reject"), aborter.signal)
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
        directMessagePendingCandidateIds: [],
        executionGate: null,
        recoveryConfirmed: false,
        recoveryNotice: null
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
        directMessagePendingCandidateIds: [],
        executionGate: null,
        recoveryConfirmed: false,
        recoveryNotice: null
      });
      try {
        const batch = await options.api.getBatch(batchId, aborter.signal);
        if (!current(own)) return;
        if (batch.id !== batchId) throw new Error("服务器返回的批次 ID 与请求不一致");
        if (["approved", "paused"].includes(batch.state)) {
          adopt(batch);
          void startPoll(batch.id, own);
        } else {
          // Independent DMs may already exist without comment approval. Read
          // once before exposing the editor, then poll only observed active work.
          adopt(batch, "loading");
          await startPoll(batch.id, own, 0);
        }
      }
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
    setDirectMessageCandidateSelected(candidateId, selected) {
      if (state.closed || activeCommand || !state.batch
        || !eligibleDirectMessageCandidates(state.batch, state.actions)
          .some((candidate) => candidate.candidateId === candidateId)) return;
      const ids = new Set(state.directMessageSelectedCandidateIds);
      if (selected) ids.add(candidateId); else ids.delete(candidateId);
      confirmedDirectMessageIntentFingerprint = null;
      updateSilently({
        directMessageSelectedCandidateIds: [...ids],
        directMessageConfirmed: false
      });
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
    refreshDirectMessageSender() {
      if (state.closed) return;
      const sender = readCurrentSender();
      if (JSON.stringify(sender) === JSON.stringify(state.directMessageSender)) return;
      confirmedDirectMessageIntentFingerprint = null;
      emit({ directMessageSender: sender, directMessageConfirmed: false });
    },
    setRecoveryConfirmed(value) {
      if (state.closed || activeCommand || !state.batch) return;
      const intent = recoveryIntent();
      const confirmed = value && intent !== null;
      confirmedRecoveryIntentFingerprint = confirmed
        ? intent.fingerprint
        : null;
      updateSilently({ recoveryConfirmed: confirmed });
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
        || !["awaiting_approval", "approved"].includes(state.batch.state)
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
          || response.etag !== authority.etag
          || response.accountId !== authority.accountId
          || response.accountLoginStateVersion !== authority.frozenAccountLoginStateVersion
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
            && ["awaiting_approval", "approved", "paused"].includes(state.batch.state)) {
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
    cancelPending: () => transition("reject", "用户取消尚未执行的私信"),
    resume: () => transition("resume"),
    async refreshActions() { if (state.batch) await startPoll(state.batch.id, generation); },
    async recoverAccountActions() {
      if (!state.batch || state.closed || activeCommand
        || !state.recoveryConfirmed || !options.api.recoverAccountActions) return;
      const intent = recoveryIntent();
      if (!intent
        || confirmedRecoveryIntentFingerprint !== intent.fingerprint) {
        confirmedRecoveryIntentFingerprint = null;
        updateSilently({ recoveryConfirmed: false });
        return;
      }
      const { authority, commandBody, fingerprint } = intent;
      if (fingerprint !== lastRecoveryIntentFingerprint
        || !lastRecoveryIdempotencyKey) {
        lastRecoveryIntentFingerprint = fingerprint;
        lastRecoveryIdempotencyKey = makeKey("outreach-recover-account");
      }
      const command = Symbol("recover-account");
      activeCommand = command;
      confirmedRecoveryIntentFingerprint = null;
      const own = generation;
      emit({
        phase: "saving",
        error: null,
        conflict: false,
        recoveryConfirmed: false,
        recoveryNotice: null
      });
      try {
        const response = await options.api.recoverAccountActions(
          authority.id,
          commandBody,
          authority.etag,
          lastRecoveryIdempotencyKey,
          aborter.signal
        );
        if (!current(own) || activeCommand !== command) return;
        if (response.accountId !== authority.accountId
          || response.accountLoginStateVersion
            !== authority.accountLoginStateVersion
          || response.riskPaused
          || !sameIds(response.enabledActionIds, commandBody.pendingActionIds)
          || !sameIds(response.acknowledgedUncertainActionIds,
            commandBody.acknowledgedUncertainActionIds)) {
          throw new Error("服务器返回的账号恢复结果与已确认队列不一致");
        }
        activeCommand = null;
        emit({
          phase: "ready",
          executionGate: executionGateFromRecovery(response),
          recoveryConfirmed: false,
          recoveryNotice: `已恢复 ${response.enabledActionIds.length} 条公开评论，正在等待服务器领取。`
        });
        await startPoll(authority.id, own);
      } catch (error) {
        if (current(own)) emit({
          phase: "ready",
          error: errorText(error),
          recoveryConfirmed: false
        });
      } finally {
        if (activeCommand === command) activeCommand = null;
      }
    },
    async reconcileAction(actionId) {
      if (!state.batch || activeCommand || !options.api.reconcileAction) return;
      const action = state.actions.find((candidate) => candidate.id === actionId);
      if (!action || !(action.status === "risk_paused" || (action.executionTarget === "desktop" && action.status === "reconciliation_required"))
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
          || !(reconciled.status === "succeeded" || (action.executionTarget === "desktop"
            && reconciled.executionTarget === "desktop" && reconciled.status === action.status))) {
          if (current(own)) emit({ phase: "error", error: "只读回执核验结果与冻结动作不一致" });
          return;
        }
        if (activeCommand === command) activeCommand = null;
        emit({ phase: "ready", recoveryNotice: action.executionTarget === "desktop" && reconciled.status !== "succeeded"
          ? "已记录人工核对请求；等待只读对账，绝不会自动重发" : null,
          actions: state.actions.map((candidate) =>
          candidate.id === reconciled.id ? reconciled : candidate) });
      } catch (error) {
        if (current(own)) emit({ phase: "error", error: errorText(error) });
      } finally { if (activeCommand === command) activeCommand = null; }
    },
    abort() { if (!state.closed) reset(); },
    close() { if (state.closed) return; reset(); emit({ closed: true, phase: "idle" }); listeners.clear(); }
  };
}
