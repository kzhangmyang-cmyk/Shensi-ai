import {
  BRIDGE_VERSION,
  canonicalDouyinVideoUrl,
  parsePageCommand,
  parseVisualReaderAck,
  type ExtensionEvent,
  type VisualReaderLimits
} from "./protocol";
import {
  extractVisibleTopLevelComments,
  findExactReadOnlyAction,
  type DouyinDomAdapter
} from "./douyin-extractor";
import {
  BoundedReaderError,
  createBoundedReader,
  deriveVisualReaderDeadlines,
  startVisualReaderWithinDeadlines,
  type BoundedReader
} from "./douyin-reader";
import { createReliableEventTransport, type ReliableEventTransport } from "./runtime-transport";
import { matchesUnavailableSession } from "./restart-recovery";
import { requestVisualCaptureFallback } from "./visual-content-fallback";

declare const chrome: any;

const INSTALL_KEY = "__goodjobDouyinVisualReaderInstalledV1";

function browserAdapter(): DouyinDomAdapter {
  return {
    queryAll: (root, selector) => Array.from(root.querySelectorAll(selector)),
    role: (element) => element.getAttribute("role"),
    accessibleName: (element) => element.getAttribute("aria-label")?.trim() ?? "",
    innerText: (element) => (element as HTMLElement).innerText.trim(),
    attribute: (element, name) => element.getAttribute(name),
    parent: (element) => element.parentElement,
    visible: (element) => {
      if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    },
    bounds: (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    },
    textTruncated: (element) => {
      const target = element as HTMLElement;
      return element.getAttribute("aria-expanded") === "false"
        || target.scrollHeight > target.clientHeight + 1
        || target.scrollWidth > target.clientWidth + 1;
    },
    viewport: () => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
      deviceScaleFactor: globalThis.devicePixelRatio
    }),
    now: () => new Date()
  };
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value as Record<string, unknown>);
  const allowed = new Set(keys);
  return actual.length === keys.length && keys.every((key) => key in (value as object))
    && actual.every((key) => allowed.has(key));
}

function waitForDomStability(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let handle: ReturnType<typeof setTimeout> | null = null;
    let previous = document.querySelectorAll('[role="article"]').length;
    let stable = 0;
    const check = () => {
      if (signal?.aborted) return;
      const next = document.querySelectorAll('[role="article"]').length;
      stable = next === previous ? stable + 1 : 0;
      previous = next;
      if (stable >= 2) resolve();
      else handle = globalThis.setTimeout(check, 160);
    };
    signal?.addEventListener("abort", () => {
      if (handle !== null) globalThis.clearTimeout(handle);
      handle = null;
    }, { once: true });
    handle = globalThis.setTimeout(check, 160);
  });
}

if (typeof chrome !== "undefined" && !(globalThis as any)[INSTALL_KEY]) {
  (globalThis as any)[INSTALL_KEY] = true;
  type LifecycleOwner = Readonly<{ generation: number; sessionId: string; channelNonce: string }>;
  let reader: BoundedReader | null = null;
  let activeSessionId: string | null = null;
  let transport: ReliableEventTransport | null = null;
  let lifecycleGeneration = 0;
  let currentOwner: LifecycleOwner | null = null;
  let internalScrollUntil = 0;
  let internalClick = false;

  function ownsLifecycle(owner: LifecycleOwner): boolean {
    return currentOwner === owner && lifecycleGeneration === owner.generation;
  }

  function beginLifecycle(sessionId: string, channelNonce: string): LifecycleOwner {
    const previousReader = reader;
    const owner = Object.freeze({ generation: lifecycleGeneration + 1, sessionId, channelNonce });
    lifecycleGeneration = owner.generation;
    currentOwner = owner;
    reader = null;
    activeSessionId = sessionId;
    transport = null;
    previousReader?.stop();
    return owner;
  }

  function createSessionTransport(
    deadlineAt: number
  ): ReliableEventTransport {
    return createReliableEventTransport({
      deadlineAt,
      send: async (event) => {
        const response = await chrome.runtime.sendMessage({ kind: "douyin_reader_event", event });
        return {
          accepted: response !== null && typeof response === "object" && !Array.isArray(response)
            && (response as { accepted?: unknown }).accepted === true
        };
      }
    });
  }

  function budgetTerminal(input: {
    sessionId: string;
    channelNonce: string;
  }): Extract<ExtensionEvent, { type: "terminal" }> {
    return {
      version: BRIDGE_VERSION,
      type: "terminal",
      channelNonce: input.channelNonce,
      sessionId: input.sessionId,
      status: "partial_success",
      errorCodes: ["visual_reader_budget_exhausted"]
    };
  }

  async function finalizeEmptyWorkWindow(input: {
    sessionId: string;
    channelNonce: string;
  }, deadlines: ReturnType<typeof deriveVisualReaderDeadlines>, deadlineCheckedAt: number,
  owner: LifecycleOwner): Promise<void> {
    if (!ownsLifecycle(owner)) return;
    const sessionTransport = createSessionTransport(deadlines.sessionDeadlineAt);
    transport = sessionTransport;
    sessionTransport.queueTerminal(budgetTerminal(input), { deadlineCheckedAt });
    try {
      await sessionTransport.whenIdle();
    } finally {
      sessionTransport.close();
      if (ownsLifecycle(owner) && reader === null && transport === sessionTransport
        && activeSessionId === owner.sessionId) {
        transport = null;
        activeSessionId = null;
        currentOwner = null;
      }
    }
  }

  function installTakeoverListeners(sessionReader: BoundedReader): () => void {
    const listeners = new AbortController();
    const options = { capture: true, signal: listeners.signal };
    const takeover = () => sessionReader.userTakeover();
    globalThis.addEventListener("wheel", takeover, { ...options, passive: true });
    globalThis.addEventListener("pointerdown", takeover, { ...options, passive: true });
    globalThis.addEventListener("touchstart", takeover, { ...options, passive: true });
    globalThis.addEventListener("keydown", takeover, options);
    globalThis.addEventListener("click", () => { if (!internalClick) takeover(); }, options);
    globalThis.addEventListener("scroll", () => {
      if (Date.now() > internalScrollUntil) takeover();
    }, { ...options, passive: true });
    return () => listeners.abort();
  }

  async function start(input: {
    sessionId: string;
    limits: VisualReaderLimits;
    artifactUploadEnabled: boolean;
    channelNonce: string;
  }, deadlines: ReturnType<typeof deriveVisualReaderDeadlines>, owner: LifecycleOwner): Promise<void> {
    if (!ownsLifecycle(owner)) return;
    const adapter = browserAdapter();
    const source = canonicalDouyinVideoUrl(globalThis.location.href);
    if (!source) throw new BoundedReaderError("visual_source_invalid");
    let attemptedAction = false;
    const sessionTransport = createSessionTransport(deadlines.sessionDeadlineAt);
    transport = sessionTransport;
    const sessionReader = createBoundedReader({
      sessionId: input.sessionId,
      limits: input.limits,
      artifactUploadEnabled: input.artifactUploadEnabled,
      workDeadlineAt: deadlines.workDeadlineAt,
      extract: async (signal) => {
        if (!attemptedAction) {
          attemptedAction = true;
          const action = findExactReadOnlyAction(document, adapter);
          if (action.status === "ambiguous") throw new BoundedReaderError("visual_source_invalid");
          if (action.status === "one") {
            if (signal?.aborted) return [];
            internalClick = true;
            try { (action.element as HTMLElement).click(); } finally { internalClick = false; }
            await waitForDomStability(signal);
          }
        }
        const result = await extractVisibleTopLevelComments({
          document,
          adapter,
          sourceUrl: source.sourceUrl,
          visualFallback: input.artifactUploadEnabled ? async (fallback) => {
            if (signal?.aborted
              || sessionReader.usage().ocrCallCount >= input.limits.maxOcrCalls) return null;
            const resolved = await requestVisualCaptureFallback({
              observation: fallback.observation,
              domTextState: fallback.domTextState,
              sendMessage: async () => chrome.runtime.sendMessage({
                kind: "visual_capture_request",
                sessionId: input.sessionId,
                domTextState: fallback.domTextState,
                viewport: fallback.observation.viewport,
                cardBounds: fallback.observation.cardBounds,
                avatarBounds: fallback.avatarBounds,
                regions: fallback.regions
              })
            });
            if (signal?.aborted) return null;
            return resolved;
          } : undefined
        });
        if (result.status === "blocked") throw new BoundedReaderError("visual_source_invalid");
        return result.observations;
      },
      programmaticScroll: async (_index, signal) => {
        if (signal?.aborted) return;
        const videos = Array.from(document.querySelectorAll('[role="region"][aria-label="当前视频"]'));
        if (videos.length !== 1) throw new BoundedReaderError("visual_source_invalid");
        const feeds = Array.from(videos[0].querySelectorAll('[role="feed"]'))
          .filter((feed) => ["评论", "评论区"].includes(feed.getAttribute("aria-label") ?? ""));
        if (feeds.length !== 1) throw new BoundedReaderError("visual_source_invalid");
        internalScrollUntil = Date.now() + 800;
        const feed = feeds[0] as HTMLElement;
        feed.scrollBy({ top: Math.max(240, Math.min(480, feed.clientHeight * 0.8)), behavior: "auto" });
        await waitForDomStability(signal);
        if (signal?.aborted) return;
        await chrome.runtime.sendMessage({
          kind: "douyin_reader_usage",
          sessionId: input.sessionId,
          scrollCount: sessionReader.usage().scrollCount
        });
      },
      sendBatch: async (batch) => sessionTransport.sendBatch({
        version: BRIDGE_VERSION,
        type: "observation_batch",
        channelNonce: input.channelNonce,
        sessionId: input.sessionId,
        batchId: batch.batchId,
        observations: batch.observations as any
      }),
      sendTerminal: (terminal) => {
        sessionTransport.queueTerminal({
          version: BRIDGE_VERSION,
          type: "terminal",
          channelNonce: input.channelNonce,
          sessionId: input.sessionId,
          status: terminal.status,
          errorCodes: terminal.errorCodes
        });
      }
    });
    reader = sessionReader;
    const cleanupTakeover = installTakeoverListeners(sessionReader);
    try {
      await sessionReader.start();
    } finally {
      cleanupTakeover();
      if (ownsLifecycle(owner) && reader === sessionReader && activeSessionId === owner.sessionId) {
        reader = null;
        activeSessionId = null;
      }
      try {
        await sessionTransport.whenIdle();
      } finally {
        sessionTransport.close();
        if (ownsLifecycle(owner) && transport === sessionTransport) {
          transport = null;
          currentOwner = null;
        }
      }
    }
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (value: unknown) => void) => {
    if (exact(message, ["kind", "sessionId", "limits", "artifactUploadEnabled", "channelNonce"])
      && message.kind === "visual_reader_start") {
      const command = parsePageCommand({
        version: BRIDGE_VERSION,
        type: "start",
        channelNonce: message.channelNonce,
        sessionId: message.sessionId,
        limits: message.limits,
        artifactUploadEnabled: message.artifactUploadEnabled
      }, "https://www.douyin.com");
      if (!command || command.type !== "start") return;
      const owner = beginLifecycle(command.sessionId, command.channelNonce);
      sendResponse({ accepted: true });
      const deadlines = deriveVisualReaderDeadlines(Date.now(), command.limits.maxDurationMs);
      void startVisualReaderWithinDeadlines({
        deadlines,
        queueBudgetTerminal: (currentDeadlines, deadlineCheckedAt) => finalizeEmptyWorkWindow(
          command,
          currentDeadlines,
          deadlineCheckedAt,
          owner
        ),
        startReader: (currentDeadlines) => start(command, currentDeadlines, owner)
      }).catch(async () => {
        const fallback = createSessionTransport(deadlines.sessionDeadlineAt);
        if (ownsLifecycle(owner) && reader === null && activeSessionId === owner.sessionId) {
          transport = fallback;
        }
        fallback.queueTerminal({
          version: BRIDGE_VERSION,
          type: "terminal",
          channelNonce: command.channelNonce,
          sessionId: command.sessionId,
          status: "partial_success",
          errorCodes: ["visual_source_invalid"]
        });
        try {
          await fallback.whenIdle();
        } finally {
          fallback.close();
          if (ownsLifecycle(owner) && reader === null && transport === fallback
            && activeSessionId === owner.sessionId) {
            transport = null;
            activeSessionId = null;
            currentOwner = null;
          }
        }
      });
      return;
    }
    if (message !== null && typeof message === "object" && !Array.isArray(message)
      && (message as { kind?: unknown }).kind === "visual_reader_ack") {
      const acknowledgement = parseVisualReaderAck(message);
      const owner = currentOwner;
      const currentReader = reader;
      if (!acknowledgement || !owner || !currentReader || !ownsLifecycle(owner)
        || acknowledgement.sessionId !== activeSessionId
        || acknowledgement.sessionId !== owner.sessionId
        || acknowledgement.channelNonce !== owner.channelNonce) {
        sendResponse({ accepted: false });
        return;
      }
      void currentReader.acknowledge(acknowledgement.batchId)
        .then((accepted) => sendResponse({ accepted }));
      return true;
    }
    if (exact(message, ["kind", "sessionId"]) && message.kind === "visual_reader_abort"
      && message.sessionId === activeSessionId) {
      reader?.stop();
      sendResponse({ accepted: true });
      return;
    }
    if (matchesUnavailableSession(message, "visual_reader_unavailable", activeSessionId)) {
      const unavailableReader = reader;
      const unavailableTransport = transport;
      currentOwner = null;
      reader = null;
      transport = null;
      activeSessionId = null;
      unavailableReader?.stop();
      unavailableTransport?.close();
      sendResponse({ accepted: true });
    }
  });
}
