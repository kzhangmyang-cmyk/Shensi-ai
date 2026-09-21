import type { ExtensionEvent } from "./protocol";

type TerminalEvent = Extract<ExtensionEvent, { type: "terminal" }>;

export interface ReliableEventTransport {
  sendBatch(event: Extract<ExtensionEvent, { type: "observation_batch" }>): Promise<{ accepted: boolean }>;
  queueTerminal(event: TerminalEvent, timing?: { deadlineCheckedAt: number }): void;
  whenIdle(): Promise<void>;
  close(): void;
}

export function createReliableEventTransport(dependencies: {
  send(event: ExtensionEvent): Promise<{ accepted: boolean }>;
  scheduleTimeout?: (callback: () => void, delay: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
  now?: () => number;
  deadlineAt?: number;
  retryDelayMs?: number;
  attemptTimeoutMs?: number;
  maxTerminalAttempts?: number;
}): ReliableEventTransport {
  const scheduleTimeout = dependencies.scheduleTimeout
    ?? ((callback: () => void, delay: number) => globalThis.setTimeout(callback, delay));
  const cancelTimeout = dependencies.cancelTimeout
    ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = dependencies.now ?? (() => Date.now());
  const deadlineAt = dependencies.deadlineAt;
  const retryDelayMs = Math.max(1, Math.min(1_000, dependencies.retryDelayMs ?? 100));
  const attemptTimeoutMs = Math.max(1, Math.min(5_000, dependencies.attemptTimeoutMs ?? 1_000));
  const maxAttempts = Math.max(1, Math.min(10, dependencies.maxTerminalAttempts ?? 5));
  let terminal: TerminalEvent | null = null;
  let attempts = 0;
  let timer: unknown = null;
  let attemptTimer: unknown = null;
  let closed = false;
  let idle: Promise<void> = Promise.resolve();
  let resolveIdle: (() => void) | null = null;

  function deadlineExpired(checkedAt: number): boolean {
    return deadlineAt !== undefined && checkedAt >= deadlineAt;
  }

  function remainingDeadlineMs(checkedAt: number): number {
    return deadlineAt === undefined ? Number.POSITIVE_INFINITY : deadlineAt - checkedAt;
  }

  function finish(): void {
    if (timer !== null) cancelTimeout(timer);
    if (attemptTimer !== null) cancelTimeout(attemptTimer);
    timer = null;
    attemptTimer = null;
    terminal = null;
    resolveIdle?.();
    resolveIdle = null;
  }

  function scheduleRetry(): void {
    const deadlineCheckedAt = now();
    if (closed || attempts >= maxAttempts || deadlineExpired(deadlineCheckedAt)) {
      finish();
      return;
    }
    timer = scheduleTimeout(() => {
      timer = null;
      void attempt();
    }, Math.min(retryDelayMs, remainingDeadlineMs(deadlineCheckedAt)));
  }

  async function attempt(deadlineCheckedAt = now()): Promise<void> {
    const event = terminal;
    if (!event || closed || deadlineExpired(deadlineCheckedAt)) return finish();
    attempts += 1;
    let sending: Promise<{ accepted: boolean }>;
    try {
      sending = dependencies.send(event);
    } catch {
      scheduleRetry();
      return;
    }
    try {
      const timeoutCheckedAt = now();
      const timeout: Promise<{ accepted: false }> = deadlineExpired(timeoutCheckedAt)
        ? Promise.resolve({ accepted: false })
        : new Promise((resolve) => {
            attemptTimer = scheduleTimeout(() => {
              attemptTimer = null;
              resolve({ accepted: false });
            }, Math.min(attemptTimeoutMs, remainingDeadlineMs(timeoutCheckedAt)));
          });
      const response = await Promise.race([sending, timeout]);
      if (attemptTimer !== null) cancelTimeout(attemptTimer);
      attemptTimer = null;
      if (response.accepted) return finish();
    } catch {
      if (attemptTimer !== null) cancelTimeout(attemptTimer);
      attemptTimer = null;
      // Retry the exact same closed event; no payload is logged or persisted.
    }
    scheduleRetry();
  }

  return {
    async sendBatch(event) {
      try {
        const response = await dependencies.send(event);
        return { accepted: response.accepted === true };
      } catch {
        return { accepted: false };
      }
    },
    queueTerminal(event, timing) {
      if (closed || terminal) return;
      terminal = structuredClone(event);
      attempts = 0;
      idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
      void attempt(timing?.deadlineCheckedAt ?? now());
    },
    whenIdle() { return idle; },
    close() {
      closed = true;
      finish();
    }
  };
}
