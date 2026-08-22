import { canonicalDouyinVideoUrl, type VisualReaderLimits } from "./protocol";

export interface VisualReaderUsageState {
  observationCount: number;
  scrollCount: number;
  ocrCallCount: number;
}

export interface VisualReaderPersistedState {
  sessionId: string;
  goodJobTabId: number;
  douyinTabId: number | null;
  douyinWindowId: number | null;
  douyinSourceUrl: string | null;
  limits: VisualReaderLimits;
  usage: VisualReaderUsageState;
  artifactUploadEnabled: boolean;
  channelNonceHash: string;
  status: "authorized" | "reading" | "completed" | "partial_success" | "aborted";
}

export interface VisualReaderRuntimeSnapshot extends VisualReaderPersistedState {
  pendingBatchId: string | null;
}

export interface SessionCoordinator {
  authorizeFromGoodJob(input: {
    goodJobTabId: number;
    channelNonce: string;
    sessionId: string;
    limits: VisualReaderLimits;
    artifactUploadEnabled: boolean;
  }): Promise<void>;
  confirmDouyinTab(tabId: number, windowId: number, url: string): Promise<boolean>;
  receiveBatch(batchId: string): "new" | "replay" | "blocked";
  beginBatch(batchId: string): boolean;
  canAcknowledgeBatch(sessionId: string, batchId: string): boolean;
  commitAcknowledgedBatch(sessionId: string, batchId: string): boolean;
  acknowledgeBatch(sessionId: string, batchId: string): boolean;
  updateUsage(usage: Partial<VisualReaderUsageState>): Promise<void>;
  finish(status: "completed" | "partial_success"): Promise<void>;
  abort(reason: "visual_reader_user_takeover" | "user_requested"): Promise<void>;
  whenMutationsSettled(): Promise<void>;
  snapshot(): VisualReaderRuntimeSnapshot;
  rawChannelNonce(): string | null;
}

export function createSessionCoordinator(dependencies: {
  persist(state: VisualReaderPersistedState): Promise<void>;
  log(entry: { event: string; reason?: string; sessionId?: string }): void;
  nonceHash(value: string): Promise<string>;
}): SessionCoordinator {
  let state: VisualReaderPersistedState | null = null;
  let pendingBatchId: string | null = null;
  let channelNonce: string | null = null;
  let mutationTail: Promise<void> = Promise.resolve();

  function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function requireState(): VisualReaderPersistedState {
    if (!state) throw new Error("视觉读取会话尚未授权");
    return state;
  }

  function copy(): VisualReaderPersistedState {
    const current = requireState();
    return {
      ...current,
      limits: { ...current.limits },
      usage: { ...current.usage }
    };
  }

  return {
    authorizeFromGoodJob(input) {
      return enqueueMutation(async () => {
        if (!Number.isSafeInteger(input.goodJobTabId) || input.goodJobTabId <= 0) {
          throw new Error("GoodJob 标签页无效");
        }
        const nonceDigest = await dependencies.nonceHash(input.channelNonce);
        state = {
          sessionId: input.sessionId,
          goodJobTabId: input.goodJobTabId,
          douyinTabId: null,
          douyinWindowId: null,
          douyinSourceUrl: null,
          limits: { ...input.limits },
          usage: { observationCount: 0, scrollCount: 0, ocrCallCount: 0 },
          artifactUploadEnabled: input.artifactUploadEnabled,
          channelNonceHash: nonceDigest,
          status: "authorized"
        };
        channelNonce = input.channelNonce;
        pendingBatchId = null;
        await dependencies.persist(copy());
        dependencies.log({ event: "visual_reader_authorized", sessionId: input.sessionId });
      });
    },
    confirmDouyinTab(tabId, windowId, url) {
      return enqueueMutation(async () => {
        const current = requireState();
        if (current.status !== "authorized" || current.douyinTabId !== null
          || current.douyinWindowId !== null
          || !Number.isSafeInteger(tabId) || tabId <= 0
          || !Number.isSafeInteger(windowId) || windowId < 0) return false;
        const source = canonicalDouyinVideoUrl(url);
        if (!source || source.sourceUrl !== url) return false;
        current.douyinTabId = tabId;
        current.douyinWindowId = windowId;
        current.douyinSourceUrl = source.sourceUrl;
        current.status = "reading";
        await dependencies.persist(copy());
        dependencies.log({ event: "visual_reader_tab_confirmed", sessionId: current.sessionId });
        return true;
      });
    },
    receiveBatch(batchId) {
      const current = requireState();
      if (current.status !== "reading" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(batchId)) {
        return "blocked";
      }
      if (pendingBatchId === batchId) return "replay";
      if (pendingBatchId !== null) return "blocked";
      pendingBatchId = batchId;
      return "new";
    },
    beginBatch(batchId) {
      return this.receiveBatch(batchId) !== "blocked";
    },
    canAcknowledgeBatch(sessionId, batchId) {
      const current = requireState();
      return current.status === "reading" && sessionId === current.sessionId
        && batchId === pendingBatchId;
    },
    commitAcknowledgedBatch(sessionId, batchId) {
      if (!this.canAcknowledgeBatch(sessionId, batchId)) return false;
      pendingBatchId = null;
      return true;
    },
    acknowledgeBatch(sessionId, batchId) {
      return this.commitAcknowledgedBatch(sessionId, batchId);
    },
    updateUsage(next) {
      return enqueueMutation(async () => {
        const current = requireState();
        if (current.status !== "reading") return;
        current.usage = {
          observationCount: Math.min(current.limits.maxCommentsPerVideo,
            Math.max(current.usage.observationCount, next.observationCount ?? current.usage.observationCount)),
          scrollCount: Math.min(current.limits.maxScrolls,
            Math.max(current.usage.scrollCount, next.scrollCount ?? current.usage.scrollCount)),
          ocrCallCount: Math.min(current.limits.maxOcrCalls,
            Math.max(current.usage.ocrCallCount, next.ocrCallCount ?? current.usage.ocrCallCount))
        };
        await dependencies.persist(copy());
      });
    },
    finish(status) {
      return enqueueMutation(async () => {
        const current = requireState();
        if (current.status !== "reading") return;
        current.status = status;
        pendingBatchId = null;
        channelNonce = null;
        await dependencies.persist(copy());
        dependencies.log({ event: "visual_reader_finished", sessionId: current.sessionId });
      });
    },
    abort(reason) {
      return enqueueMutation(async () => {
        const current = requireState();
        if (["completed", "partial_success", "aborted"].includes(current.status)) return;
        current.status = "aborted";
        pendingBatchId = null;
        channelNonce = null;
        await dependencies.persist(copy());
        dependencies.log({ event: "visual_reader_aborted", reason, sessionId: current.sessionId });
      });
    },
    whenMutationsSettled() {
      return mutationTail;
    },
    snapshot() {
      return { ...copy(), pendingBatchId };
    },
    rawChannelNonce() {
      return channelNonce;
    }
  };
}

export async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("浏览器缺少安全摘要支持");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  ));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
