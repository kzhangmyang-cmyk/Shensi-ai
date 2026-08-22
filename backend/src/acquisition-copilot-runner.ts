import type {
  AgentMessage
} from "@earendil-works/pi-agent-core";
import {
  createAcquisitionPiAgent,
  DEFAULT_ACQUISITION_PI_RUN_LIMITS,
  type AcquisitionPiModelSnapshot,
  type AcquisitionPiRunFailureCode,
  type AcquisitionPiRunLimits,
  type AcquisitionPiTurnRuntime
} from "./acquisition-pi-agent.js";
import type {
  AcquisitionCopilotRunner
} from "./acquisition-copilot-service.js";
import type {
  AcquisitionPlanDraftGenerator
} from "./acquisition-plan-draft.js";
import type {
  AcquisitionAgentIdentity,
  AcquisitionAgentToolExecutor,
  AcquisitionToolAuditLedger
} from "./acquisition-pi-tools.js";

export interface AcquisitionPiRuntimeFactoryInput {
  identity: AcquisitionAgentIdentity;
  snapshot: AcquisitionPiModelSnapshot;
}

export interface AcquisitionPiRuntimeFactory {
  create(
    input: AcquisitionPiRuntimeFactoryInput
  ): Promise<AcquisitionPiTurnRuntime>;
}

export interface CreatePiAcquisitionCopilotRunnerOptions {
  runtimeFactory: AcquisitionPiRuntimeFactory;
  toolExecutor: AcquisitionAgentToolExecutor;
  toolAudit: AcquisitionToolAuditLedger;
  toolAuditSecret: string;
  systemPrompt?: string;
  runLimits?: AcquisitionPiRunLimits;
  now?: () => number;
}

function safeErrorCode(value: unknown) {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  return raw.match(/^[A-Z][A-Z0-9_]{2,63}/)?.[0]
    ?? "COPILOT_TASK_FAILED";
}

function toolNamesFrom(messages: AgentMessage[]) {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const content of message.content) {
        if (content.type === "toolCall" && content.name.trim()) {
          names.push(content.name.trim());
        }
      }
    } else if (message.role === "toolResult" && message.toolName.trim()) {
      names.push(message.toolName.trim());
    }
  }
  return [...new Set(names)];
}

function summaryFrom(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.content
      .filter((content) => content.type === "text")
      .map((content) => content.text.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text.slice(0, 4_000);
  }
  throw new Error("MODEL_EMPTY_RESPONSE");
}

function waitForRunAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
  failureCode: () => AcquisitionPiRunFailureCode
) {
  if (signal.aborted) {
    return Promise.reject(new Error(failureCode()));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(failureCode()));
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export function createPiAcquisitionCopilotRunner(
  options: CreatePiAcquisitionCopilotRunnerOptions
): AcquisitionCopilotRunner {
  const runLimits =
    options.runLimits ?? DEFAULT_ACQUISITION_PI_RUN_LIMITS;
  return {
    async run(input) {
      const runAbort = new AbortController();
      let runFailure: AcquisitionPiRunFailureCode | null = null;
      const failureCode = (): AcquisitionPiRunFailureCode =>
        input.signal?.aborted
          ? "MODEL_STREAM_ABORTED"
          : runFailure ?? "MODEL_STREAM_ABORTED";
      const fail = (code: AcquisitionPiRunFailureCode) => {
        if (code === "MODEL_STREAM_ABORTED" || runFailure === null) {
          runFailure = code;
        }
        if (!runAbort.signal.aborted) runAbort.abort(code);
      };
      const onExternalAbort = () => fail("MODEL_STREAM_ABORTED");
      if (input.signal?.aborted) {
        onExternalAbort();
      } else {
        input.signal?.addEventListener("abort", onExternalAbort, {
          once: true
        });
      }
      const durationTimer = setTimeout(
        () => fail("AGENT_DURATION_EXHAUSTED"),
        runLimits.maxDurationMs
      );
      const identity: AcquisitionAgentIdentity = {
        ownerId: input.ownerId,
        teamId: input.teamId,
        actorId: input.actorId,
        sessionId: input.sessionId
      };
      try {
        if (runAbort.signal.aborted) {
          throw new Error(failureCode());
        }
        const work = (async () => {
          const runtime = await options.runtimeFactory.create({
            identity: { ...identity },
            snapshot: structuredClone(input.snapshot)
          });
          if (runAbort.signal.aborted) {
            throw new Error(failureCode());
          }
          const existingMessages = input.transcript.map(
            (message) => structuredClone(message)
          );
          const agent = createAcquisitionPiAgent({
            identity,
            snapshot: input.snapshot,
            runtime,
            toolExecutor: options.toolExecutor,
            toolAudit: options.toolAudit,
            toolAuditSecret: options.toolAuditSecret,
            initialMessages: existingMessages,
            systemPrompt: options.systemPrompt,
            runLimits,
            signal: runAbort.signal,
            onFailure: fail,
            now: options.now
          });
          await agent.prompt(input.prompt);
          if (runFailure) throw new Error(failureCode());
          if (agent.state.errorMessage) {
            throw new Error(safeErrorCode(agent.state.errorMessage));
          }
          const newMessages = agent.state.messages
            .slice(existingMessages.length)
            .map((message) => structuredClone(message));
          return {
            newMessages,
            result: {
              summary: summaryFrom(newMessages),
              toolNames: toolNamesFrom(newMessages)
            }
          };
        })();
        return await waitForRunAbort(
          work,
          runAbort.signal,
          failureCode
        );
      } catch (error) {
        throw new Error(safeErrorCode(error));
      } finally {
        clearTimeout(durationTimer);
        input.signal?.removeEventListener(
          "abort",
          onExternalAbort
        );
      }
    }
  };
}

export function createRoutedAcquisitionCopilotRunner(options: {
  assistantRunner: AcquisitionCopilotRunner;
  planDraftGenerator: AcquisitionPlanDraftGenerator;
}): AcquisitionCopilotRunner {
  return {
    run(input) {
      if (input.responseMode === "assistant") {
        return options.assistantRunner.run(input);
      }
      return options.planDraftGenerator.generate({
        ownerId: input.ownerId,
        teamId: input.teamId,
        actorId: input.actorId,
        sessionId: input.sessionId,
        transcript: input.transcript.map((message) =>
          structuredClone(message)
        ),
        prompt: input.prompt,
        targetPlatform: input.targetPlatform ?? "web"
      }).then((generated) => ({
        newMessages: [{
          role: "user" as const,
          content: input.prompt,
          timestamp: Date.now()
        }, structuredClone(generated.assistantMessage)],
        result: {
          summary: generated.summary,
          toolNames: [],
          planDraft: structuredClone(generated.planDraft)
        }
      }));
    }
  };
}
