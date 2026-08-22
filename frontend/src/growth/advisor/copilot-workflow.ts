export interface AdvisorCopilotSession {
  readonly id: string;
}

export interface AdvisorCopilotTask {
  readonly id: string;
  readonly status: string;
  readonly result?: {
    readonly explanation?: string;
    readonly conclusion?: string;
  };
}

export interface AdvisorCopilotPorts {
  createSession(): Promise<AdvisorCopilotSession>;
  postMessage(
    sessionId: string,
    content: string
  ): Promise<{ messageId: string; taskId: string }>;
  getTask(taskId: string, signal?: AbortSignal): Promise<AdvisorCopilotTask>;
}

export interface AdvisorCopilotResult {
  readonly explanation: string;
  readonly aiUnavailable: boolean;
}

export interface AdvisorCopilotWorkflow {
  ask(
    prompt: string,
    signal?: AbortSignal
  ): Promise<AdvisorCopilotResult>;
}

const POLL_MAX_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 500;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

export function createAdvisorCopilotWorkflow(
  ports: AdvisorCopilotPorts
): AdvisorCopilotWorkflow {
  let session: AdvisorCopilotSession | null = null;
  let activePoll: AbortController | null = null;
  const workflow: AdvisorCopilotWorkflow = {
    async ask(prompt: string, signal?: AbortSignal) {
      activePoll?.abort();
      const controller = new AbortController();
      activePoll = controller;
      try {
        session ??= await ports.createSession();
        const { taskId } = await ports.postMessage(session.id, prompt);
        for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
          const task = await ports.getTask(taskId, controller.signal);
          if (task.status === "succeeded" || task.status === "completed") {
            return {
              explanation: task.result?.explanation
                ?? task.result?.conclusion ?? "",
              aiUnavailable: false
            };
          }
          if (task.status === "failed") {
            return { explanation: "", aiUnavailable: true };
          }
          await sleep(POLL_INTERVAL_MS, signal ?? controller.signal);
        }
        return { explanation: "", aiUnavailable: true };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return { explanation: "", aiUnavailable: true };
        }
        return { explanation: "", aiUnavailable: true };
      } finally {
        if (activePoll === controller) activePoll = null;
      }
    }
  };
  return Object.freeze(workflow);
}
