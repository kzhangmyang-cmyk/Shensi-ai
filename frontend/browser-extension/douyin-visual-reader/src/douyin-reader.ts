import type { StableErrorCode, VisualReaderLimits } from "./protocol";

export interface DomOnlyObservation {
  clientObservationKey: string;
  redactedCrop: unknown | null;
}

export interface BoundedReader {
  start(): Promise<void>;
  acknowledge(batchId: string): Promise<boolean>;
  userTakeover(): void;
  stop(): void;
  usage(): { observationCount: number; scrollCount: number; ocrCallCount: number };
}

export class BoundedReaderError extends Error {
  constructor(readonly code: StableErrorCode) {
    super(code);
    this.name = "BoundedReaderError";
  }
}

class ReaderStopped extends Error {}

const MAX_TERMINAL_FINALIZATION_RESERVE_MS = 1_000;

export function deriveVisualReaderDeadlines(
  startedAt: number,
  maxDurationMs: number
): { sessionDeadlineAt: number; workDeadlineAt: number } {
  const terminalReserveMs = Math.min(
    MAX_TERMINAL_FINALIZATION_RESERVE_MS,
    Math.max(1, Math.floor(maxDurationMs / 5))
  );
  const sessionDeadlineAt = startedAt + maxDurationMs;
  return {
    sessionDeadlineAt,
    workDeadlineAt: sessionDeadlineAt - terminalReserveMs
  };
}

export function startVisualReaderWithinDeadlines(dependencies: {
  deadlines: ReturnType<typeof deriveVisualReaderDeadlines>;
  now?: () => number;
  queueBudgetTerminal(
    deadlines: ReturnType<typeof deriveVisualReaderDeadlines>,
    deadlineCheckedAt: number
  ): void | Promise<void>;
  startReader(deadlines: ReturnType<typeof deriveVisualReaderDeadlines>): Promise<void>;
}): Promise<void> {
  const deadlineCheckedAt = (dependencies.now ?? (() => Date.now()))();
  if (deadlineCheckedAt >= dependencies.deadlines.workDeadlineAt) {
    try {
      return Promise.resolve(dependencies.queueBudgetTerminal(
        dependencies.deadlines,
        deadlineCheckedAt
      ));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return dependencies.startReader(dependencies.deadlines);
}

export function createBoundedReader(dependencies: {
  sessionId: string;
  limits: VisualReaderLimits;
  artifactUploadEnabled: boolean;
  now?: () => number;
  workDeadlineAt?: number;
  scheduleTimeout?: (callback: () => void, delay: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
  retryDelayMs?: number;
  extract(signal?: AbortSignal): Promise<DomOnlyObservation[]>;
  programmaticScroll(index: number, signal?: AbortSignal): Promise<void>;
  sendBatch(batch: {
    batchId: string;
    observations: DomOnlyObservation[];
  }): Promise<void | { accepted: boolean }>;
  sendTerminal(terminal: {
    status: "completed" | "partial_success" | "aborted";
    errorCodes: StableErrorCode[];
  }): void | Promise<void>;
}): BoundedReader {
  const seen = new Set<string>();
  const now = dependencies.now ?? (() => Date.now());
  const scheduleTimeout = dependencies.scheduleTimeout
    ?? ((callback: () => void, delay: number) => globalThis.setTimeout(callback, delay));
  const cancelTimeout = dependencies.cancelTimeout
    ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const retryDelayMs = Math.max(1, Math.min(1_000, dependencies.retryDelayMs ?? 100));
  const workDeadlineAt = dependencies.workDeadlineAt ?? now() + dependencies.limits.maxDurationMs;
  const operationAbort = new AbortController();
  let stopped = false;
  let takeover = false;
  let requestedAbort = false;
  let running = false;
  let terminalEmitted = false;
  let batchSequence = 0;
  let pendingBatchId: string | null = null;
  let resolveAck: (() => void) | null = null;
  let resolveStop: (() => void) | null = null;
  const stoppedSignal = new Promise<void>((resolve) => { resolveStop = resolve; });
  const usage = { observationCount: 0, scrollCount: 0, ocrCallCount: 0 };

  function remainingMs(): number {
    return workDeadlineAt - now();
  }

  async function withinDeadline<T>(operation: Promise<T>): Promise<T> {
    const remaining = remainingMs();
    if (remaining <= 0) {
      emitBudgetTerminalOnce();
      throw new BoundedReaderError("visual_reader_budget_exhausted");
    }
    let timer: unknown = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = scheduleTimeout(() => {
        timer = null;
        emitBudgetTerminalOnce();
        operationAbort.abort();
        reject(new BoundedReaderError("visual_reader_budget_exhausted"));
      }, remaining);
    });
    const interrupted = stoppedSignal.then(() => { throw new ReaderStopped(); });
    try {
      return await Promise.race([operation, deadline, interrupted]);
    } finally {
      if (timer !== null) cancelTimeout(timer);
    }
  }

  async function waitRetry(): Promise<void> {
    let handle: unknown = null;
    const delay = new Promise<void>((resolve) => {
      handle = scheduleTimeout(() => {
        handle = null;
        resolve();
      }, Math.min(retryDelayMs, Math.max(1, remainingMs())));
    });
    try {
      await withinDeadline(delay);
    } finally {
      if (handle !== null) cancelTimeout(handle);
    }
  }

  async function deliverBatch(batch: {
    batchId: string;
    observations: DomOnlyObservation[];
  }): Promise<void> {
    while (!stopped) {
      try {
        const response = await withinDeadline(dependencies.sendBatch(batch));
        if (response === undefined || response.accepted) return;
      } catch (error) {
        if (error instanceof BoundedReaderError || error instanceof ReaderStopped) throw error;
      }
      await waitRetry();
    }
    throw new ReaderStopped();
  }

  async function send(observations: DomOnlyObservation[]): Promise<void> {
    const batches: DomOnlyObservation[][] = [];
    let current: DomOnlyObservation[] = [];
    let cropCount = 0;
    for (const observation of observations) {
      const item = dependencies.artifactUploadEnabled
        ? observation
        : { ...observation, redactedCrop: null };
      const nextCropCount = cropCount + (item.redactedCrop === null ? 0 : 1);
      if (current.length >= 20 || nextCropCount > 5) {
        batches.push(current);
        current = [];
        cropCount = 0;
      }
      current.push(item);
      cropCount += item.redactedCrop === null ? 0 : 1;
    }
    if (current.length > 0) batches.push(current);
    for (const batch of batches) {
      if (stopped) break;
      batchSequence += 1;
      const batchId = `batch-${batchSequence}`;
      pendingBatchId = batchId;
      const acknowledged = new Promise<void>((resolve) => { resolveAck = resolve; });
      const retainedBatch = { batchId, observations: batch };
      await deliverBatch(retainedBatch);
      for (;;) {
        let retryHandle: unknown = null;
        const retryReady = new Promise<"retry">((resolve) => {
          retryHandle = scheduleTimeout(() => {
            retryHandle = null;
            resolve("retry");
          }, Math.min(retryDelayMs, Math.max(1, remainingMs())));
        });
        let outcome: "ack" | "retry";
        try {
          outcome = await withinDeadline(Promise.race([
            acknowledged.then(() => "ack" as const),
            retryReady
          ]));
        } finally {
          if (retryHandle !== null) cancelTimeout(retryHandle);
        }
        if (outcome === "ack") break;
        await deliverBatch(retainedBatch);
      }
      pendingBatchId = null;
      resolveAck = null;
    }
  }

  function emitTerminalOnce(terminal: {
    status: "completed" | "partial_success" | "aborted";
    errorCodes: StableErrorCode[];
  }): void {
    if (terminalEmitted) return;
    terminalEmitted = true;
    try {
      void Promise.resolve(dependencies.sendTerminal(terminal)).catch(() => undefined);
    } catch {
      // The runtime transport owns bounded terminal retries; reader settlement cannot block on it.
    }
  }

  function emitBudgetTerminalOnce(): void {
    if (stopped) return;
    emitTerminalOnce({
      status: "partial_success",
      errorCodes: ["visual_reader_budget_exhausted"]
    });
  }

  function interrupt(userTakeover: boolean): void {
    if (userTakeover) takeover = true;
    else requestedAbort = true;
    stopped = true;
    operationAbort.abort();
    resolveStop?.();
  }

  return {
    async start() {
      if (running) return;
      running = true;
      let noProgressCycles = 0;
      try {
        try {
          while (!stopped) {
            const extracted = await withinDeadline(dependencies.extract(operationAbort.signal));
            const fresh: DomOnlyObservation[] = [];
            for (const item of extracted) {
              if (fresh.length + usage.observationCount >= dependencies.limits.maxCommentsPerVideo) break;
              if (typeof item.clientObservationKey !== "string" || seen.has(item.clientObservationKey)) continue;
              seen.add(item.clientObservationKey);
              const normalized = dependencies.artifactUploadEnabled
                ? item
                : { ...item, redactedCrop: null };
              if (normalized.redactedCrop !== null) usage.ocrCallCount += 1;
              fresh.push(normalized);
            }
            if (fresh.length > 0) {
              noProgressCycles = 0;
              usage.observationCount += fresh.length;
              await send(fresh);
            } else {
              noProgressCycles += 1;
            }
            if (stopped || usage.observationCount >= dependencies.limits.maxCommentsPerVideo
              || noProgressCycles >= 2 || usage.scrollCount >= dependencies.limits.maxScrolls) break;
            usage.scrollCount += 1;
            await withinDeadline(dependencies.programmaticScroll(
              usage.scrollCount,
              operationAbort.signal
            ));
          }
        } catch (error) {
          if (error instanceof ReaderStopped) {
            // Terminal selection below reflects user takeover or explicit stop.
          } else if (error instanceof BoundedReaderError) {
            emitTerminalOnce({ status: "partial_success", errorCodes: [error.code] });
            return;
          } else {
            throw error;
          }
        }
        emitTerminalOnce(takeover
          ? { status: "aborted", errorCodes: ["visual_reader_user_takeover"] }
          : requestedAbort
            ? { status: "aborted", errorCodes: [] }
            : { status: "completed", errorCodes: [] });
      } finally {
        running = false;
        pendingBatchId = null;
        resolveAck = null;
        operationAbort.abort();
        resolveStop?.();
      }
    },
    async acknowledge(batchId) {
      if (batchId !== pendingBatchId || resolveAck === null) return false;
      const resolve = resolveAck;
      resolveAck = null;
      resolve();
      return true;
    },
    userTakeover() { interrupt(true); },
    stop() { interrupt(false); },
    usage() { return { ...usage }; }
  };
}
