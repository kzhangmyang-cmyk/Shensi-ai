import { createAiHttpClient } from "./ai-http-security.js";
import {
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import {
  buildFinancialCouncilModelContent,
  type FinancialCouncilModelContent
} from "./financial-council-model-content.js";
import {
  FinancialCouncilModelError
} from "./financial-council-model-port.js";
import type {
  FinancialCouncilAnalyzeInput,
  FinancialCouncilAnalyzeOutput,
  FinancialCfoNarrativeInput,
  FinancialCfoNarrativeOutput,
  FinancialCouncilModelFailureCode,
  FinancialCouncilModelPhase,
  FinancialCouncilModelPort,
  FinancialCouncilModelResult,
  FinancialCouncilRebutInput,
  FinancialCouncilRebutOutput
} from "./financial-council-model-port.js";
import {
  ModelGatewayError
} from "./model-providers/gateway.js";
import { hashModelCallValue } from "./model-providers/call-ledger.js";
import {
  bindActiveModelSnapshotDurably,
  createActiveModelGatewayForSnapshot
} from "./model-providers/runtime.js";
import type {
  DurableModelRuntimeStore
} from "./model-providers/runtime.js";
import type { StoredAiJobModelSnapshot } from "./model-providers/types.js";

const DEFAULT_SPECIALIST_TIMEOUT_MS = 60_000;

interface InFlightFinancialCouncilModelCall {
  readonly ownerId: string;
  readonly teamId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly role: FinancialCouncilAnalyzeInput["role"] | "cfo";
  readonly phase: FinancialCouncilModelPhase;
  readonly attempt: number;
  readonly contentHash: string;
  readonly promptHash: string;
  readonly schemaHash: string;
  readonly promise: Promise<FinancialCouncilModelResult<unknown>>;
}

const inFlightFinancialCouncilModelCalls = new WeakMap<
  DurableModelRuntimeStore,
  Map<string, InFlightFinancialCouncilModelCall>
>();

export interface FinancialCouncilModelGatewayOptions {
  readonly store: DurableModelRuntimeStore;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

function fail(
  code: FinancialCouncilModelFailureCode,
  retryable: boolean,
  retryAfterMs: number | null = null,
  cause?: unknown
): never {
  throw new FinancialCouncilModelError(
    code,
    retryable,
    retryAfterMs,
    cause === undefined ? undefined : { cause }
  );
}

function modelGatewayFailure(error: unknown): never {
  if (error instanceof FinancialCouncilModelError) throw error;
  if (!(error instanceof ModelGatewayError)) {
    return fail("financial_council_model_provider_failed", false, null, error);
  }
  switch (error.code) {
    case "MODEL_CREDENTIAL_UNAVAILABLE":
      return fail(
        "not_computable:model_credential_unavailable",
        false,
        null,
        error
      );
    case "MODEL_CAPABILITY_UNSUPPORTED":
      return fail(
        "not_computable:model_structured_output_unavailable",
        false,
        null,
        error
      );
    case "MODEL_TIMEOUT":
      return fail("financial_council_model_timeout", true, null, error);
    case "MODEL_RATE_LIMITED":
      return fail(
        "financial_council_model_rate_limited",
        true,
        error.retryAfterMs,
        error
      );
    case "MODEL_CONTENT_HASH_MISMATCH":
      return fail(
        "financial_council_model_snapshot_mismatch",
        false,
        null,
        error
      );
    case "MODEL_SCHEMA_INVALID":
    case "MODEL_RESPONSE_INVALID":
    case "MODEL_EMPTY_RESPONSE":
    case "MODEL_CONTENT_FILTERED":
      return fail(
        "financial_council_model_output_invalid",
        false,
        null,
        error
      );
    case "MODEL_AUTH_FAILED":
    case "MODEL_NOT_FOUND":
    case "MODEL_PROVIDER_UNAVAILABLE":
    case "MODEL_STREAM_ABORTED":
    case "MODEL_STREAM_CANCELLED":
      return fail(
        "financial_council_model_provider_failed",
        error.retryable,
        error.retryAfterMs,
        error
      );
  }
}

function exactSnapshot(
  snapshot: StoredAiJobModelSnapshot,
  input: FinancialCouncilAnalyzeInput | FinancialCouncilRebutInput
    | FinancialCfoNarrativeInput,
  phase: FinancialCouncilModelPhase,
  content: {
    jobId: string;
    promptVersion: string;
    schemaVersion: string;
    promptHash: string;
    schemaHash: string;
  }
) {
  const role = phase === "synthesize" ? "cfo"
    : (input as FinancialCouncilAnalyzeInput).role;
  return snapshot.jobId === content.jobId
    && snapshot.ownerId === input.ownerId
    && snapshot.teamId === input.teamId
    && snapshot.promptVersion === content.promptVersion
    && snapshot.schemaVersion === content.schemaVersion
    && snapshot.promptHash === content.promptHash
    && snapshot.schemaHash === content.schemaHash
    && content.jobId ===
      `financial-council:${input.runId}:${role}:${phase}:${input.attempt}`;
}

export class ActiveModelGatewayFinancialCouncilModelPort
implements FinancialCouncilModelPort {
  readonly #store: DurableModelRuntimeStore;
  readonly #fetch?: typeof fetch;
  readonly #requestTimeoutMs: number;

  constructor(options: FinancialCouncilModelGatewayOptions) {
    this.#store = options.store;
    this.#fetch = options.fetch;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_SPECIALIST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#requestTimeoutMs)
      || this.#requestTimeoutMs < 1
      || this.#requestTimeoutMs > DEFAULT_SPECIALIST_TIMEOUT_MS) {
      throw new TypeError(
        "requestTimeoutMs must be an integer between 1 and 60000"
      );
    }
  }

  analyze(
    input: FinancialCouncilAnalyzeInput
  ): Promise<FinancialCouncilModelResult<FinancialCouncilAnalyzeOutput>> {
    return this.#run("analyze", input);
  }

  rebut(
    input: FinancialCouncilRebutInput
  ): Promise<FinancialCouncilModelResult<FinancialCouncilRebutOutput>> {
    return this.#run("rebut", input);
  }

  async synthesize(
    input: FinancialCfoNarrativeInput
  ): Promise<FinancialCfoNarrativeOutput> {
    return (await this.#run("synthesize", input)).value;
  }

  async #run(
    phase: "analyze",
    input: FinancialCouncilAnalyzeInput
  ): Promise<FinancialCouncilModelResult<FinancialCouncilAnalyzeOutput>>;
  async #run(
    phase: "rebut",
    input: FinancialCouncilRebutInput
  ): Promise<FinancialCouncilModelResult<FinancialCouncilRebutOutput>>;
  async #run(
    phase: "synthesize",
    input: FinancialCfoNarrativeInput
  ): Promise<FinancialCouncilModelResult<FinancialCfoNarrativeOutput>>;
  async #run(
    phase: FinancialCouncilModelPhase,
    input: FinancialCouncilAnalyzeInput | FinancialCouncilRebutInput
      | FinancialCfoNarrativeInput
  ): Promise<FinancialCouncilModelResult<
    FinancialCouncilAnalyzeOutput | FinancialCouncilRebutOutput
    | FinancialCfoNarrativeOutput
  >> {
    if (phase === "analyze") {
      const analyzeInput = input as FinancialCouncilAnalyzeInput;
      const content = buildFinancialCouncilModelContent(
        "analyze", analyzeInput
      );
      return this.#singleFlight(phase, analyzeInput, content, () =>
        this.#execute(phase, analyzeInput, content));
    }
    if (phase === "rebut") {
      const rebutInput = input as FinancialCouncilRebutInput;
      const content = buildFinancialCouncilModelContent("rebut", rebutInput);
      return this.#singleFlight(phase, rebutInput, content, () =>
        this.#execute(phase, rebutInput, content));
    }
    const cfoInput = input as FinancialCfoNarrativeInput;
    const content = buildFinancialCouncilModelContent("synthesize", cfoInput);
    return this.#singleFlight(phase, cfoInput, content, () =>
      this.#execute(phase, cfoInput, content));
  }

  #singleFlight<Value>(
    phase: FinancialCouncilModelPhase,
    input: FinancialCouncilAnalyzeInput | FinancialCouncilRebutInput
      | FinancialCfoNarrativeInput,
    content: FinancialCouncilModelContent<Value>,
    execute: () => Promise<FinancialCouncilModelResult<Value>>
  ): Promise<FinancialCouncilModelResult<Value>> {
    let calls = inFlightFinancialCouncilModelCalls.get(this.#store);
    if (!calls) {
      calls = new Map();
      inFlightFinancialCouncilModelCalls.set(this.#store, calls);
    }
    const existing = calls.get(content.jobId);
    if (existing) {
      if (existing.ownerId !== input.ownerId
        || existing.teamId !== input.teamId
        || existing.runId !== input.runId
        || existing.snapshotId !== input.snapshotId
        || existing.snapshotHash !== input.snapshotHash
        || existing.role !== (phase === "synthesize" ? "cfo"
          : (input as FinancialCouncilAnalyzeInput).role)
        || existing.phase !== phase
        || existing.attempt !== input.attempt
        || existing.contentHash !== content.contentHash
        || existing.promptHash !== content.promptHash
        || existing.schemaHash !== content.schemaHash) {
        return Promise.reject(new FinancialCouncilModelError(
          "financial_council_model_snapshot_mismatch",
          false
        ));
      }
      return existing.promise as Promise<FinancialCouncilModelResult<Value>>;
    }
    const raw = execute();
    let entry!: InFlightFinancialCouncilModelCall;
    const tracked = raw.then(
      (value) => {
        this.#finishSingleFlight(content.jobId, entry);
        return value;
      },
      (error: unknown) => {
        this.#finishSingleFlight(content.jobId, entry);
        throw error;
      }
    );
    entry = Object.freeze({
      ownerId: input.ownerId,
      teamId: input.teamId,
      runId: input.runId,
      snapshotId: input.snapshotId,
      snapshotHash: input.snapshotHash,
      role: phase === "synthesize" ? "cfo"
        : (input as FinancialCouncilAnalyzeInput).role,
      phase,
      attempt: input.attempt,
      contentHash: content.contentHash,
      promptHash: content.promptHash,
      schemaHash: content.schemaHash,
      promise: tracked as Promise<FinancialCouncilModelResult<unknown>>
    });
    calls.set(content.jobId, entry);
    return tracked;
  }

  #finishSingleFlight(
    jobId: string,
    entry: InFlightFinancialCouncilModelCall
  ) {
    const calls = inFlightFinancialCouncilModelCalls.get(this.#store);
    if (calls?.get(jobId) !== entry) return;
    calls.delete(jobId);
    if (!calls.size) inFlightFinancialCouncilModelCalls.delete(this.#store);
  }

  async #execute<Value>(
    phase: FinancialCouncilModelPhase,
    input: FinancialCouncilAnalyzeInput | FinancialCouncilRebutInput
      | FinancialCfoNarrativeInput,
    content: FinancialCouncilModelContent<Value>
  ): Promise<FinancialCouncilModelResult<Value>> {
    let snapshot: StoredAiJobModelSnapshot;
    try {
      snapshot = await bindActiveModelSnapshotDurably(this.#store, {
        jobId: content.jobId,
        ownerId: input.ownerId,
        teamId: input.teamId,
        promptVersion: content.promptVersion,
        schemaVersion: content.schemaVersion,
        promptHash: content.promptHash,
        schemaHash: content.schemaHash
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/immutable identity mismatch/iu.test(message)) {
        return fail(
          "financial_council_model_snapshot_mismatch",
          false,
          null,
          error
        );
      }
      if (/No active official model connection/iu.test(message)) {
        return fail(
          "not_computable:model_connection_unavailable",
          false,
          null,
          error
        );
      }
      return fail(
        "financial_council_model_snapshot_persistence_failed",
        true,
        null,
        error
      );
    }
    if (!exactSnapshot(snapshot, input, phase, content)) {
      return fail("financial_council_model_snapshot_mismatch", false);
    }

    const fetcher = this.#fetch ?? this.#secureFetch(snapshot);
    const gateway = createActiveModelGatewayForSnapshot(this.#store, {
      storedSnapshot: snapshot,
      fetch: fetcher,
      requestTimeoutMs: this.#requestTimeoutMs
    });
    let generated: Awaited<ReturnType<typeof gateway.generateStructured>>
      | undefined;
    let providerError: unknown;
    try {
      generated = await gateway.generateStructured({
        systemPrompt: content.systemPrompt,
        prompt: content.userPrompt,
        schemaHash: content.schemaHash,
        schema: content.schema
      });
    } catch (error) {
      providerError = error;
    }

    try {
      await this.#store.persist();
    } catch (error) {
      return fail(
        "financial_council_model_ledger_persistence_failed",
        true,
        null,
        providerError === undefined
          ? error
          : new AggregateError([providerError, error])
      );
    }
    if (providerError !== undefined) return modelGatewayFailure(providerError);
    if (!generated) {
      return fail("financial_council_model_output_invalid", false);
    }

    const value = immutableFinancialCouncilValue(generated.value) as Value;
    return Object.freeze({
      value,
      binding: Object.freeze({
        jobId: content.jobId,
        runId: input.runId,
        snapshotId: input.snapshotId,
        snapshotHash: input.snapshotHash,
        role: phase === "synthesize" ? "cfo"
          : (input as FinancialCouncilAnalyzeInput).role,
        phase,
        attempt: input.attempt,
        connectionId: snapshot.connectionId,
        credentialVersion: snapshot.credentialVersion,
        provider: snapshot.provider,
        model: snapshot.model,
        capabilitySnapshotHash: hashModelCallValue(
          JSON.stringify(snapshot.capabilitySnapshot)
        ) as `sha256:${string}`,
        baseUrlFingerprint: snapshot.baseUrlFingerprint,
        promptVersion: content.promptVersion,
        schemaVersion: content.schemaVersion,
        contentHash: content.contentHash,
        promptHash: content.promptHash,
        schemaHash: content.schemaHash
      }),
      repaired: generated.repaired,
      providerRequestId: generated.providerRequestId
    });
  }

  #secureFetch(snapshot: StoredAiJobModelSnapshot): typeof fetch {
    const client = createAiHttpClient(snapshot.baseUrl);
    return ((input: string | URL | Request, init?: RequestInit) =>
      client.fetch(String(input), init)) as typeof fetch;
  }
}
