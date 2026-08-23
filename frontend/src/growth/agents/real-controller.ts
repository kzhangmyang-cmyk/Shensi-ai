import type {
  FinancialCouncilAgentCenterView,
  FinancialCouncilModelRoutePreview,
  FinancialCouncilModelRoutingPolicyInput,
  FinancialCouncilModelRoutingPolicyVersion,
  FinancialCouncilRun,
  FinancialCouncilRunAgentsView,
  FinancialStatementKind,
  FinancialStatementPackagePreview,
  FinancialStatementPackagePreviewInput,
  FinancialStatementPackageView,
  FinancialStatementUpload
} from "../contracts";
import { GrowthApiError } from "../http";
import type { RealAgentCenterApi } from "./real-api";
import { RealAgentCenterApiValidationError } from "./real-api";

const STATEMENT_KINDS = [
  "balance_sheet", "income_statement", "cash_flow_statement"
] as const satisfies readonly FinancialStatementKind[];
const MODEL_ROLES = [
  "cfo", "finance", "profit", "cost", "cashflow", "tax"
] as const;
const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface SelectedFileMeta {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly sha256: `sha256:${string}`;
}

export type RealAgentCenterBusy =
  | "loading"
  | "previewing_statements"
  | "committing_statements"
  | "creating_run"
  | "updating_routing"
  | null;

export interface RealAgentCenterControllerState {
  readonly readiness: FinancialCouncilAgentCenterView | null;
  readonly routingPolicy: FinancialCouncilModelRoutingPolicyVersion | null;
  readonly routingPreview: readonly FinancialCouncilModelRoutePreview[];
  readonly files: Readonly<Record<FinancialStatementKind, SelectedFileMeta | null>>;
  readonly statementPreview: FinancialStatementPackagePreview | null;
  readonly statementPackage: FinancialStatementPackageView | null;
  readonly latestRun: FinancialCouncilRun | null;
  readonly runAgents: FinancialCouncilRunAgentsView | null;
  readonly consentAccepted: boolean;
  readonly busy: RealAgentCenterBusy;
  readonly error: string | null;
}

export interface RealAgentCenterControllerOptions {
  readonly api: RealAgentCenterApi;
  readonly idFactory?: () => string;
  readonly digestSha256?: (bytes: ArrayBuffer) => Promise<`sha256:${string}`>;
}

export interface RealAgentCenterController {
  getState(): RealAgentCenterControllerState;
  subscribe(listener: (state: RealAgentCenterControllerState) => void): () => void;
  selectStatement(kind: FinancialStatementKind, file: File): Promise<void>;
  previewStatements(): Promise<void>;
  acceptModelDataNotice(accepted: boolean): void;
  commitStatements(): Promise<void>;
  startCouncil(): Promise<void>;
  updateRouting(input: FinancialCouncilModelRoutingPolicyInput): Promise<void>;
  close(): void;
  destroy(): void;
}

interface PrivateFile {
  readonly file: File;
  readonly meta: SelectedFileMeta;
  readonly revision: number;
}

interface ActiveOperation {
  readonly token: number;
  readonly semantic: string;
  readonly abort: AbortController;
}

function emptyFiles(): Readonly<Record<FinancialStatementKind, null>> {
  return Object.freeze({
    balance_sheet: null,
    income_statement: null,
    cash_flow_statement: null
  });
}

function initialState(): RealAgentCenterControllerState {
  return Object.freeze({
    readiness: null,
    routingPolicy: null,
    routingPreview: Object.freeze([]),
    files: emptyFiles(),
    statementPreview: null,
    statementPackage: null,
    latestRun: null,
    runAgents: null,
    consentAccepted: false,
    busy: null,
    error: null
  });
}

function stableValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${stableValue(row[key])}`).join(",")}}`;
}

async function browserSha256(bytes: ArrayBuffer): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function safeError(error: unknown): string {
  if (error instanceof GrowthApiError || error instanceof RealAgentCenterApiValidationError) {
    return error.code;
  }
  return "financial_council_request_failed";
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (error instanceof DOMException && error.name === "AbortError");
}

export function createRealAgentCenterController(
  options: RealAgentCenterControllerOptions
): RealAgentCenterController {
  const idFactory = options.idFactory
    ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const digestSha256 = options.digestSha256 ?? browserSha256;
  const listeners = new Set<(state: RealAgentCenterControllerState) => void>();
  const semanticKeys = new Map<string, string>();
  const inFlight = new Map<string, Promise<void>>();
  const active = new Map<string, ActiveOperation>();
  const operationTokens = new Map<string, number>();
  const commandAborts = new Set<AbortController>();
  const sensitiveBuffers = new Set<{
    value: ArrayBuffer | ArrayBuffer[] | null;
  }>();
  const sensitiveUploads = new Set<{
    value: FinancialStatementUpload[] | null;
  }>();
  const selected: Record<FinancialStatementKind, PrivateFile | null> = {
    balance_sheet: null,
    income_statement: null,
    cash_flow_statement: null
  };
  const selectionRevisions: Record<FinancialStatementKind, number> = {
    balance_sheet: 0,
    income_statement: 0,
    cash_flow_statement: 0
  };
  let state = initialState();
  let generation = 0;
  let destroyed = false;
  let routingEtag: string | null = null;
  let councilPolicyVersionId: string | null = null;

  function publish(next: Partial<RealAgentCenterControllerState>): void {
    if (destroyed) return;
    state = Object.freeze({ ...state, ...next });
    for (const listener of listeners) listener(state);
  }

  function publicFiles(): RealAgentCenterControllerState["files"] {
    return Object.freeze(Object.fromEntries(STATEMENT_KINDS.map((kind) =>
      [kind, selected[kind]?.meta ?? null])) as Record<
        FinancialStatementKind, SelectedFileMeta | null
      >);
  }

  function clearPrivateFiles(): void {
    for (const kind of STATEMENT_KINDS) selected[kind] = null;
  }

  function releaseSensitiveReferences(): void {
    for (const holder of sensitiveBuffers) holder.value = null;
    for (const holder of sensitiveUploads) holder.value = null;
    sensitiveBuffers.clear();
    sensitiveUploads.clear();
  }

  function nextToken(kind: string): number {
    const token = (operationTokens.get(kind) ?? 0) + 1;
    operationTokens.set(kind, token);
    return token;
  }

  function abortKind(kind: string): void {
    const operation = active.get(kind);
    operation?.abort.abort();
    active.delete(kind);
    nextToken(kind);
  }

  function invalidateDownstreamFromFiles(): void {
    for (const kind of ["preview", "commit", "create"]) abortKind(kind);
    publish({
      statementPreview: null,
      statementPackage: null,
      latestRun: null,
      runAgents: null,
      consentAccepted: false,
      busy: null,
      error: null
    });
  }

  function stillCurrent(
    expectedGeneration: number,
    kind?: string,
    token?: number
  ): boolean {
    return !destroyed && generation === expectedGeneration
      && (kind === undefined || operationTokens.get(kind) === token);
  }

  function keyFor(kind: string, semanticValue: unknown): [string, () => void] {
    const semantic = `${kind}:${stableValue(semanticValue)}`;
    let key = semanticKeys.get(semantic);
    if (!key) {
      key = `real-council-${kind}:${idFactory()}`;
      semanticKeys.set(semantic, key);
    }
    return [key, () => semanticKeys.delete(semantic)];
  }

  function runOperation(
    kind: string,
    semanticValue: unknown,
    execute: (
      expectedGeneration: number,
      token: number,
      signal: AbortSignal
    ) => Promise<void>
  ): Promise<void> {
    if (destroyed) return Promise.resolve();
    const semantic = stableValue(semanticValue);
    const flightKey = `${kind}:${semantic}`;
    const joined = inFlight.get(flightKey);
    if (joined) return joined;
    const existing = active.get(kind);
    if (existing && existing.semantic !== semantic) existing.abort.abort();
    const expectedGeneration = generation;
    const token = nextToken(kind);
    const abort = new AbortController();
    const operation = { token, semantic, abort };
    active.set(kind, operation);
    commandAborts.add(abort);
    const promise = execute(expectedGeneration, token, abort.signal)
      .finally(() => {
        commandAborts.delete(abort);
        if (active.get(kind) === operation) active.delete(kind);
        if (inFlight.get(flightKey) === promise) inFlight.delete(flightKey);
      });
    inFlight.set(flightKey, promise);
    return promise;
  }

  function fileAuthority(
    snapshot: readonly PrivateFile[]
  ): boolean {
    return snapshot.every((entry, index) => {
      const kind = STATEMENT_KINDS[index];
      return selected[kind] === entry
        && selectionRevisions[kind] === entry.revision;
    });
  }

  function routingInputEligible(
    input: FinancialCouncilModelRoutingPolicyInput
  ): boolean {
    const previews = new Map(state.routingPreview.map((item) => [item.role, item]));
    return MODEL_ROLES.every((role) => {
      const route = input.roles[role];
      if (route.mode !== "pinned") return true;
      const preview = previews.get(role);
      if (!preview || route.primaryConnectionId === null
        || preview.missingCapabilities.length > 0) return false;
      const eligible = new Set(preview.orderedConnections.map((item) => item.connectionId));
      return eligible.has(route.primaryConnectionId)
        && route.fallbackConnectionIds.every((id) => eligible.has(id));
    });
  }

  function canonicalRoutingInput(
    input: FinancialCouncilModelRoutingPolicyInput
  ): FinancialCouncilModelRoutingPolicyInput {
    return {
      maxRoleBudgetMinor: input.maxRoleBudgetMinor,
      maxRunBudgetMinor: input.maxRunBudgetMinor,
      requestTimeoutMs: input.requestTimeoutMs,
      roles: Object.fromEntries(MODEL_ROLES.map((role) => {
        const route = input.roles[role];
        return [role, {
          mode: route.mode,
          primaryConnectionId: route.primaryConnectionId,
          fallbackConnectionIds: [...route.fallbackConnectionIds],
          preferenceWeightBps: route.preferenceWeightBps
        }];
      })) as FinancialCouncilModelRoutingPolicyInput["roles"]
    };
  }

  async function load(): Promise<void> {
    const semantic = { kind: "initial-projections" };
    await runOperation("load", semantic, async (expected, token, signal) => {
      const [routingKey, clearRoutingKey] = keyFor("routing-preview", {});
      publish({ busy: "loading", error: null });
      try {
        const [readiness, councilPolicy, policy, preview] = await Promise.all([
          options.api.getAgentCenter(signal),
          options.api.getCouncilPolicy(signal),
          options.api.getRoutingPolicy(signal),
          options.api.previewRouting(routingKey, signal)
        ]);
        if (!stillCurrent(expected, "load", token)) return;
        clearRoutingKey();
        councilPolicyVersionId = councilPolicy.body.policyVersionId;
        routingEtag = policy.etag;
        publish({
          readiness: readiness.body,
          routingPolicy: policy.body,
          routingPreview: Object.freeze([...preview.body]),
          busy: null,
          error: null
        });
      } catch (error) {
        if (!stillCurrent(expected, "load", token) || isAbort(error, signal)) return;
        publish({ busy: null, error: safeError(error) });
      }
    });
  }

  function shutdown(clearListeners: boolean): void {
    generation += 1;
    for (const abort of commandAborts) abort.abort();
    commandAborts.clear();
    active.clear();
    inFlight.clear();
    operationTokens.clear();
    semanticKeys.clear();
    routingEtag = null;
    councilPolicyVersionId = null;
    clearPrivateFiles();
    releaseSensitiveReferences();
    for (const kind of STATEMENT_KINDS) selectionRevisions[kind] += 1;
    state = initialState();
    if (clearListeners) listeners.clear();
    else for (const listener of listeners) listener(state);
  }

  const controller: RealAgentCenterController = {
    getState() { return state; },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async selectStatement(kind, file) {
      if (destroyed || !STATEMENT_KINDS.includes(kind)) return;
      const expected = generation;
      const revision = ++selectionRevisions[kind];
      selected[kind] = null;
      invalidateDownstreamFromFiles();
      publish({ files: publicFiles() });
      const holder: { value: ArrayBuffer | null } = { value: null };
      sensitiveBuffers.add(holder);
      try {
        holder.value = await file.arrayBuffer();
        if (!stillCurrent(expected) || selectionRevisions[kind] !== revision) return;
        const sha256 = await digestSha256(holder.value);
        holder.value = null;
        if (!stillCurrent(expected) || selectionRevisions[kind] !== revision) return;
        const meta = Object.freeze({
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          sha256
        });
        selected[kind] = Object.freeze({ file, meta, revision });
        publish({ files: publicFiles(), error: null });
      } catch (error) {
        if (!stillCurrent(expected) || selectionRevisions[kind] !== revision) return;
        publish({ error: "financial_statement_file_read_failed" });
      } finally {
        holder.value = null;
        sensitiveBuffers.delete(holder);
      }
    },
    previewStatements() {
      const snapshot = STATEMENT_KINDS.map((kind) => selected[kind]);
      if (snapshot.some((entry) => entry === null)) {
        publish({ error: "financial_statement_files_required" });
        return Promise.resolve();
      }
      const files = snapshot as PrivateFile[];
      const semantic = files.map((entry, index) => ({
        kind: STATEMENT_KINDS[index],
        name: entry.meta.name,
        size: entry.meta.size,
        lastModified: entry.meta.lastModified,
        sha256: entry.meta.sha256
      }));
      return runOperation("preview", semantic, async (expected, token, signal) => {
        const [idempotencyKey, clearKey] = keyFor("statement-preview", semantic);
        publish({ busy: "previewing_statements", error: null });
        const bufferHolder: { value: ArrayBuffer[] | null } = { value: null };
        const uploadHolder: { value: FinancialStatementUpload[] | null } = {
          value: null
        };
        sensitiveBuffers.add(bufferHolder);
        sensitiveUploads.add(uploadHolder);
        try {
          bufferHolder.value = await Promise.all(
            files.map((entry) => entry.file.arrayBuffer())
          );
          if (!stillCurrent(expected, "preview", token) || !fileAuthority(files)) return;
          uploadHolder.value = bufferHolder.value.map((bytes, index) => ({
            kind: STATEMENT_KINDS[index],
            fileName: files[index].meta.name,
            mediaType: XLSX_MEDIA_TYPE,
            contentBase64: base64(bytes)
          }));
          bufferHolder.value = null;
          const input = {
            statements: uploadHolder.value
          } as FinancialStatementPackagePreviewInput;
          const response = await options.api.previewStatements(
            input, idempotencyKey, signal
          );
          uploadHolder.value = null;
          if (!stillCurrent(expected, "preview", token) || !fileAuthority(files)) return;
          clearKey();
          publish({
            statementPreview: response.body,
            statementPackage: null,
            latestRun: null,
            runAgents: null,
            consentAccepted: false,
            busy: null,
            error: null
          });
        } catch (error) {
          if (!stillCurrent(expected, "preview", token) || isAbort(error, signal)) return;
          publish({ busy: null, statementPackage: null, error: safeError(error) });
        } finally {
          bufferHolder.value = null;
          uploadHolder.value = null;
          sensitiveBuffers.delete(bufferHolder);
          sensitiveUploads.delete(uploadHolder);
        }
      });
    },
    acceptModelDataNotice(accepted) {
      if (destroyed) return;
      publish({ consentAccepted: accepted, error: null });
    },
    commitStatements() {
      const preview = state.statementPreview;
      if (!preview) {
        publish({ error: "financial_statement_preview_required" });
        return Promise.resolve();
      }
      if (!state.consentAccepted) {
        publish({ error: "financial_model_data_consent_required" });
        return Promise.resolve();
      }
      const semantic = {
        previewId: preview.previewId,
        noticeVersion: "financial-model-data.v1"
      };
      return runOperation("commit", semantic, async (expected, token, signal) => {
        const [idempotencyKey, clearKey] = keyFor("statement-commit", semantic);
        publish({ busy: "committing_statements", error: null });
        try {
          const response = await options.api.commitStatements(
            preview.previewId,
            { consent: { accepted: true, noticeVersion: "financial-model-data.v1" } },
            idempotencyKey,
            signal
          );
          if (!stillCurrent(expected, "commit", token)
            || state.statementPreview?.previewId !== preview.previewId
            || !state.consentAccepted) return;
          clearKey();
          clearPrivateFiles();
          publish({
            statementPackage: response.body,
            busy: null,
            error: null
          });
        } catch (error) {
          if (!stillCurrent(expected, "commit", token) || isAbort(error, signal)) return;
          publish({ busy: null, error: safeError(error) });
        }
      });
    },
    startCouncil() {
      const statementPackage = state.statementPackage;
      const formulaPolicyVersionId = councilPolicyVersionId;
      if (!statementPackage || !formulaPolicyVersionId) {
        publish({ error: "financial_council_run_prerequisites_missing" });
        return Promise.resolve();
      }
      if (!state.readiness?.capabilities.canRun) {
        publish({ error: "financial_council_run_forbidden" });
        return Promise.resolve();
      }
      const semantic = {
        statementPackageId: statementPackage.packageId,
        policyVersionId: formulaPolicyVersionId
      };
      return runOperation("create", semantic, async (expected, token, signal) => {
        const [idempotencyKey, clearKey] = keyFor("run-create", semantic);
        publish({ busy: "creating_run", error: null });
        try {
          const response = await options.api.createRunFromPackage(
            semantic, idempotencyKey, signal
          );
          if (!stillCurrent(expected, "create", token)
            || state.statementPackage?.packageId !== statementPackage.packageId
            || councilPolicyVersionId !== formulaPolicyVersionId) return;
          clearKey();
          publish({ latestRun: response.body, runAgents: null, busy: null, error: null });
          const agents = await options.api.getRunAgents(response.body.runId, signal);
          if (!stillCurrent(expected, "create", token)
            || state.latestRun?.runId !== response.body.runId) return;
          publish({ runAgents: agents.body, error: null });
        } catch (error) {
          if (!stillCurrent(expected, "create", token) || isAbort(error, signal)) return;
          publish({ busy: null, error: safeError(error) });
        }
      });
    },
    updateRouting(input) {
      if (!state.readiness?.capabilities.canManageRouting) {
        publish({ error: "financial_council_routing_forbidden" });
        return Promise.resolve();
      }
      if (!state.routingPolicy || !routingEtag) {
        publish({ error: "financial_council_routing_unavailable" });
        return Promise.resolve();
      }
      let canonicalInput: FinancialCouncilModelRoutingPolicyInput;
      try {
        canonicalInput = canonicalRoutingInput(input);
      } catch {
        publish({ error: "financial_council_routing_invalid" });
        return Promise.resolve();
      }
      if (!routingInputEligible(canonicalInput)) {
        publish({ error: "financial_council_pinned_connection_invalid" });
        return Promise.resolve();
      }
      const semantic = canonicalInput;
      const previousPolicy = state.routingPolicy;
      const previousEtag = routingEtag;
      return runOperation("routing", semantic, async (expected, token, signal) => {
        const [idempotencyKey, clearKey] = keyFor("routing-update", semantic);
        publish({ busy: "updating_routing", error: null });
        try {
          const response = await options.api.updateRouting(
            canonicalInput, previousEtag, idempotencyKey, signal
          );
          if (!stillCurrent(expected, "routing", token)
            || state.routingPolicy?.policyVersionId !== previousPolicy.policyVersionId
            || routingEtag !== previousEtag) return;
          clearKey();
          routingEtag = response.etag;
          publish({ routingPolicy: response.body, busy: null, error: null });
        } catch (error) {
          if (!stillCurrent(expected, "routing", token) || isAbort(error, signal)) return;
          if (error instanceof GrowthApiError && error.status === 412) {
            try {
              const current = await options.api.getRoutingPolicy(signal);
              if (!stillCurrent(expected, "routing", token)) return;
              routingEtag = current.etag;
              publish({
                routingPolicy: current.body,
                busy: null,
                error: error.code
              });
              return;
            } catch (reloadError) {
              if (!stillCurrent(expected, "routing", token)
                || isAbort(reloadError, signal)) return;
            }
          }
          publish({ busy: null, error: safeError(error) });
        }
      });
    },
    close() {
      if (destroyed) return;
      shutdown(false);
    },
    destroy() {
      if (destroyed) return;
      shutdown(true);
      destroyed = true;
    }
  };

  void load();
  return Object.freeze(controller);
}
