import type { components } from "../generated/ai-acquisition.js";
import * as protocol from "./desktop-central-protocol.ts";
import { actionWireRequest } from "./sidecar-outreach-protocol.ts";

type Schemas = components["schemas"];
export type RegisterInstallationInput = Schemas["DesktopRegistrationRequest"];
export type RegisteredDevice = Schemas["DesktopRegistrationResponse"];
export type ClaimRequest = Schemas["DesktopOutreachClaimRequest"];
export type ClaimResponse = Schemas["DesktopOutreachClaimResponse"];
export type CompletionRequest = Schemas["DesktopOutreachCompleteRequest"];
export type CompletionResponse = Schemas["DesktopOutreachCompletionResponse"];
export type ReconcileRequest = Schemas["DesktopOutreachReconcileRequest"];
export type ReconcileResponse = Schemas["DesktopOutreachReconcileResponse"];
export interface DeviceContext { installationId: string; deviceToken: string; workspaceId: string }
export interface CentralRequestOptions { idempotencyKey: string; signal?: AbortSignal }
export interface RegistrationOptions extends CentralRequestOptions { expectedWorkspaceId: string }
export interface CompletionOptions extends CentralRequestOptions { taskToken: string }
export class CentralRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = "CentralRequestError"; }
}
const RESPONSE_LIMIT = 65_536;

/** Main owns the origin/build identity. No method accepts URLs or arbitrary headers. */
export class DesktopCentralApiClient {
  readonly #origin: string;
  readonly #build: string;
  readonly #fetch: typeof fetch;
  constructor(options: { origin: string; buildManifestSha256: string; fetchImpl?: typeof fetch }) {
    try {
      const url = new URL(options.origin);
      if (url.origin !== options.origin || url.username || url.password
        || url.pathname !== "/" || url.search || url.hash
        || !(url.protocol === "https:" || (url.protocol === "http:"
          && url.hostname === "127.0.0.1" && url.port))) throw new Error();
      protocol.bareHash(options.buildManifestSha256);
    } catch { throw new Error("central_configuration_invalid"); }
    this.#origin = options.origin;
    this.#build = options.buildManifestSha256;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async register(input: RegisterInstallationInput, options: RegistrationOptions): Promise<RegisteredDevice> {
    try {
      protocol.registrationRequest(input);
      protocol.object(options, { idempotencyKey, expectedWorkspaceId: protocol.safeId }, { signal });
    } catch { throw new Error("central_request_invalid"); }
    const expectedWorkspaceId = options.expectedWorkspaceId;
    const value = await this.#request("/desktop-installations/register", input, options, {}, [200, 201]);
    try {
      protocol.registrationResponse(value);
      if (value.workspaceId !== expectedWorkspaceId) throw new Error();
      return value;
    } catch { throw new Error("central_response_invalid"); }
  }

  async claim(context: DeviceContext, input: ClaimRequest, options: CentralRequestOptions): Promise<ClaimResponse> {
    let headers: Record<string, string>;
    try {
      headers = deviceHeaders(context); requestOptions(options); protocol.claimRequest(input);
      input = structuredClone(input);
    } catch { throw new Error("central_request_invalid"); }
    const workspaceId = context.workspaceId;
    const value = await this.#request("/desktop-outreach-actions/claim", input, options, headers);
    try {
      protocol.claimResponse(value);
      if (value.kind === "claimed" || value.kind === "reconcile") {
        const task = value.task;
        // Validate the same frozen target/semantic hash before exposing a task
        // to a caller that may next authorize central "started".
        actionWireRequest(task);
        if (task.workspaceId !== workspaceId || !input.availableAccounts.some((account) =>
          account.accountId === task.accountId && account.accountHandle === task.accountHandle
          && account.loginStateVersion === (value.kind === "reconcile"
            ? value.task.observationLoginStateVersion ?? task.loginStateVersion : task.loginStateVersion)
          && account.bindingGeneration === task.executorBindingGeneration)) protocol.invalid();
      }
      return value;
    } catch { throw new Error("central_response_invalid"); }
  }

  async complete(context: DeviceContext, actionId: string, input: CompletionRequest,
    options: CompletionOptions): Promise<CompletionResponse> {
    let headers: Record<string, string>;
    try {
      headers = deviceHeaders(context); pathIdentifier(actionId); protocol.completeRequest(input);
      protocol.object(options, { idempotencyKey, taskToken: protocol.token }, { signal });
      headers["X-Shensi-Desktop-Task-Token"] = options.taskToken;
      if (input.command.event === "receipt" && input.command.receipt.actionId !== actionId) protocol.invalid();
    } catch { throw new Error("central_request_invalid"); }
    const value = await this.#request(`/desktop-outreach-actions/${encodeURIComponent(actionId)}/complete`, input, options, headers);
    try {
      protocol.completionResponse(value);
      if (value.actionId !== actionId) protocol.invalid();
      return value;
    } catch { throw new Error("central_response_invalid"); }
  }

  async reconcile(context: DeviceContext, actionId: string, input: ReconcileRequest,
    options: CentralRequestOptions): Promise<ReconcileResponse> {
    let headers: Record<string, string>;
    try {
      headers = deviceHeaders(context); requestOptions(options); pathIdentifier(actionId);
      protocol.reconcileRequest(input); input = structuredClone(input);
    } catch { throw new Error("central_request_invalid"); }
    const workspaceId = context.workspaceId;
    const value = await this.#request(`/desktop-outreach-actions/${encodeURIComponent(actionId)}/reconcile`, input, options, headers);
    try {
      protocol.reconcileResponse(value);
      if (value.kind === "released" && (input.journalPhase !== "claimed"
        || value.actionId !== actionId || value.taskRequestHash !== input.taskRequestHash
        || value.originalLeaseVersion !== input.originalLeaseVersion)) protocol.invalid();
      if (value.kind === "reconcile") {
        const task = value.task;
        actionWireRequest(task);
        if (task.workspaceId !== workspaceId || task.actionId !== actionId
          || task.accountId !== input.accountId || task.accountHandle !== input.accountHandle
          || task.loginStateVersion !== input.loginStateVersion
          || task.executorBindingGeneration !== input.bindingGeneration
          || task.originalLeaseVersion !== input.originalLeaseVersion
          || task.taskRequestHash !== input.taskRequestHash) protocol.invalid();
      }
      return value;
    } catch { throw new Error("central_response_invalid"); }
  }

  async #request(path: string, input: object, options: CentralRequestOptions,
    authority: Record<string, string>, success: number[] = [200]): Promise<unknown> {
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body, "utf8") > RESPONSE_LIMIT) throw new CentralRequestError(0, "central_request_too_large");
    if (options.signal?.aborted) throw new CentralRequestError(0, "central_cancelled");
    const externalSignal = options.signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 10_000);
    try {
      let response: Response;
      try {
        response = await abortable(this.#fetch(`${this.#origin}/api/v1/acquisition${path}`, {
          method: "POST", redirect: "manual", credentials: "omit", signal: controller.signal,
          headers: { accept: "application/json", "content-type": "application/json", ...authority,
            "Idempotency-Key": options.idempotencyKey,
            "X-Shensi-Desktop-Build-Manifest-SHA256": this.#build }, body
        }), controller.signal);
      } catch { throw new CentralRequestError(0, "central_unreachable"); }
      if (response.type === "opaqueredirect" || response.redirected || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => undefined);
        throw new CentralRequestError(response.status, "central_redirect_rejected");
      }
      const responseBody = await readBounded(response, controller.signal);
      if (!response.ok) {
        let code = `central_http_${response.status}`;
        if (response.status === 503
          && response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json") {
          try {
            // Preserve only this contracted gate code, never arbitrary error
            // text that could include credentials or platform content.
            if (JSON.parse(responseBody)?.error === "desktop_execution_disabled") code = "desktop_execution_disabled";
          } catch { /* An unrecognized body keeps the redacted HTTP code. */ }
        }
        throw new CentralRequestError(response.status, code);
      }
      if (!success.includes(response.status)
        || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        throw new CentralRequestError(response.status, "central_response_invalid");
      }
      try { return JSON.parse(responseBody); }
      catch { throw new CentralRequestError(response.status, "central_response_invalid"); }
    } catch (error) {
      if (controller.signal.aborted) throw new CentralRequestError(0, externalSignal?.aborted ? "central_cancelled" : "central_timeout");
      if (error instanceof CentralRequestError) throw error;
      throw new CentralRequestError(0, "central_response_invalid");
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abort);
    }
  }
}

function idempotencyKey(value: unknown) {
  if (typeof value !== "string" || value !== value.trim()
    || !/^[^\u0000-\u001f\u007f,]{8,200}$/u.test(value)) protocol.invalid();
}
function signal(value: unknown) { if (value !== undefined && !(value instanceof AbortSignal)) protocol.invalid(); }
function requestOptions(value: unknown) { protocol.object(value, { idempotencyKey }, { signal }); }
function pathIdentifier(value: string) {
  protocol.safeId(value);
  if (value === "." || value === ".." || /[/\\]/u.test(value)) protocol.invalid();
}
function deviceHeaders(value: DeviceContext): Record<string, string> {
  protocol.object(value, { installationId: protocol.token, deviceToken: protocol.token, workspaceId: protocol.safeId });
  return { "X-Shensi-Desktop-Installation-Id": value.installationId, "X-Shensi-Desktop-Device-Token": value.deviceToken };
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) throw new CentralRequestError(response.status, "central_response_too_large");
      parts.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
  } catch (error) {
    if (error instanceof CentralRequestError) throw error;
    throw new CentralRequestError(response.status, "central_response_invalid");
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("central_aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
