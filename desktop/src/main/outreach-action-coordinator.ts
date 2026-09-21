import { randomUUID } from "node:crypto";
import { CentralRequestError, type DesktopCentralApiClient, type DeviceContext,
  type ClaimRequest, type ClaimResponse, type CompletionRequest, type ReconcileResponse } from "./desktop-central-api-client.ts";
import { createProcessInstanceId, type DeviceInstallationStore } from "./device-installation.ts";
import type { DeviceCredentialStore, DesktopWorkspaceCredential } from "./device-credential-store.ts";
import type { OutreachActionJournalStore, OutreachActionRecoveryRecord } from "./outreach-action-journal.ts";
import type { SidecarClient } from "./sidecar-client.ts";
import type { LocalDouyinAction, LocalDouyinReceipt } from "./sidecar-outreach-protocol.ts";
import type { DesktopOutreachCoordinatorView } from "../shared/contracts.ts";

export type DesktopOutreachCoordinatorState = "disabled" | "unenrolled" | "unbound" | "offline" | "idle"
  | "claiming" | "claimed" | "executing" | "reconciling" | "risk_paused" | "error" | "stopping";
export interface DesktopOutreachCoordinatorSnapshot {
  state: DesktopOutreachCoordinatorState;
  accounts: Array<{ accountId: string; actionId: string | null; state: DesktopOutreachCoordinatorState }>;
}
export interface CoordinatorClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface DesktopOutreachActionCoordinatorOptions {
  central: Pick<DesktopCentralApiClient, "claim" | "complete" | "reconcile">;
  sidecar: Pick<SidecarClient, "resolveDouyinIdentity" | "executeDouyinAction" | "reconcileDouyinAction" | "acknowledgeDouyinAction">;
  installationStore: DeviceInstallationStore;
  credentialStore: DeviceCredentialStore;
  journalStore: OutreachActionJournalStore;
  accountKeyFor(accountId: string, workspaceId: string): string;
  enabled?: boolean;
  workspaceId?: string | null;
  clock?: CoordinatorClock;
  random?: () => number;
  onState?(state: DesktopOutreachCoordinatorSnapshot): void;
  onDiagnostic?(diagnostic: { phase: "poll" | "identity"; source: "central" | "sidecar" | "coordinator"; httpStatus?: number }): void;
}
type Account = ClaimRequest["availableAccounts"][number];
type Claimed = Extract<ClaimResponse, { kind: "claimed" }>;
type Recovery = Extract<ReconcileResponse, { kind: "reconcile" }>;
type Execution = { epoch: number; processId: string; context: DeviceContext; signal: AbortSignal };
const realClock: CoordinatorClock = {
  now: Date.now, setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** Main-private execution owner. Durable records never carry executable authority. */
export class DesktopOutreachActionCoordinator {
  readonly #options: DesktopOutreachActionCoordinatorOptions;
  readonly #clock: CoordinatorClock;
  readonly #listeners = new Set<(state: DesktopOutreachCoordinatorSnapshot) => void>();
  #workspaceId: string | null;
  #credential: DesktopWorkspaceCredential | null = null;
  #context: DeviceContext | null = null;
  #processId = "";
  #running = false;
  #ready = true;
  #generation: number | undefined;
  #state: DesktopOutreachCoordinatorState = "disabled";
  #accounts = new Map<string, Account>();
  #states = new Map<string, DesktopOutreachCoordinatorState>();
  #records = new Map<string, OutreachActionRecoveryRecord>();
  #lanes = new Map<string, Promise<void>>();
  #poll: Promise<void> | null = null;
  #timer: unknown;
  #pollAbort = new AbortController();
  #workAbort = new AbortController();
  #stopPromise: Promise<void> | null = null;
  #backoff = 0;
  #epoch = 0;
  #transition = 0;
  #updatedAt: string | null = null;
  #diagnostic: DesktopOutreachCoordinatorView["diagnostic"] = null;
  #kinds = new Map<string, LocalDouyinAction["kind"]>();

  constructor(options: DesktopOutreachActionCoordinatorOptions) {
    this.#options = options; this.#clock = options.clock ?? realClock;
    this.#workspaceId = options.workspaceId ?? null;
    if (options.onState) this.#listeners.add(options.onState);
  }
  getState(): DesktopOutreachCoordinatorSnapshot {
    return { state: this.#state, accounts: [...new Set([...this.#states.keys(), ...this.#records.keys()])].sort().map((accountId) => ({
      accountId, actionId: this.#records.get(accountId)?.actionId ?? null, state: this.#states.get(accountId) ?? "reconciling"
    })) };
  }
  getStatusMetadata(): Omit<DesktopOutreachCoordinatorView, "state" | "ownership"> {
    const active = [...this.#records.values()].filter((record) => record.workspaceId === this.#workspaceId);
    const current = active.find((record) => this.#states.get(record.accountId) === "executing") ?? active[0];
    return { diagnostic: this.#diagnostic, currentActionKind: current ? this.#kinds.get(current.accountId) ?? null : null,
      updatedAt: this.#updatedAt, pendingReconciliationCount: active.filter((record) =>
        !["claimed", "executing"].includes(this.#states.get(record.accountId) ?? "reconciling")).length };
  }
  onState(listener: (state: DesktopOutreachCoordinatorSnapshot) => void): () => void {
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }
  async start(): Promise<void> {
    if (this.#running) return;
    await this.#start(++this.#transition);
  }
  async #start(transition: number): Promise<void> {
    if (this.#stopPromise) await this.#stopPromise;
    if (transition !== this.#transition) return;
    if (this.#running) return;
    this.#state = "disabled";
    this.#accounts.clear(); this.#states.clear();
    if (!this.#options.enabled) { this.#publish("disabled"); return; }
    if (!this.#workspaceId) { this.#publish("unenrolled"); return; }
    this.#running = true; this.#processId = createProcessInstanceId(); this.#backoff = 0; this.#epoch++;
    const epoch = this.#epoch; const workspaceId = this.#workspaceId;
    this.#pollAbort = new AbortController(); this.#workAbort = new AbortController();
    try {
      const credential = await this.#options.credentialStore.load(workspaceId);
      if (!this.#running || epoch !== this.#epoch || transition !== this.#transition) return;
      this.#credential = credential;
      if (!credential) { this.#publish("unenrolled"); return; }
      const installationId = await this.#options.installationStore.getOrCreateInstallationId();
      if (!this.#running || epoch !== this.#epoch || transition !== this.#transition) return;
      const records = await this.#options.journalStore.list();
      if (!this.#running || epoch !== this.#epoch || transition !== this.#transition) return;
      this.#context = { workspaceId, deviceToken: credential.deviceToken, installationId };
      this.#records = new Map(records.map((record) => [record.accountId, record]));
      if (!credential.bindings.length) { this.#publish("unbound"); return; }
      if (!this.#ready) { this.#publish("offline"); return; }
      await this.#identities();
      if (this.#running && epoch === this.#epoch && transition === this.#transition) this.#launchPoll();
    } catch { if (epoch === this.#epoch && transition === this.#transition) this.#publish("error"); }
  }
  async setContext(workspaceId: string | null): Promise<void> {
    const transition = ++this.#transition;
    // Selection is durable intent across lifecycle transitions. A concurrent
    // ready event may own the restart, but cannot restore the previous tenant.
    this.#workspaceId = workspaceId;
    await this.#drain(); if (transition !== this.#transition) return;
    this.#accounts.clear(); this.#states.clear(); this.#records.clear(); this.#kinds.clear();
    await this.#start(transition);
  }
  async onSidecarChanged(ready: boolean, generation?: number): Promise<void> {
    if (ready === this.#ready && generation === this.#generation) return;
    const transition = ++this.#transition;
    this.#ready = ready; this.#generation = generation;
    await this.#drain(); if (transition !== this.#transition) return;
    this.#accounts.clear();
    if (ready) await this.#start(transition); else this.#publish("offline");
  }
  stop(): Promise<void> {
    this.#transition++;
    return this.#drain();
  }
  #drain(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    if (!this.#running) return Promise.resolve();
    this.#running = false; this.#publish("stopping"); this.#pollAbort.abort();
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    const active = [this.#poll, ...this.#lanes.values()].filter((value): value is Promise<void> => value !== null);
    this.#stopPromise = (async () => {
      let timeout: unknown;
      await Promise.race([Promise.allSettled(active), new Promise<void>((resolve) => {
        timeout = this.#clock.setTimeout(resolve, 10_000);
      })]);
      if (timeout !== undefined) this.#clock.clearTimeout(timeout);
      this.#workAbort.abort();
      this.#epoch++; this.#lanes.clear(); this.#poll = null;
    })().finally(() => { this.#stopPromise = null; });
    return this.#stopPromise;
  }
  #publish(state?: DesktopOutreachCoordinatorState, accountId?: string,
    diagnostic?: DesktopOutreachCoordinatorView["diagnostic"]) {
    if (accountId && state) this.#states.set(accountId, state);
    if (!this.#running && this.#state === "stopping" && state !== "offline") return;
    if (state) this.#state = state;
    this.#updatedAt = this.#now();
    this.#diagnostic = diagnostic ?? (state === "offline" ? "connector_unavailable"
      : state === "error" ? "coordinator_error" : state === "risk_paused" ? "risk_paused" : null);
    for (const listener of this.#listeners) { try { listener(this.getState()); } catch { /* A consumer cannot interrupt journal ordering. */ } }
  }
  #jitter() { const sample = this.#options.random?.() ?? Math.random(); return 3000 + Math.floor(Math.max(0, Math.min(1, Number.isFinite(sample) ? sample : 0.5)) * 2000); }
  #schedule(ms = this.#jitter()) {
    if (!this.#running || !this.#ready) return;
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = this.#clock.setTimeout(() => { this.#timer = undefined; this.#launchPoll(); }, ms);
  }
  #launchPoll() {
    if (!this.#running || this.#poll) return;
    const epoch = this.#epoch;
    const pending = this.#tick().catch((error: unknown) => {
      if (this.#running && epoch === this.#epoch) {
        this.#report("poll", error);
        this.#publish("offline", undefined, error instanceof CentralRequestError && error.status === 404
          ? "binding_unavailable" : undefined);
      }
    })
      .finally(() => { if (this.#poll === pending) { this.#poll = null; this.#schedule(); } });
    this.#poll = pending;
  }
  #report(phase: "poll" | "identity", error: unknown) {
    // Never include raw errors, request payloads, identities or credentials.
    const diagnostic = error instanceof CentralRequestError
      ? { phase, source: "central" as const, httpStatus: error.status }
      : { phase, source: phase === "identity" ? "sidecar" as const : "coordinator" as const };
    try { this.#options.onDiagnostic?.(diagnostic); } catch { /* Logging cannot change execution. */ }
  }
  async #identities() {
    const epoch = this.#epoch;
    await Promise.all((this.#credential?.bindings ?? []).map(async (binding) => {
      if (this.#accounts.has(binding.accountId)) return;
      try {
        const identity = await this.#options.sidecar.resolveDouyinIdentity(this.#options.accountKeyFor(binding.accountId, this.#workspaceId!), this.#pollAbort.signal);
        if (!this.#running || epoch !== this.#epoch) return;
        this.#accounts.set(binding.accountId, { accountId: binding.accountId, bindingGeneration: binding.bindingGeneration,
          accountHandle: identity.accountHandle, loginStateVersion: identity.loginStateVersion });
        this.#publish("idle", binding.accountId);
      } catch (error) {
        if (this.#running && epoch === this.#epoch) {
          this.#report("identity", error); this.#publish("offline", binding.accountId);
        }
      }
    }));
  }
  async #tick() {
    if (!this.#running || !this.#ready || !this.#context) return;
    const execution = this.#execution();
    await this.#identities();
    this.#assertExecution(execution);
    for (const [accountId, record] of this.#records) {
      if (record.workspaceId === this.#workspaceId && this.#accounts.has(accountId) && !this.#lanes.has(accountId)
        && this.#states.get(accountId) !== "error") this.#lane(accountId, () => this.#recover(record));
    }
    while (this.#running && this.#ready && this.#records.size < 2) {
      const availableAccounts = [...this.#accounts.values()].filter((account) => !this.#records.has(account.accountId)
        && !this.#lanes.has(account.accountId)
        && !["risk_paused", "error"].includes(this.#states.get(account.accountId) ?? ""));
      if (!availableAccounts.length) return;
      this.#publish("claiming");
      const request: ClaimRequest = { protocolVersion: 1, processInstanceId: execution.processId, waitSeconds: 0, availableAccounts };
      const idempotencyKey = randomUUID();
      const result = await this.#central(() => this.#options.central.claim(execution.context, request,
        { idempotencyKey, signal: this.#pollAbort.signal }), this.#pollAbort.signal);
      this.#assertExecution(execution);
      if (result.kind === "empty") { this.#publish(this.#records.size ? "reconciling" : "idle"); return; }
      if (result.kind === "reconcile") {
        this.#publish("reconciling", result.task.accountId);
        this.#lane(result.task.accountId, () => this.#observeHumanRequest(result, execution));
        return;
      }
      const task = result.task;
      this.#kinds.set(task.accountId, task.kind);
      const record: OutreachActionRecoveryRecord = { version: 1, actionId: task.actionId, workspaceId: task.workspaceId,
        accountId: task.accountId, requestHash: task.taskRequestHash, leaseVersion: task.leaseVersion,
        bindingGeneration: task.executorBindingGeneration, loginStateVersion: task.loginStateVersion,
        phase: "claimed", receiptHash: null, updatedAt: this.#now() };
      await this.#save(record, execution);
      if (!this.#running) return;
      this.#publish("claimed", task.accountId);
      this.#lane(task.accountId, () => this.#execute(result, record));
    }
  }
  #lane(accountId: string, run: () => Promise<void>) {
    const epoch = this.#epoch;
    const pending = run().catch(() => { if (epoch === this.#epoch) this.#publish("reconciling", accountId); })
      .finally(() => { if (this.#lanes.get(accountId) === pending) this.#lanes.delete(accountId); });
    this.#lanes.set(accountId, pending);
  }
  async #observeHumanRequest(grant: Recovery, execution: Execution) {
    // Central owns this durable request. It is not an original write attempt
    // and must not recreate a local write journal or acknowledge its tombstone.
    const task = grant.task;
    const observed = await this.#options.sidecar.reconcileDouyinAction(localTask(task), execution.signal);
    this.#assertExecution(execution);
    if (observed.receipt.state === "failed" && observed.receipt.failureCode !== "action_unavailable"
      && observed.receipt.failureCode !== "douyin_action_receipt_ambiguous") {
      this.#publish("reconciling", task.accountId); return;
    }
    const key = randomUUID();
    const result = await this.#central(() => this.#options.central.complete(execution.context, task.actionId, {
      protocolVersion: 1, processInstanceId: execution.processId,
      bindingGeneration: task.executorBindingGeneration,
      command: { event: "receipt", leaseVersion: task.leaseVersion,
        loginStateVersion: task.observationLoginStateVersion ?? task.loginStateVersion, taskRequestHash: task.taskRequestHash,
        reconciliation: true, receipt: observed.receipt } as CompletionRequest["command"]
    }, { idempotencyKey: key, taskToken: grant.taskToken, signal: execution.signal }), execution.signal);
    this.#assertExecution(execution);
    this.#publish(result.accountPaused ? "risk_paused" : "idle", task.accountId);
  }
  #now() { return new Date(this.#clock.now()).toISOString(); }
  #execution(): Execution { return { epoch: this.#epoch, processId: this.#processId, context: this.#context!, signal: this.#workAbort.signal }; }
  #assertExecution(execution: Execution) { if (execution.epoch !== this.#epoch || execution.signal.aborted) throw new Error("desktop_coordinator_stopped"); }
  async #save(record: OutreachActionRecoveryRecord, execution: Execution) {
    this.#assertExecution(execution);
    await this.#options.journalStore.save(record); this.#assertExecution(execution); this.#records.set(record.accountId, record);
  }
  async #execute(claim: Claimed, record: OutreachActionRecoveryRecord) {
    const execution = this.#execution();
    const task = claim.task;
    const started: CompletionRequest = { protocolVersion: 1, processInstanceId: execution.processId,
      bindingGeneration: record.bindingGeneration, command: { event: "started", leaseVersion: task.leaseVersion,
        loginStateVersion: task.loginStateVersion, taskRequestHash: task.taskRequestHash, occurredAt: this.#now() } };
    const key = randomUUID();
    const response = await this.#central(() => this.#options.central.complete(execution.context, task.actionId, started,
      { idempotencyKey: key, taskToken: claim.taskToken, signal: execution.signal }), execution.signal);
    if (response.state !== "executing") throw new Error("desktop_start_not_executing");
    record = { ...record, phase: "central_started", updatedAt: this.#now() }; await this.#save(record, execution);
    if (!this.#running || !this.#ready) return;
    this.#publish("executing", record.accountId);
    const result = await this.#options.sidecar.executeDouyinAction(localTask(task), execution.signal);
    await this.#receipt(claim, record, result, false, execution);
  }
  async #recover(record: OutreachActionRecoveryRecord) {
    const execution = this.#execution();
    const account = this.#accounts.get(record.accountId)!;
    if (account.bindingGeneration !== record.bindingGeneration || account.loginStateVersion !== record.loginStateVersion) {
      this.#publish("error", record.accountId); return;
    }
    this.#publish("reconciling", record.accountId);
    const common = { protocolVersion: 1 as const, processInstanceId: execution.processId, ...account,
      originalLeaseVersion: record.leaseVersion, taskRequestHash: record.requestHash };
    const input = record.phase === "sidecar_completed"
      ? { ...common, journalPhase: record.phase, receiptHash: record.receiptHash! }
      : { ...common, journalPhase: record.phase };
    const idempotencyKey = randomUUID();
    const result = await this.#central(() => this.#options.central.reconcile(execution.context, record.actionId, input,
      { idempotencyKey, signal: execution.signal }), execution.signal);
    this.#assertExecution(execution);
    if (result.kind === "not_authorized") { this.#publish("error", record.accountId); return; }
    if (result.kind === "waiting") return;
    if (result.kind === "released") {
      await this.#options.journalStore.releaseUnstarted(record.accountId, {
        actionId: result.actionId, requestHash: result.taskRequestHash, leaseVersion: result.originalLeaseVersion
      });
      this.#assertExecution(execution);
      this.#records.delete(record.accountId); this.#publish("idle", record.accountId); return;
    }
    if (result.kind === "terminal") {
      record = { ...record, phase: "sidecar_completed", receiptHash: result.receiptHash, updatedAt: this.#now() };
      await this.#save(record, execution);
      // Uncertainty is fenced by central's account lane. Keep polling so a
      // later human request can be discovered after the local journal is gone.
      await this.#cleanup(record, result.status === "risk_paused", execution, result.status === "queued"); return;
    }
    if (!this.#running || !this.#ready) return;
    this.#kinds.set(record.accountId, result.task.kind);
    const receipt = await this.#options.sidecar.reconcileDouyinAction(localTask(result.task), execution.signal);
    // Read-only reconciliation may return a cached original failure. Only a
    // confirmed success or the protocol's action_unavailable outcome is admitted
    // under its new fence; unavailability is not proof that no write occurred.
    if (receipt.receipt.state === "failed" && receipt.receipt.failureCode !== "action_unavailable") return;
    await this.#receipt(result, record, receipt, true, execution);
  }
  async #receipt(authority: Claimed | Recovery, record: OutreachActionRecoveryRecord,
    result: { receipt: LocalDouyinReceipt; receiptHash: string }, reconciliation: boolean, execution: Execution) {
    record = { ...record, phase: "sidecar_completed", receiptHash: result.receiptHash, updatedAt: this.#now() };
    await this.#save(record, execution);
    const task = authority.task;
    const command = { event: "receipt" as const, leaseVersion: task.leaseVersion, loginStateVersion: task.loginStateVersion,
      taskRequestHash: task.taskRequestHash, reconciliation, receipt: result.receipt } as CompletionRequest["command"];
    const input: CompletionRequest = { protocolVersion: 1, processInstanceId: execution.processId,
      bindingGeneration: task.executorBindingGeneration, command };
    const idempotencyKey = randomUUID();
    const response = await this.#central(() => this.#options.central.complete(execution.context, record.actionId, input,
      { idempotencyKey, taskToken: authority.taskToken, signal: execution.signal }), execution.signal);
    if (response.state === "executing") throw new Error("desktop_receipt_not_terminal");
    if (response.state === "queued" && result.receipt.failureCode !== "douyin_profile_busy") throw new Error("desktop_receipt_not_retryable");
    await this.#cleanup(record, response.accountPaused || response.state === "risk_paused", execution, response.state === "queued");
  }
  async #cleanup(record: OutreachActionRecoveryRecord, paused: boolean, execution: Execution, preJournalBusy = false) {
    this.#assertExecution(execution);
    // Only central's durable queued disposition proves the pre-journal busy
    // case. There is no Sidecar record to acknowledge (or tombstone to retain).
    if (!preJournalBusy) await this.#options.sidecar.acknowledgeDouyinAction(record.actionId, record.requestHash, record.receiptHash!, execution.signal);
    this.#assertExecution(execution);
    await this.#options.journalStore.remove(record.accountId, { actionId: record.actionId, requestHash: record.requestHash, receiptHash: record.receiptHash! });
    this.#records.delete(record.accountId); this.#publish(paused ? "risk_paused" : "idle", record.accountId);
  }
  async #central<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (;;) {
      if (signal.aborted) throw new Error("desktop_coordinator_stopped");
      try { const result = await request(); this.#backoff = 0; return result; }
      catch (error) {
        if (!this.#running || signal.aborted || !(error instanceof CentralRequestError)
          || (error.status !== 0 && error.status < 500)) throw error;
        if (error.status === 503 && error.code === "desktop_execution_disabled") this.#publish("disabled");
        else this.#publish("offline", undefined, "central_unreachable");
        const delay = [2000, 4000, 8000, 16000, 32000, 60000][Math.min(this.#backoff++, 5)];
        await this.#delay(delay, signal);
      }
    }
  }
  #delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => { this.#clock.clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("desktop_coordinator_stopped")); };
      const timer = this.#clock.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    });
  }
}

function localTask(task: LocalDouyinAction): LocalDouyinAction {
  return { actionId: task.actionId, accountHandle: task.accountHandle, loginStateVersion: task.loginStateVersion,
    ...(task.observationLoginStateVersion === undefined ? {} : { observationLoginStateVersion: task.observationLoginStateVersion }),
    kind: task.kind, canonicalTargetPublicUrl: task.canonicalTargetPublicUrl, content: task.content,
    approvedContentHash: task.approvedContentHash, taskRequestHash: task.taskRequestHash, deadlineAt: task.deadlineAt };
}
