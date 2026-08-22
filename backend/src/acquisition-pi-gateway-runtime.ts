import { canonicalJsonStringify } from "./canonical-json.js";
import {
  ACQUISITION_FINAL_ANSWER_TOOL,
  ACQUISITION_MODEL_CONTENT_BUNDLE,
  ACQUISITION_PI_PROMPT_ID,
  ACQUISITION_PI_TOOL_SCHEMA_ID,
  DEFAULT_ACQUISITION_PI_SYSTEM_PROMPT
} from "./acquisition-model-content.js";
import type {
  AcquisitionPiModelSnapshot,
  AcquisitionPiTurnInput,
  AcquisitionPiTurnResult,
  AcquisitionPiTurnRuntime
} from "./acquisition-pi-agent.js";
import type {
  ModelContentBundle,
  ToolDefinition,
  ToolCallingRequest,
  ToolCallingResult
} from "./model-providers/gateway.js";
import { GROWTH_QUOTE_TOOL_NAMES } from "./growth-advisor-quote-tools.js";

export { ACQUISITION_FINAL_ANSWER_TOOL };

const MAX_TURN_PROMPT_CHARS = 500_000;
const MAX_FINAL_ANSWER_CHARS = 100_000;

export interface AcquisitionPiGatewayPort {
  callTools(request: ToolCallingRequest): Promise<ToolCallingResult>;
}

export interface ActiveModelGatewayAcquisitionPiRuntimeOptions {
  snapshot: AcquisitionPiModelSnapshot;
  gateway: AcquisitionPiGatewayPort;
  maxPromptChars?: number;
  contentBundle?: ModelContentBundle;
  systemPrompt?: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value);
}

function canonical(value: unknown) {
  const result = canonicalJsonStringify(value);
  if (typeof result !== "string") {
    fail("MODEL_RESPONSE_INVALID");
  }
  return result;
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function snapshotFingerprint(snapshot: AcquisitionPiModelSnapshot) {
  return canonical({
    jobId: snapshot.jobId,
    connectionId: snapshot.connectionId,
    credentialVersion: snapshot.credentialVersion,
    provider: snapshot.provider,
    model: snapshot.model,
    promptVersion: snapshot.promptVersion,
    schemaVersion: snapshot.schemaVersion,
    promptHash: snapshot.promptHash,
    schemaHash: snapshot.schemaHash,
    capabilitySnapshotHash: snapshot.capabilitySnapshotHash,
    baseUrlFingerprint: snapshot.baseUrlFingerprint
  });
}

function usage(result: ToolCallingResult) {
  return {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    reasoningTokens: result.usage.reasoningTokens
  };
}

export class ActiveModelGatewayAcquisitionPiRuntime
implements AcquisitionPiTurnRuntime {
  readonly #snapshotFingerprint: string;
  readonly #gateway: AcquisitionPiGatewayPort;
  readonly #maxPromptChars: number;
  readonly #systemPrompt: string;
  readonly #expectedBusinessTools: ToolDefinition[];
  readonly #legacyOutcomeAdapter: boolean;

  constructor(options: ActiveModelGatewayAcquisitionPiRuntimeOptions) {
    this.#snapshotFingerprint = snapshotFingerprint(options.snapshot);
    this.#gateway = options.gateway;
    this.#maxPromptChars = options.maxPromptChars ?? MAX_TURN_PROMPT_CHARS;
    this.#systemPrompt = options.systemPrompt?.trim()
      || DEFAULT_ACQUISITION_PI_SYSTEM_PROMPT;
    const contentBundle =
      options.contentBundle ?? ACQUISITION_MODEL_CONTENT_BUNDLE;
    const registered = contentBundle.toolSchemas[
      ACQUISITION_PI_TOOL_SCHEMA_ID
    ];
    if (!registered) fail("MODEL_CONTENT_HASH_MISMATCH");
    this.#expectedBusinessTools = registered
      .filter((tool) => tool.name !== ACQUISITION_FINAL_ANSWER_TOOL)
      .map((tool) => structuredClone(tool));
    this.#legacyOutcomeAdapter =
      this.#expectedBusinessTools.some((tool) => tool.name === "record_outcome")
      && !this.#expectedBusinessTools.some((tool) =>
        tool.name === "get_acquisition_performance");
    if (
      !Number.isInteger(this.#maxPromptChars)
      || this.#maxPromptChars < 1_000
    ) {
      throw new TypeError("maxPromptChars must be an integer >= 1000");
    }
  }

  async run(input: AcquisitionPiTurnInput): Promise<AcquisitionPiTurnResult> {
    if (snapshotFingerprint(input.snapshot) !== this.#snapshotFingerprint) {
      fail("MODEL_SNAPSHOT_MISMATCH");
    }
    assertNotAborted(input.signal);
    if (input.systemPrompt !== this.#systemPrompt) {
      fail("MODEL_CONTENT_HASH_MISMATCH");
    }

    const allowedNames = new Set<string>();
    const businessTools = input.tools.map(
      (tool) => {
        const name = String(tool.name ?? "").trim();
        if (
          !name
          || name === ACQUISITION_FINAL_ANSWER_TOOL
          || allowedNames.has(name)
        ) {
          fail("MODEL_TOOL_DEFINITION_INVALID");
        }
        allowedNames.add(name);
        return {
          name,
          description: String(tool.description ?? "").trim(),
          parameters: structuredClone(
            tool.parameters
          ) as Record<string, unknown>
        };
      }
    );

    const exactTools = canonical(businessTools)
      === canonical(this.#expectedBusinessTools);
    const quoteToolNames = new Set<string>(GROWTH_QUOTE_TOOL_NAMES);
    const legacyCompatible = this.#legacyOutcomeAdapter
      && canonical(businessTools.filter((tool) =>
        tool.name !== "get_acquisition_performance"
        && !quoteToolNames.has(tool.name)))
        === canonical(this.#expectedBusinessTools.filter((tool) =>
          tool.name !== "record_outcome"));
    if (!exactTools && !legacyCompatible) {
      fail("MODEL_TOOL_DEFINITION_INVALID");
    }
    const authorizedNames = legacyCompatible
      ? new Set(this.#expectedBusinessTools.map((tool) => tool.name))
      : allowedNames;
    const dynamicData = {
      immutableModelSnapshot: {
        jobId: input.snapshot.jobId,
        connectionId: input.snapshot.connectionId,
        credentialVersion: input.snapshot.credentialVersion,
        provider: input.snapshot.provider,
        model: input.snapshot.model,
        promptVersion: input.snapshot.promptVersion,
        schemaVersion: input.snapshot.schemaVersion,
        promptHash: input.snapshot.promptHash,
        schemaHash: input.snapshot.schemaHash,
        capabilitySnapshotHash: input.snapshot.capabilitySnapshotHash,
        baseUrlFingerprint: input.snapshot.baseUrlFingerprint
      },
      conversation: input.messages
    };
    if (canonical(dynamicData).length > this.#maxPromptChars) {
      fail("MODEL_CONTEXT_TOO_LARGE");
    }

    const result = await this.#gateway.callTools({
      contentBinding: {
        promptId: ACQUISITION_PI_PROMPT_ID,
        toolSchemaId: ACQUISITION_PI_TOOL_SCHEMA_ID,
        dynamicData
      },
      parallelToolCalls: false
    });
    assertNotAborted(input.signal);

    if (!result.toolCalls.length) {
      fail("MODEL_EMPTY_RESPONSE");
    }
    const legacyOutcomeCalls = result.toolCalls.filter((call) =>
      call.name === "record_outcome");
    if (legacyOutcomeCalls.length) {
      if (!this.#legacyOutcomeAdapter
        || legacyOutcomeCalls.length !== 1
        || result.toolCalls.length !== 1) {
        fail("MODEL_RESPONSE_INVALID");
      }
      return {
        type: "text",
        text: "此旧会话的结果写入工具已停用，当前会话保持只读。请新建获客会话以使用最新工具。",
        usage: usage(result),
        providerRequestId: result.providerRequestId
      };
    }
    const finalCalls = result.toolCalls.filter(
      (call) => call.name === ACQUISITION_FINAL_ANSWER_TOOL
    );
    if (finalCalls.length) {
      if (result.toolCalls.length !== 1 || finalCalls.length !== 1) {
        fail("MODEL_RESPONSE_INVALID");
      }
      const textValue = finalCalls[0]?.arguments.text;
      if (typeof textValue !== "string") {
        fail("MODEL_RESPONSE_INVALID");
      }
      const text = textValue.trim();
      if (!text || text.length > MAX_FINAL_ANSWER_CHARS) {
        fail("MODEL_RESPONSE_INVALID");
      }
      return {
        type: "text",
        text,
        usage: usage(result),
        providerRequestId: result.providerRequestId
      };
    }

    const ids = new Set<string>();
    const calls = result.toolCalls.map((call) => {
      const id = String(call.id ?? "").trim();
      if (
        !id
        || ids.has(id)
        || !authorizedNames.has(call.name)
        || !isRecord(call.arguments)
      ) {
        fail("MODEL_RESPONSE_INVALID");
      }
      ids.add(id);
      return {
        id,
        name: call.name,
        arguments: structuredClone(call.arguments)
      };
    });
    return {
      type: "tool_calls",
      calls,
      usage: usage(result),
      providerRequestId: result.providerRequestId
    };
  }
}
