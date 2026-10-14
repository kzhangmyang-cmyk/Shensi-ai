import { execFile, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConnectorStatus, DesktopDiagnostic } from "../shared/contracts.ts";
import { SidecarClient } from "./sidecar-client.ts";

export interface SidecarCommand { file: string; args: string[]; cwd: string }
export function resolveSidecarCommand(input: { environment: "development" | "production" | "test"; repositoryRoot?: string; resourcesPath?: string }): SidecarCommand {
  if (input.environment === "production") { if (!input.resourcesPath) throw new Error("resourcesPath is required in production"); const cwd = path.join(input.resourcesPath, "sidecar"); return { file: path.join(cwd, "shensi-sidecar"), args: [], cwd }; }
  if (!input.repositoryRoot) throw new Error("repositoryRoot is required in development");
  return { file: "uv", args: ["run", "--frozen", "--project", "services/media-crawler", "python", "-m", "shensi_adapter.desktop_entrypoint"], cwd: input.repositoryRoot };
}

type Spawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type Listener = (status: ConnectorStatus) => void;
interface FileSystemBoundary { mkdir: typeof mkdir; writeFile: typeof writeFile; chmod: typeof chmod; rm: typeof rm; stat: typeof stat; realpath: typeof realpath }
interface ClockBoundary { now(): number; setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimeout(timer: ReturnType<typeof setTimeout>): void }
interface ProcessIdentity { pid: number; ppid: number; started: string }
interface Generation { id: number; abort: AbortController; token: string; tokenPath: string; child: ChildProcess | null; client: SidecarClient | null; ready: boolean; intentional: boolean; owned: Map<number, string>; monitor: ReturnType<typeof setTimeout> | null }

export interface SidecarProcessManagerOptions {
  environment: "development" | "production" | "test"; repositoryRoot?: string; resourcesPath?: string;
  userDataDirectory: string; logsDirectory: string; temporaryDirectory: string;
  startupTimeoutMs?: number; requestTimeoutMs?: number; shutdownTimeoutMs?: number;
  spawn?: Spawn; fetch?: typeof globalThis.fetch; clock?: ClockBoundary; fileSystem?: Partial<FileSystemBoundary>;
  randomToken?: () => string; randomFileId?: () => string; resolveCommand?: () => SidecarCommand;
  environmentVariables?: Record<string, string>; logger?: (message: string) => void;
  outputLogger?: (stream: "stdout" | "stderr", text: string) => void;
  processKill?: (pid: number, signal: NodeJS.Signals) => void;
  processTable?: () => Promise<ProcessIdentity[]>;
}

export class SidecarProcessManager {
  readonly #options: SidecarProcessManagerOptions; readonly #spawn: Spawn; readonly #fetch: typeof globalThis.fetch;
  readonly #clock: ClockBoundary; readonly #fs: FileSystemBoundary; readonly #listeners = new Set<Listener>();
  #status: ConnectorStatus = { state: "stopped", protocolVersion: null, diagnostic: null };
  #current: Generation | null = null; #scheduledAbort: AbortController | null = null;
  #tail: Promise<void> = Promise.resolve(); #restartCount = 0; #generation = 0; #desiredEpoch = 0;

  constructor(options: SidecarProcessManagerOptions) { this.#options = options; this.#spawn = options.spawn ?? nodeSpawn; this.#fetch = options.fetch ?? globalThis.fetch; this.#clock = options.clock ?? { now: Date.now, setTimeout, clearTimeout }; this.#fs = { mkdir, writeFile, chmod, rm, stat, realpath, ...options.fileSystem }; }
  get client(): SidecarClient | null { return this.#status.state === "ready" ? this.#current?.client ?? null : null; }
  getStatus(): ConnectorStatus { return structuredClone(this.#status); }
  getRestartCount(): number { return this.#restartCount; }
  onStatus(listener: Listener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  start(): Promise<ConnectorStatus> { if (this.#scheduledAbort || this.#current || ["starting", "ready"].includes(this.#status.state)) return Promise.reject(new Error("Sidecar is already started")); this.#restartCount = 0; return this.#scheduleLaunch(++this.#desiredEpoch); }
  restart(): Promise<ConnectorStatus> { const epoch = ++this.#desiredEpoch; this.#cancelPending(); const abort = new AbortController(); this.#scheduledAbort = abort; return this.#enqueue(async () => { await this.#stopCurrent(); if (epoch !== this.#desiredEpoch || abort.signal.aborted) throw diagnosticError("sidecar_start_cancelled", "Sidecar restart was cancelled"); if (this.#scheduledAbort === abort) this.#scheduledAbort = null; this.#restartCount = 0; return this.#launch(abort); }); }
  stop(): Promise<void> { ++this.#desiredEpoch; this.#cancelPending(); return this.#enqueue(async () => { await this.#stopCurrent(); this.#setStatus({ state: "stopped", protocolVersion: null, diagnostic: null }); }); }
  #scheduleLaunch(epoch = this.#desiredEpoch): Promise<ConnectorStatus> { const abort = new AbortController(); this.#scheduledAbort = abort; return this.#enqueue(async () => { if (epoch !== this.#desiredEpoch || abort.signal.aborted) throw diagnosticError("sidecar_start_cancelled", "Sidecar start was cancelled"); if (this.#scheduledAbort === abort) this.#scheduledAbort = null; return this.#launch(abort); }); }
  #enqueue<T>(operation: () => Promise<T>): Promise<T> { const result = this.#tail.then(operation, operation); this.#tail = result.then(() => undefined, () => undefined); return result; }
  #cancelPending(): void { this.#scheduledAbort?.abort(); this.#current?.abort.abort(); if (this.#current) this.#current.intentional = true; }

  async #launch(abort: AbortController): Promise<ConnectorStatus> {
    const id = ++this.#generation; const token = this.#options.randomToken?.() ?? randomBytes(32).toString("base64url"); const fileId = this.#options.randomFileId?.() ?? randomBytes(12).toString("hex");
    const record: Generation = { id, abort, token, tokenPath: path.join(this.#options.temporaryDirectory, `sidecar-token-${id}-${fileId}`), child: null, client: null, ready: false, intentional: false, owned: new Map(), monitor: null };
    this.#current = record; this.#setStatus({ state: "starting", protocolVersion: null, diagnostic: null });
    try {
      if (abort.signal.aborted) throw diagnosticError("sidecar_start_cancelled", "Sidecar start was cancelled");
      await this.#prepare(record);
      const command = this.#options.resolveCommand?.() ?? resolveSidecarCommand(this.#options); const environment = await this.#environment(record);
      const child = this.#spawn(command.file, command.args, { cwd: command.cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "pipe"], env: environment });
      record.child = child; child.on("error", () => { /* readiness owns startup errors; later errors are observed via exit/status */ }); this.#drainOutput(record, child); await this.#refreshOwnership(record); this.#monitorOwnership(record);
      const ready = await this.#readReady(record);
      if (ready.protocolVersion !== 1 || !Number.isInteger(ready.pid) || ready.pid < 1 || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) throw diagnosticError("sidecar_ready_invalid", "Sidecar returned an invalid ready handshake");
      if (this.#options.environment === "production" && ready.pid !== child.pid) throw diagnosticError("sidecar_ready_invalid", "Sidecar ready PID does not match packaged process");
      if (this.#options.environment !== "production" && ready.pid !== child.pid) { await this.#refreshOwnership(record); if (!record.owned.has(ready.pid)) throw diagnosticError("sidecar_ready_invalid", "Sidecar ready PID is not owned by the development launcher"); }
      const client = new SidecarClient({ origin: `http://127.0.0.1:${ready.port}`, token, fetch: this.#fetch, requestTimeoutMs: this.#options.requestTimeoutMs ?? 10_000 }); record.client = client;
      await client.health(abort.signal);
      if (abort.signal.aborted || this.#current !== record) throw diagnosticError("sidecar_start_cancelled", "Sidecar start was cancelled");
      record.ready = true; child.once("exit", (code, signal) => this.#onUnexpectedExit(record, code, signal));
      this.#setStatus({ state: "ready", protocolVersion: 1, diagnostic: null }); return this.getStatus();
    } catch (error) {
      const diagnostic = error instanceof Error && error.name === "SidecarRequestError" ? makeDiagnostic("sidecar_health_failed", "Sidecar health verification failed", true) : asDiagnostic(error);
      record.intentional = true; await this.#terminateRecord(record).catch(() => undefined); await this.#cleanupToken(record).catch(() => undefined);
      if (this.#current === record) { this.#current = null; if (diagnostic.code !== "sidecar_start_cancelled") this.#setStatus({ state: "crashed", protocolVersion: null, diagnostic }); }
      throw error;
    }
  }

  async #prepare(record: Generation): Promise<void> { await this.#fs.mkdir(this.#options.temporaryDirectory, { recursive: true, mode: 0o700 }); await this.#fs.mkdir(this.#options.userDataDirectory, { recursive: true, mode: 0o700 }); await this.#fs.mkdir(this.#options.logsDirectory, { recursive: true, mode: 0o700 }); await this.#fs.writeFile(record.tokenPath, record.token, { mode: 0o600, flag: "wx" }); await this.#fs.chmod(record.tokenPath, 0o600); }
  async #environment(record: Generation): Promise<NodeJS.ProcessEnv> {
    const environment: NodeJS.ProcessEnv = { ...process.env, ...this.#options.environmentVariables, SHENSI_RUNTIME_MODE: "desktop", MEDIACRAWLER_BROWSER_DISPLAY: "operator", MEDIACRAWLER_BROWSER_HEADLESS: "false", MEDIACRAWLER_BROWSER_CHANNEL: "chromium", SHENSI_READY_FD: "3", SHENSI_USER_DATA_DIR: this.#options.userDataDirectory, SHENSI_LOG_DIR: this.#options.logsDirectory, MEDIACRAWLER_SERVICE_SECRET_FILE: record.tokenPath,
      SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED: "true", DOUYIN_OUTREACH_ACTIONS_ENABLED: "false" };
    // The local connector never calls the central business API. Main owns that
    // origin and all device/task credentials; only local task projections cross.
    delete environment.SHENSI_REMOTE_ORIGIN;
    if (this.#options.environment === "production") { delete environment.PYTHONPATH; if (!this.#options.resourcesPath) throw new Error("resourcesPath is required in production"); const browsers = path.join(this.#options.resourcesPath, "playwright"); const [resourceRoot, actual, details] = await Promise.all([this.#fs.realpath(this.#options.resourcesPath), this.#fs.realpath(browsers), this.#fs.stat(browsers)]); if (actual !== path.join(resourceRoot, "playwright") || !details.isDirectory()) throw new Error("Bundled Playwright browser directory is invalid"); environment.PLAYWRIGHT_BROWSERS_PATH = browsers; }
    else { if (!this.#options.repositoryRoot) throw new Error("repositoryRoot is required in development"); environment.PYTHONPATH = path.join(this.#options.repositoryRoot, "services", "media-crawler"); delete environment.PLAYWRIGHT_BROWSERS_PATH; }
    return environment;
  }

  #drainOutput(record: Generation, child: ChildProcess): void { for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) { let logged = 0; stream?.setEncoding("utf8"); stream?.on("data", (chunk: string) => { if (logged >= 16_384) return; const safe = chunk.slice(0, 16_384 - logged).replaceAll(record.token, "[REDACTED]").replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]"); logged += safe.length; try { this.#options.outputLogger?.(name, safe); } catch { this.#safeLog("Sidecar output logger failed"); } }); } }
  #readReady(record: Generation): Promise<{ type: "shensi-sidecar-ready"; protocolVersion: number; pid: number; port: number }> {
    return new Promise((resolve, reject) => {
      const child = record.child!; const stream = child.stdio[3]; if (!stream || typeof stream === "number" || !("on" in stream)) { reject(diagnosticError("sidecar_ready_invalid", "Sidecar ready pipe is unavailable")); return; }
      let buffer = "", settled = false; let settleTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (error?: Error, value?: any) => { if (settled) return; settled = true; this.#clock.clearTimeout(timeout); if (settleTimer) this.#clock.clearTimeout(settleTimer); stream.removeListener("data", onData); stream.removeListener("end", onEnd); child.removeListener("exit", onExit); child.removeListener("error", onError); record.abort.signal.removeEventListener("abort", onAbort); error ? reject(error) : resolve(value); };
      const validate = () => { try { const lines = buffer.split("\n"); if (lines.at(-1) !== "") throw new Error(); lines.pop(); if (lines.length !== 1) throw new Error(); const parsed = JSON.parse(lines[0]!); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).sort().join(",") !== "pid,port,protocolVersion,type" || parsed.type !== "shensi-sidecar-ready") throw new Error(); finish(undefined, parsed); } catch { finish(diagnosticError("sidecar_ready_invalid", "Sidecar returned an invalid ready handshake")); } };
      const onData = (chunk: Buffer | string) => { buffer += chunk.toString(); if (buffer.length > 4096) finish(diagnosticError("sidecar_ready_invalid", "Sidecar ready handshake is too large")); else if (buffer.includes("\n") && settleTimer === null) settleTimer = this.#clock.setTimeout(validate, 250); };
      const onEnd = () => buffer.length ? validate() : undefined; const onExit = () => finish(diagnosticError("sidecar_exited", "Sidecar exited before becoming ready")); const onError = () => finish(diagnosticError("sidecar_spawn_failed", "Sidecar process could not be started")); const onAbort = () => finish(diagnosticError("sidecar_start_cancelled", "Sidecar start was cancelled"));
      const timeout = this.#clock.setTimeout(() => finish(diagnosticError("sidecar_start_timeout", "Sidecar startup timed out")), this.#options.startupTimeoutMs ?? 15_000);
      stream.on("data", onData); stream.once("end", onEnd); child.once("exit", onExit); child.once("error", onError); record.abort.signal.addEventListener("abort", onAbort, { once: true });
      if (record.abort.signal.aborted) onAbort();
    });
  }

  async #stopCurrent(): Promise<void> { const record = this.#current; if (!record) return; record.intentional = true; record.abort.abort(); await this.#terminateRecord(record); await this.#cleanupToken(record); if (this.#current === record) this.#current = null; }
  async #terminateRecord(record: Generation): Promise<void> {
    this.#stopOwnershipMonitor(record); await this.#refreshOwnership(record).catch(() => undefined);
    const child = record.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) await this.#waitForExit(child, "SIGTERM").catch(() => this.#waitForExit(child, "SIGKILL"));
    await this.#reapOwned(record);
  }
  #killOwnedPid(pid: number, signal: NodeJS.Signals): void { const kill = this.#options.processKill ?? process.kill; try { if (process.platform !== "win32") kill(-pid, signal); } catch { /* process may not lead a group */ } try { kill(pid, signal); } catch { /* already exited */ } }
  #waitForExit(child: ChildProcess, signal: NodeJS.Signals): Promise<void> { return new Promise((resolve, reject) => { if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; } let settled = false; const done = () => { if (settled) return; settled = true; this.#clock.clearTimeout(timer); child.removeListener("exit", done); resolve(); }; child.once("exit", done); try { if (process.platform !== "win32" && child.pid) (this.#options.processKill ?? process.kill)(-child.pid, signal); else child.kill(signal); } catch { child.kill(signal); } const timer = this.#clock.setTimeout(() => { if (settled) return; settled = true; child.removeListener("exit", done); reject(new Error(`Sidecar did not exit after ${signal}`)); }, this.#options.shutdownTimeoutMs ?? 3_000); }); }
  async #refreshOwnership(record: Generation): Promise<void> { const rootPid = record.child?.pid; if (!rootPid) return; const table = await (this.#options.processTable ?? readProcessTable)(); const children = new Map<number, ProcessIdentity[]>(); for (const item of table) children.set(item.ppid, [...(children.get(item.ppid) ?? []), item]); const queue = [...(children.get(rootPid) ?? [])]; while (queue.length) { const item = queue.shift()!; if (!record.owned.has(item.pid)) record.owned.set(item.pid, item.started); queue.push(...(children.get(item.pid) ?? [])); } }
  #monitorOwnership(record: Generation): void { const tick = async () => { if (record.intentional || this.#current !== record) return; await this.#refreshOwnership(record).catch(() => undefined); if (!record.intentional && this.#current === record) record.monitor = this.#clock.setTimeout(() => void tick(), 100); }; record.monitor = this.#clock.setTimeout(() => void tick(), 0); }
  #stopOwnershipMonitor(record: Generation): void { if (record.monitor) this.#clock.clearTimeout(record.monitor); record.monitor = null; }
  async #reapOwned(record: Generation): Promise<void> { const table = await (this.#options.processTable ?? readProcessTable)(); const current = new Map(table.map((item) => [item.pid, item.started])); const owned = [...record.owned].filter(([pid, started]) => current.get(pid) === started); for (const [pid] of owned.reverse()) this.#killOwnedPid(pid, "SIGKILL"); const deadline = this.#clock.now() + (this.#options.shutdownTimeoutMs ?? 3_000); while (owned.length && this.#clock.now() < deadline) { const live = new Map((await (this.#options.processTable ?? readProcessTable)()).map((item) => [item.pid, item.started])); if (owned.every(([pid, started]) => live.get(pid) !== started)) return; await new Promise<void>((resolve) => this.#clock.setTimeout(resolve, 20)); } if (owned.length) { const live = new Map((await (this.#options.processTable ?? readProcessTable)()).map((item) => [item.pid, item.started])); if (owned.some(([pid, started]) => live.get(pid) === started)) throw new Error("Owned Sidecar descendants did not exit"); } }
  async #cleanupToken(record: Generation): Promise<void> { await this.#fs.rm(record.tokenPath, { force: true }); }
  #onUnexpectedExit(record: Generation, code: number | null, signal: NodeJS.Signals | null): void { if (this.#current !== record || record.intentional) return; const epoch = this.#desiredEpoch; record.intentional = true; record.client = null; void this.#enqueue(async () => { try { await this.#terminateRecord(record); await this.#cleanupToken(record); } catch { this.#setStatus({ state: "crashed", protocolVersion: null, diagnostic: makeDiagnostic("sidecar_cleanup_failed", "Sidecar descendants could not be reaped", false) }); return; } if (this.#current === record) this.#current = null; this.#setStatus({ state: "crashed", protocolVersion: null, diagnostic: makeDiagnostic("sidecar_crashed", `Sidecar exited unexpectedly (${code ?? signal ?? "unknown"})`, true) }); if (epoch !== this.#desiredEpoch || this.#restartCount >= 2) return; this.#restartCount++; await this.#launch(new AbortController()).catch(() => undefined); }); }
  #setStatus(status: ConnectorStatus): void { this.#status = status; this.#safeLog(`Sidecar state: ${status.state}${status.diagnostic ? ` (${status.diagnostic.code})` : ""}`); for (const listener of [...this.#listeners]) { try { listener(this.getStatus()); } catch { this.#safeLog("Sidecar status listener failed"); } } }
  #safeLog(message: string): void { try { this.#options.logger?.(message); } catch { /* observers cannot affect ownership */ } }
}
function makeDiagnostic(code: string, message: string, recoverable: boolean): DesktopDiagnostic { return { code, message, recoverable, occurredAt: new Date().toISOString() }; }
function diagnosticError(code: string, message: string): Error { const error = new Error(message) as Error & { diagnostic?: DesktopDiagnostic }; error.diagnostic = makeDiagnostic(code, message, true); return error; }
function asDiagnostic(error: unknown): DesktopDiagnostic { const value = error as { diagnostic?: DesktopDiagnostic }; return value?.diagnostic ?? makeDiagnostic("sidecar_start_failed", "Sidecar failed to start", true); }
async function readProcessTable(): Promise<ProcessIdentity[]> { const output = await new Promise<string>((resolve, reject) => execFile("/bin/ps", ["-axo", "pid=,ppid=,lstart="], { encoding: "utf8", maxBuffer: 2_000_000 }, (error, stdout) => error ? reject(error) : resolve(stdout))); const result: ProcessIdentity[] = []; for (const line of output.split("\n")) { const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line); if (match) result.push({ pid: Number(match[1]), ppid: Number(match[2]), started: match[3]! }); } return result; }
