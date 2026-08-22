import {
  BRIDGE_VERSION,
  canonicalDouyinVideoUrl,
  parseExtensionEvent,
  parsePageCommand,
  type ExtensionEvent,
  type PageCommand
} from "./protocol";
import {
  createSessionCoordinator,
  sha256,
  type SessionCoordinator,
  type VisualReaderPersistedState
} from "./session-coordinator";
import {
  boundTabDocumentLifecycleIsTakeover,
  boundTabReplacementIsTakeover,
  focusLeavesBoundWindow,
  prepareFreshDouyinTab,
  sameWindowActivationIsTakeover,
  type BoundDouyinTab,
  type ConfirmedDouyinTab
} from "./tab-guard";
import { recoverOrphanedVisualReaderSession } from "./restart-recovery";
import { createVisualCaptureAuthorizationResolver } from "./visual-capture-authorization";
import type { VisualCaptureRequest } from "./visual-capture-guard";
import { createVisualCaptureRuntime } from "./visual-capture-runtime";
import { validateVisualCaptureEvidence } from "./visual-evidence-validator";
import { invalidateCoordinatorOwnership } from "./visual-coordinator-ownership";
import { createVisualTransitionBarrier } from "./visual-transition-barrier";

declare const chrome: any;

let coordinator: SessionCoordinator | null = null;
let coordinatorGeneration = 0;
const coordinatorOwnership = {
  get current() { return coordinator; },
  set current(value: SessionCoordinator | null) { coordinator = value; },
  get generation() { return coordinatorGeneration; },
  set generation(value: number) { coordinatorGeneration = value; }
};
const coordinatorTransitions = createVisualTransitionBarrier();
const POPUP_CONFIRMATION_TTL_MS = 30_000;
type PopupConfirmation = Readonly<{
  token: string;
  target: SessionCoordinator;
  sessionId: string;
  generation: number;
  transitionRevision: number;
  artifactUploadEnabled: boolean;
  expiresAt: number;
}>;
let popupConfirmation: PopupConfirmation | null = null;
const epochBytes = new Uint8Array(16);
globalThis.crypto.getRandomValues(epochBytes);
const visualRuntimeEpoch = Array.from(epochBytes,
  (byte) => byte.toString(16).padStart(2, "0")).join("");

const visualCaptureAuthorization = createVisualCaptureAuthorizationResolver({
  getCoordinator: () => coordinator,
  getGeneration: () => coordinatorGeneration,
  getTab: async (tabId) => chrome.tabs.get(tabId).catch(() => null),
  getFocusedWindowId: async () => {
    const focusedWindow = await chrome.windows.getLastFocused({ populate: false }).catch(() => null);
    return Number.isSafeInteger(focusedWindow?.id) ? focusedWindow.id : null;
  }
});

async function ensureVisualOffscreenDocument(runtimeGeneration: number): Promise<void> {
  if (!await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "在扩展内存中遮挡评论卡并运行本地 OCR"
    });
  }
  const response = await chrome.runtime.sendMessage({
    kind: "visual_ocr_sync_generation",
    runtimeEpoch: visualRuntimeEpoch,
    runtimeGeneration
  });
  if (!record(response) || response.accepted !== true) {
    throw new Error("offscreen generation synchronization failed");
  }
}

const visualCaptureRuntime = createVisualCaptureRuntime({
  runtimeEpoch: visualRuntimeEpoch,
  authorize: visualCaptureAuthorization,
  ensureOffscreen: ensureVisualOffscreenDocument,
  reserveOcrCall: async (request) => {
    const target = coordinator;
    const generation = coordinatorGeneration;
    if (!target) return false;
    const before = target.snapshot();
    if (before.status !== "reading" || before.sessionId !== request.sessionId
      || before.artifactUploadEnabled !== true
      || before.usage.ocrCallCount >= before.limits.maxOcrCalls) return false;
    await target.updateUsage({ ocrCallCount: before.usage.ocrCallCount + 1 });
    if (coordinator !== target || coordinatorGeneration !== generation) return false;
    const after = target.snapshot();
    return after.status === "reading" && after.sessionId === request.sessionId
      && after.usage.ocrCallCount === before.usage.ocrCallCount + 1;
  },
  captureVisibleTab: async (_request, owner) => {
    let dataUrl: string | null = await chrome.tabs.captureVisibleTab(owner.windowId, { format: "png" });
    return {
      get dataUrl() { return dataUrl ?? ""; },
      clear() { dataUrl = null; }
    };
  },
  processOffscreen: (message) => {
    try {
      return chrome.runtime.sendMessage(message);
    } finally {
      message.screenshotDataUrl = "";
    }
  },
  validateEvidence: validateVisualCaptureEvidence,
  endOffscreenSession: async (runtimeGeneration) => {
    if (!await chrome.offscreen.hasDocument()) return true;
    const response = await chrome.runtime.sendMessage({
      kind: "visual_ocr_end_session",
      runtimeEpoch: visualRuntimeEpoch,
      runtimeGeneration
    });
    return record(response) && response.accepted === true;
  }
});

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownsCoordinator(target: SessionCoordinator, generation: number,
  transitionRevision: number): boolean {
  return coordinator === target && coordinatorGeneration === generation
    && coordinatorTransitions.isCurrent(transitionRevision);
}

function invalidatePopupConfirmation(): void {
  popupConfirmation = null;
}

function issuePopupConfirmation(input: Omit<PopupConfirmation, "token" | "expiresAt">): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  popupConfirmation = Object.freeze({
    ...input,
    token,
    expiresAt: Date.now() + POPUP_CONFIRMATION_TTL_MS
  });
  return token;
}

function takePopupConfirmation(token: string): PopupConfirmation | null {
  const current = popupConfirmation;
  popupConfirmation = null;
  if (!current || current.token !== token || Date.now() >= current.expiresAt
    || !ownsCoordinator(current.target, current.generation, current.transitionRevision)) return null;
  const latest = current.target.snapshot();
  return latest.status === "authorized" && latest.sessionId === current.sessionId
    && latest.artifactUploadEnabled === current.artifactUploadEnabled ? current : null;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  return actual.length === keys.length && keys.every((key) => key in value)
    && actual.every((key) => allowed.has(key));
}

async function persist(state: VisualReaderPersistedState): Promise<void> {
  await chrome.storage.session.set({ visualReaderSession: state });
}

async function recoverAfterServiceWorkerRestart(): Promise<void> {
  const ending = visualCaptureRuntime.endSession();
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  await ending;
  await recoverOrphanedVisualReaderSession({
    load: async () => (await chrome.storage.session.get("visualReaderSession"))?.visualReaderSession ?? null,
    clear: async () => { await chrome.storage.session.remove("visualReaderSession"); },
    notifyGoodJob: async (tabId, message) => { await chrome.tabs.sendMessage(tabId, message); },
    notifyDouyin: async (tabId, message) => { await chrome.tabs.sendMessage(tabId, message); }
  });
}

function safeLog(entry: { event: string; reason?: string; sessionId?: string }): void {
  console.info({ component: "goodjob_visual_reader", ...entry });
}

function createCoordinator(): SessionCoordinator {
  return createSessionCoordinator({ persist, log: safeLog, nonceHash: sha256 });
}

async function sendToGoodJob(tabId: number, event: ExtensionEvent): Promise<void> {
  await chrome.tabs.sendMessage(tabId, { kind: "goodjob_extension_event", event });
}

function beginCaptureInvalidation(): {
  target: SessionCoordinator | null;
  ending: Promise<boolean>;
  transitionRevision: number;
} {
  invalidatePopupConfirmation();
  const transitionRevision = coordinatorTransitions.invalidatePending();
  const target = invalidateCoordinatorOwnership(coordinatorOwnership);
  const ending = visualCaptureRuntime.endSession();
  return { target, ending, transitionRevision };
}

async function settleAbort(target: SessionCoordinator | null,
  reason: "visual_reader_user_takeover" | "user_requested"): Promise<void> {
  if (!target) return;
  const snapshot = target.snapshot();
  if (["completed", "partial_success", "aborted"].includes(snapshot.status)) {
    await target.whenMutationsSettled();
    return;
  }
  const nonce = target.rawChannelNonce();
  if (snapshot.douyinTabId !== null) {
    await chrome.tabs.sendMessage(snapshot.douyinTabId, {
      kind: "visual_reader_abort",
      sessionId: snapshot.sessionId
    }).catch(() => undefined);
  }
  await target.abort(reason);
  await target.whenMutationsSettled();
  if (nonce) {
    await sendToGoodJob(snapshot.goodJobTabId, {
      version: BRIDGE_VERSION,
      type: "terminal",
      channelNonce: nonce,
      sessionId: snapshot.sessionId,
      status: "aborted",
      errorCodes: reason === "visual_reader_user_takeover" ? ["visual_reader_user_takeover"] : []
    }).catch(() => undefined);
  }
}

async function safeAbort(reason: "visual_reader_user_takeover" | "user_requested"): Promise<void> {
  const invalidation = beginCaptureInvalidation();
  await coordinatorTransitions.schedule(async () => {
    try {
      await settleAbort(invalidation.target, reason);
    } finally {
      await invalidation.ending;
    }
  });
}

async function handleGoodJobCommand(
  raw: unknown,
  sender: any
): Promise<{ event?: ExtensionEvent; accepted?: boolean }> {
  if (!exact(raw, ["kind", "origin", "command"]) || raw.kind !== "goodjob_page_command"
    || typeof raw.origin !== "string" || !sender.tab?.id || sender.origin !== raw.origin) return {};
  const command = parsePageCommand(raw.command, raw.origin);
  if (!command) return {};
  if (command.type === "probe") {
    return { event: {
      version: BRIDGE_VERSION,
      type: "ready",
      channelNonce: command.channelNonce,
      extensionVersion: chrome.runtime.getManifest().version
    } };
  }
  if (command.type === "start") {
    const invalidation = beginCaptureInvalidation();
    return coordinatorTransitions.schedule(async () => {
      try {
        await settleAbort(invalidation.target, "user_requested");
      } finally {
        await invalidation.ending;
      }
      if (!coordinatorTransitions.isCurrent(invalidation.transitionRevision)
        || coordinator !== null) return { accepted: false };
      const target = createCoordinator();
      coordinator = target;
      await target.authorizeFromGoodJob({
        goodJobTabId: sender.tab.id,
        channelNonce: command.channelNonce,
        sessionId: command.sessionId,
        limits: command.limits,
        artifactUploadEnabled: command.artifactUploadEnabled
      });
      if (!coordinatorTransitions.isCurrent(invalidation.transitionRevision)
        || coordinator !== target) return { accepted: false };
      return { accepted: true };
    });
  }
  const target = coordinator;
  const generation = coordinatorGeneration;
  const transitionRevision = coordinatorTransitions.currentRevision();
  if (!target) return {};
  const snapshot = target.snapshot();
  if (command.sessionId !== snapshot.sessionId || sender.tab.id !== snapshot.goodJobTabId) return {};
  if (command.type === "acknowledge_batch") {
    const channelNonce = target.rawChannelNonce();
    if (!ownsCoordinator(target, generation, transitionRevision)
      || !target.canAcknowledgeBatch(command.sessionId, command.batchId)
      || channelNonce === null || command.channelNonce !== channelNonce
      || snapshot.douyinTabId === null) return { accepted: false };
    try {
      const response = await chrome.tabs.sendMessage(snapshot.douyinTabId, {
        kind: "visual_reader_ack",
        channelNonce,
        sessionId: command.sessionId,
        batchId: command.batchId
      });
      if (!record(response) || response.accepted !== true) return { accepted: false };
    } catch {
      return { accepted: false };
    }
    if (!ownsCoordinator(target, generation, transitionRevision)
      || !target.canAcknowledgeBatch(command.sessionId, command.batchId)) {
      return { accepted: false };
    }
    return { accepted: target.commitAcknowledgedBatch(command.sessionId, command.batchId) };
  }
  await safeAbort("user_requested");
  return { accepted: true };
}

async function popupSnapshot(): Promise<unknown> {
  invalidatePopupConfirmation();
  const target = coordinator;
  const generation = coordinatorGeneration;
  const transitionRevision = coordinatorTransitions.currentRevision();
  const snapshot = target?.snapshot() ?? null;
  const current = (): boolean => target === null
    ? coordinator === null && coordinatorTransitions.isCurrent(transitionRevision)
    : ownsCoordinator(target, generation, transitionRevision)
      && target.snapshot().sessionId === snapshot?.sessionId
      && target.snapshot().artifactUploadEnabled === snapshot?.artifactUploadEnabled
      && target.snapshot().status === snapshot?.status;
  const focusedWindow = await chrome.windows.getLastFocused({ populate: false });
  if (!current()) return { session: null, tabs: [], confirmationToken: null };
  const windowId = Number.isSafeInteger(focusedWindow?.id) ? focusedWindow.id as number : null;
  const tabs = windowId === null ? [] : await chrome.tabs.query({
    windowId,
    url: "https://www.douyin.com/*"
  });
  if (!current()) return { session: null, tabs: [], confirmationToken: null };
  const confirmationToken = target && snapshot?.status === "authorized"
    ? issuePopupConfirmation({
        target,
        sessionId: snapshot.sessionId,
        generation,
        transitionRevision,
        artifactUploadEnabled: snapshot.artifactUploadEnabled
      })
    : null;
  return {
    session: snapshot ? {
      sessionId: snapshot.sessionId,
      limits: snapshot.limits,
      usage: snapshot.usage,
      artifactUploadEnabled: snapshot.artifactUploadEnabled,
      status: snapshot.status
    } : null,
    tabs: tabs.flatMap((tab: any) => {
      const canonical = typeof tab.url === "string" ? canonicalDouyinVideoUrl(tab.url) : null;
      return canonical && Number.isSafeInteger(tab.id) && Number.isSafeInteger(tab.windowId) ? [{
        id: tab.id,
        windowId: tab.windowId,
        title: typeof tab.title === "string" ? tab.title.slice(0, 160) : "抖音视频",
        url: canonical.sourceUrl
      }] : [];
    }),
    confirmationToken
  };
}

async function confirmPopup(selected: ConfirmedDouyinTab,
  confirmationToken: string): Promise<{ accepted: boolean }> {
  const confirmation = takePopupConfirmation(confirmationToken);
  if (!confirmation) return { accepted: false };
  const { target, generation, transitionRevision } = confirmation;
  const snapshot = target.snapshot();
  if (snapshot.status !== "authorized" || snapshot.sessionId !== confirmation.sessionId
    || snapshot.artifactUploadEnabled !== confirmation.artifactUploadEnabled) {
    return { accepted: false };
  }
  const channelNonce = target.rawChannelNonce();
  if (!channelNonce) return { accepted: false };
  const matchesBinding = (status: "authorized" | "reading"): boolean => {
    if (!ownsCoordinator(target, generation, transitionRevision)) return false;
    const latest = target.snapshot();
    return latest.sessionId === snapshot.sessionId && latest.goodJobTabId === snapshot.goodJobTabId
      && latest.artifactUploadEnabled === confirmation.artifactUploadEnabled
      && latest.status === status;
  };
  const current = (status: "authorized" | "reading"): boolean =>
    Date.now() < confirmation.expiresAt && matchesBinding(status);
  const rejectHalfStarted = async (): Promise<{ accepted: false }> => {
    if (matchesBinding("reading")) await safeAbort("user_requested");
    return { accepted: false };
  };
  if (!current("authorized")) return { accepted: false };
  const prepared = await prepareFreshDouyinTab(selected, {
    getTab: async (tabId) => {
      if (!current("authorized")) throw new Error("popup confirmation invalidated");
      const tab = await chrome.tabs.get(tabId);
      if (!current("authorized")) throw new Error("popup confirmation invalidated");
      return {
        id: tab.id,
        windowId: tab.windowId,
        url: typeof tab.url === "string" ? tab.url : "",
        active: tab.active === true
      };
    },
    focusWindow: async (windowId) => {
      if (!current("authorized")) throw new Error("popup confirmation invalidated");
      await chrome.windows.update(windowId, { focused: true });
      if (!current("authorized")) throw new Error("popup confirmation invalidated");
    },
    activateTab: async (tabId) => {
      if (!current("authorized")) throw new Error("popup confirmation invalidated");
      await chrome.tabs.update(tabId, { active: true });
      if (!current("authorized")) throw new Error("popup confirmation invalidated");
    }
  });
  if (!prepared || !current("authorized")) return { accepted: false };
  try {
    if (!current("authorized")) return { accepted: false };
    await chrome.scripting.executeScript({ target: { tabId: prepared.id }, files: ["douyin-content.js"] });
    if (!current("authorized")) return { accepted: false };
    const confirmed = await target.confirmDouyinTab(prepared.id, prepared.windowId, prepared.url);
    if (!current(confirmed ? "reading" : "authorized")) return rejectHalfStarted();
    if (!confirmed) return { accepted: false };
    const response = await chrome.tabs.sendMessage(prepared.id, {
      kind: "visual_reader_start",
      sessionId: snapshot.sessionId,
      limits: snapshot.limits,
      artifactUploadEnabled: snapshot.artifactUploadEnabled,
      channelNonce
    });
    if (!current("reading")) return rejectHalfStarted();
    if (!record(response) || response.accepted !== true) {
      await safeAbort("user_requested");
      return { accepted: false };
    }
    return { accepted: true };
  } catch {
    if (current("authorized") || matchesBinding("reading")) {
      await safeAbort("user_requested");
    }
    return { accepted: false };
  }
}

function activeBinding(): BoundDouyinTab | null {
  const snapshot = coordinator?.snapshot();
  if (!snapshot || snapshot.status !== "reading" || snapshot.douyinTabId === null
    || snapshot.douyinWindowId === null || snapshot.douyinSourceUrl === null) return null;
  return {
    tabId: snapshot.douyinTabId,
    windowId: snapshot.douyinWindowId,
    url: snapshot.douyinSourceUrl
  };
}

async function handleReaderEvent(raw: unknown, sender: any): Promise<{ accepted: boolean }> {
  if (!exact(raw, ["kind", "event"]) || raw.kind !== "douyin_reader_event") {
    return { accepted: false };
  }
  const target = coordinator;
  const generation = coordinatorGeneration;
  const transitionRevision = coordinatorTransitions.currentRevision();
  if (!target) return { accepted: false };
  const event = parseExtensionEvent(raw.event);
  if (!event || event.type === "ready") return { accepted: false };
  const snapshot = target.snapshot();
  if (sender.tab?.id !== snapshot.douyinTabId || event.sessionId !== snapshot.sessionId
    || event.channelNonce !== target.rawChannelNonce()
    || !ownsCoordinator(target, generation, transitionRevision)) return { accepted: false };
  if (event.type === "observation_batch") {
    const receipt = target.receiveBatch(event.batchId);
    if (receipt === "blocked") return { accepted: false };
    await sendToGoodJob(snapshot.goodJobTabId, event);
    if (!ownsCoordinator(target, generation, transitionRevision)
      || target.snapshot().status !== "reading") return { accepted: false };
    if (receipt === "new") {
      await target.updateUsage({ observationCount:
        Math.min(snapshot.limits.maxCommentsPerVideo,
          snapshot.usage.observationCount + event.observations.length) });
      if (!ownsCoordinator(target, generation, transitionRevision)
        || target.snapshot().status !== "reading") return { accepted: false };
    }
    return { accepted: true };
  }
  const invalidation = beginCaptureInvalidation();
  const terminalTarget = invalidation.target;
  if (!terminalTarget) return { accepted: false };
  return coordinatorTransitions.schedule(async () => {
    try {
      await sendToGoodJob(snapshot.goodJobTabId, event);
      if (event.status === "aborted") {
        await terminalTarget.abort(event.errorCodes.includes("visual_reader_user_takeover")
          ? "visual_reader_user_takeover" : "user_requested");
      } else {
        await terminalTarget.finish(event.status === "completed" ? "completed" : "partial_success");
      }
      return { accepted: true };
    } finally {
      await invalidation.ending;
    }
  });
}

async function handleReaderUsage(raw: unknown, sender: any): Promise<{ accepted: boolean }> {
  if (!exact(raw, ["kind", "sessionId", "scrollCount"])
    || raw.kind !== "douyin_reader_usage" || typeof raw.sessionId !== "string"
    || !Number.isSafeInteger(raw.scrollCount) || !coordinator) return { accepted: false };
  const snapshot = coordinator.snapshot();
  if (sender.tab?.id !== snapshot.douyinTabId || raw.sessionId !== snapshot.sessionId
    || (raw.scrollCount as number) < 0 || (raw.scrollCount as number) > snapshot.limits.maxScrolls) {
    return { accepted: false };
  }
  await coordinator.updateUsage({ scrollCount: raw.scrollCount as number });
  return { accepted: true };
}

if (typeof chrome !== "undefined") {
  const startupRecovery = recoverAfterServiceWorkerRestart();
  chrome.runtime.onMessage.addListener((message: unknown, sender: any, sendResponse: (value: unknown) => void) => {
    if (record(message) && ["visual_process_capture", "visual_ocr_end_session",
      "visual_ocr_sync_generation"].includes(
      String(message.kind)
    )) return false;
    void (async () => {
      await startupRecovery;
      if (record(message) && message.kind === "goodjob_page_command") {
        return handleGoodJobCommand(message, sender);
      }
      if (exact(message, ["kind"]) && message.kind === "popup_snapshot") return popupSnapshot();
      if (exact(message, ["kind", "confirmationToken", "tab"]) && message.kind === "popup_confirm"
        && typeof message.confirmationToken === "string"
        && /^[0-9a-f]{48}$/u.test(message.confirmationToken)
        && exact(message.tab, ["id", "windowId", "url"])
        && Number.isSafeInteger(message.tab.id) && Number.isSafeInteger(message.tab.windowId)
        && typeof message.tab.url === "string") {
        return confirmPopup(message.tab as unknown as ConfirmedDouyinTab,
          message.confirmationToken);
      }
      if (exact(message, ["kind"]) && message.kind === "popup_abort") {
        await safeAbort("user_requested");
        return { accepted: true };
      }
      if (record(message) && message.kind === "douyin_reader_event") return handleReaderEvent(message, sender);
      if (record(message) && message.kind === "douyin_reader_usage") return handleReaderUsage(message, sender);
      if (record(message) && message.kind === "visual_capture_request") {
        return visualCaptureRuntime.handle(message, Number.isSafeInteger(sender.tab?.id) ? sender.tab.id : null);
      }
      return { accepted: false };
    })().then(sendResponse).catch(() => sendResponse({ accepted: false }));
    return true;
  });

  chrome.tabs.onActivated.addListener((activation: { tabId: number; windowId: number }) => {
    const binding = activeBinding();
    if (binding && sameWindowActivationIsTakeover(binding, activation)) {
      void safeAbort("visual_reader_user_takeover");
    }
  });
  chrome.windows.onFocusChanged.addListener((windowId: number) => {
    const binding = activeBinding();
    if (binding && focusLeavesBoundWindow(binding, windowId, chrome.windows.WINDOW_ID_NONE)) {
      void safeAbort("visual_reader_user_takeover");
    }
  });
  chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: { status?: string; url?: string }) => {
    const binding = activeBinding();
    if (binding && boundTabDocumentLifecycleIsTakeover(binding, tabId, changeInfo)) {
      void safeAbort("visual_reader_user_takeover");
    }
  });
  chrome.tabs.onReplaced.addListener((addedTabId: number, removedTabId: number) => {
    const binding = activeBinding();
    if (binding && boundTabReplacementIsTakeover(binding, addedTabId, removedTabId)) {
      void safeAbort("visual_reader_user_takeover");
    }
  });
  chrome.tabs.onRemoved.addListener((tabId: number) => {
    const snapshot = coordinator?.snapshot();
    if (snapshot && [snapshot.goodJobTabId, snapshot.douyinTabId].includes(tabId)) {
      void safeAbort("visual_reader_user_takeover");
    }
  });
}
