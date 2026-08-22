import type { ModelDescriptor } from "../catalog.js";
import type { AiJobModelSnapshot } from "../types.js";

export interface OpenAiCompatibleUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface OpenAiCompatibleResult<T> {
  value: T;
  usage: OpenAiCompatibleUsage;
  providerRequestId: string | null;
}

export interface OpenAiCompatibleToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

export type OpenAiCompatibleStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "usage"; usage: OpenAiCompatibleUsage }
  | { type: "done" };

export interface OpenAiCompatibleStream {
  providerRequestId: string | null;
  events: AsyncIterable<OpenAiCompatibleStreamEvent>;
}

interface TimedOpenAiCompatibleResponse {
  readonly response: Response;
  readonly deadline: Promise<never>;
  release(): void;
}

export class OpenAiCompatibleRequestError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly providerRequestId: string | null,
    public readonly retryAfterMs: number | null,
    public readonly causeValue?: unknown
  ) {
    super("OpenAI-compatible provider request failed");
    this.name = "OpenAiCompatibleRequestError";
  }
}

export class OpenAiCompatibleResponseError extends Error {
  constructor(
    public readonly reason:
      | "empty_response"
      | "content_filtered"
      | "invalid_response"
  ) {
    super("OpenAI-compatible provider returned an unusable response");
    this.name = "OpenAiCompatibleResponseError";
  }
}

export interface OpenAiCompatibleAdapterOptions {
  baseUrl: string;
  fetch: typeof fetch;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
}

export interface OpenAiCompatibleAdapterRequest {
  credential: string;
  requestId: string;
}

export interface OpenAiCompatibleChatRequest
  extends OpenAiCompatibleAdapterRequest {
  snapshot: AiJobModelSnapshot;
  systemPrompt?: string;
  prompt: string;
  jsonMode?: boolean;
  signal?: AbortSignal;
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  toolChoice?: "auto" | "none" | "required";
  parallelToolCalls?: boolean;
}

function chatMessages(request: OpenAiCompatibleChatRequest) {
  return [
    ...(request.systemPrompt === undefined
      ? []
      : [{ role: "system", content: request.systemPrompt }]),
    { role: "user", content: request.prompt }
  ];
}

interface OpenAiUsagePayload {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  completion_tokens_details?: {
    reasoning_tokens?: unknown;
  };
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function usageFromPayload(value: unknown): OpenAiCompatibleUsage {
  const usage = value && typeof value === "object"
    ? value as OpenAiUsagePayload
    : {};
  return {
    inputTokens: nonNegativeInteger(usage.prompt_tokens),
    outputTokens: nonNegativeInteger(usage.completion_tokens),
    reasoningTokens: nonNegativeInteger(
      usage.completion_tokens_details?.reasoning_tokens
    )
  };
}

function providerRequestId(response: Response) {
  return response.headers.get("x-request-id")
    ?? response.headers.get("request-id");
}

function retryAfterMs(response: Response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - Date.now())
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Provider response must be an object");
  }
  return value as Record<string, unknown>;
}

export class OpenAiCompatibleAdapter {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #streamIdleTimeoutMs: number;

  constructor(options: OpenAiCompatibleAdapterOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 30_000;
  }

  async listModels(request: OpenAiCompatibleAdapterRequest) {
    const { response, value } = await this.#requestJson("/models", {
      method: "GET",
      credential: request.credential,
      requestId: request.requestId
    });
    const body = asRecord(value);
    if (!Array.isArray(body.data)) {
      throw new TypeError("Provider model list must contain data");
    }
    const models: ModelDescriptor[] = body.data.map((item) => {
      const model = asRecord(item);
      if (typeof model.id !== "string" || !model.id) {
        throw new TypeError("Provider model is missing its id");
      }
      return {
        id: model.id,
        displayName: model.id,
        ownedBy: typeof model.owned_by === "string" ? model.owned_by : null
      };
    });
    return {
      value: models,
      usage: usageFromPayload(body.usage),
      providerRequestId: providerRequestId(response)
    } satisfies OpenAiCompatibleResult<ModelDescriptor[]>;
  }

  async generateText(request: OpenAiCompatibleChatRequest) {
    const body = await this.#chat(request, false);
    const choice = this.#firstChoice(body.value);
    const message = asRecord(choice.message);
    if (choice.finish_reason !== "stop") {
      throw new OpenAiCompatibleResponseError(
        choice.finish_reason === "content_filter"
          ? "content_filtered"
          : "invalid_response"
      );
    }
    if ("tool_calls" in message
      && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0)) {
      throw new OpenAiCompatibleResponseError("invalid_response");
    }
    if ("function_call" in message && message.function_call != null) {
      throw new OpenAiCompatibleResponseError("invalid_response");
    }
    if (typeof message.content !== "string" || !message.content.trim()) {
      throw new OpenAiCompatibleResponseError("empty_response");
    }
    return {
      ...body,
      value: message.content
    };
  }

  async callTools(request: OpenAiCompatibleChatRequest) {
    const body = await this.#chat(request, false);
    const choice = this.#firstChoice(body.value);
    const message = asRecord(choice.message);
    if (!Array.isArray(message.tool_calls)) {
      throw new OpenAiCompatibleResponseError(
        choice.finish_reason === "content_filter"
          ? "content_filtered"
          : "empty_response"
      );
    }
    const toolCalls = message.tool_calls.map((value) => {
      const call = asRecord(value);
      const fn = asRecord(call.function);
      if (
        typeof call.id !== "string"
        || typeof fn.name !== "string"
        || typeof fn.arguments !== "string"
      ) {
        throw new TypeError("Provider tool call is malformed");
      }
      return {
        id: call.id,
        name: fn.name,
        argumentsText: fn.arguments
      };
    });
    return {
      ...body,
      value: toolCalls
    };
  }

  async streamText(
    request: OpenAiCompatibleChatRequest
  ): Promise<OpenAiCompatibleStream> {
    const pending = await this.#request("/chat/completions", {
      method: "POST",
      credential: request.credential,
      requestId: request.requestId,
      body: {
        model: request.snapshot.model,
        messages: chatMessages(request),
        stream: true,
        stream_options: { include_usage: true }
      }
    });
    const { response } = pending;
    pending.release();
    if (!response.body) {
      throw new OpenAiCompatibleResponseError("empty_response");
    }
    const requestId = providerRequestId(response);
    return {
      providerRequestId: requestId,
      events: this.#decodeEventStream(
        response.body,
        requestId,
        request.signal
      )
    };
  }

  async #chat(request: OpenAiCompatibleChatRequest, stream: boolean) {
    const body: Record<string, unknown> = {
      model: request.snapshot.model,
      messages: chatMessages(request),
      stream
    };
    if (request.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    if (request.tools) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
      body.tool_choice = request.toolChoice ?? "required";
      body.parallel_tool_calls = request.parallelToolCalls ?? false;
    }
    const { response, value } = await this.#requestJson("/chat/completions", {
      method: "POST",
      credential: request.credential,
      requestId: request.requestId,
      body
    });
    const responseBody = asRecord(value);
    return {
      value: responseBody,
      usage: usageFromPayload(responseBody.usage),
      providerRequestId: providerRequestId(response)
    } satisfies OpenAiCompatibleResult<Record<string, unknown>>;
  }

  #firstChoice(body: Record<string, unknown>) {
    if (!Array.isArray(body.choices) || !body.choices.length) {
      throw new TypeError("Provider response has no choices");
    }
    return asRecord(body.choices[0]);
  }

  async *#decodeEventStream(
    body: ReadableStream<Uint8Array>,
    requestId: string | null,
    signal?: AbortSignal
  ): AsyncIterable<OpenAiCompatibleStreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;
    try {
      while (true) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await this.#readWithIdleTimeout(reader, signal);
        } catch (error) {
          throw new OpenAiCompatibleRequestError(
            null,
            requestId,
            null,
            error
          );
        }
        if (read.done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(read.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          const event = this.#parseEventStreamLine(line);
          if (event) {
            yield event;
            if (event.type === "done") {
              completed = true;
              return;
            }
          }
          newline = buffer.indexOf("\n");
        }
      }
      if (buffer) {
        const event = this.#parseEventStreamLine(buffer.replace(/\r$/, ""));
        if (event) {
          yield event;
          if (event.type === "done") {
            completed = true;
            return;
          }
        }
      }
      completed = true;
      yield { type: "done" };
    } finally {
      if (!completed) {
        try {
          await reader.cancel();
        } catch {
          // The transport may already be aborted; there is nothing else to retain.
        }
      }
      reader.releaseLock();
    }
  }

  async #readWithIdleTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal?: AbortSignal
  ) {
    if (signal?.aborted) {
      throw new DOMException("Model stream aborted", "AbortError");
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new DOMException("Model stream idle timeout", "TimeoutError"));
      }, this.#streamIdleTimeoutMs);
    });
    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      onAbort = () => {
        reject(new DOMException("Model stream aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([
        reader.read(),
        timeoutPromise,
        abortPromise
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  #parseEventStreamLine(
    line: string
  ): OpenAiCompatibleStreamEvent | null {
    if (!line.startsWith("data:")) return null;
    const data = line.slice(5).trim();
    if (!data) return null;
    if (data === "[DONE]") return { type: "done" };
    let chunk: Record<string, unknown>;
    try {
      chunk = asRecord(JSON.parse(data));
    } catch {
      throw new OpenAiCompatibleResponseError("invalid_response");
    }
    if (chunk.usage) {
      return {
        type: "usage",
        usage: usageFromPayload(chunk.usage)
      };
    }
    if (!Array.isArray(chunk.choices) || !chunk.choices.length) return null;
    const choice = asRecord(chunk.choices[0]);
    const delta = asRecord(choice.delta);
    return typeof delta.content === "string" && delta.content
      ? { type: "text_delta", delta: delta.content }
      : null;
  }

  async #request(
    path: string,
    options: {
      method: "GET" | "POST";
      credential: string;
      requestId: string;
      body?: Record<string, unknown>;
    }
  ): Promise<TimedOpenAiCompatibleResponse> {
    let response: Response;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (timeout) clearTimeout(timeout);
    };
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new DOMException(
          "Model provider request timed out",
          "TimeoutError"
        );
        controller.abort(error);
        reject(error);
      }, this.#requestTimeoutMs);
    });
    try {
      response = await Promise.race([
        this.#fetch(`${this.#baseUrl}${path}`, {
          method: options.method,
          headers: {
            authorization: `Bearer ${options.credential}`,
            "content-type": "application/json",
            "x-client-request-id": options.requestId
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal
        }),
        deadline
      ]);
    } catch (error) {
      release();
      throw new OpenAiCompatibleRequestError(null, null, null, error);
    }
    if (!response.ok) {
      release();
      throw new OpenAiCompatibleRequestError(
        response.status,
        providerRequestId(response),
        retryAfterMs(response)
      );
    }
    return { response, deadline, release };
  }

  async #requestJson(
    path: string,
    options: {
      method: "GET" | "POST";
      credential: string;
      requestId: string;
      body?: Record<string, unknown>;
    }
  ) {
    const pending = await this.#request(path, options);
    try {
      return {
        response: pending.response,
        value: await Promise.race([
          pending.response.json(),
          pending.deadline
        ])
      };
    } catch (error) {
      const name = error && typeof error === "object" && "name" in error
        ? String(error.name)
        : "";
      if (name === "AbortError" || name === "TimeoutError") {
        throw new OpenAiCompatibleRequestError(
          null,
          providerRequestId(pending.response),
          null,
          error
        );
      }
      throw error;
    } finally {
      pending.release();
    }
  }
}
