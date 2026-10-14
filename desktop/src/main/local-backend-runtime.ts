import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { LocalManagedService } from './local-service-lifecycle.ts';

export interface LocalBackendRuntimeOptions {
  nodeExecutable: string;
  entrypoint: string;
  port: number;
  /** Prepared installation configuration, never process.env. Secrets stay out of argv. */
  environment: Readonly<Record<string, string>>;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

/** Owns only the directly spawned backend. Resource/credential provisioning is separate. */
export class LocalBackendRuntime implements LocalManagedService {
  #child: ChildProcess | null = null;
  #exited = false;
  #exit: Promise<void> = Promise.resolve();
  #ready = false;
  #abort: AbortController | null = null;
  #starting: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;
  readonly #options: LocalBackendRuntimeOptions;

  constructor(options: LocalBackendRuntimeOptions) {
    if (!isAbsolute(options.nodeExecutable) || !isAbsolute(options.entrypoint)
      || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535
      || [options.startupTimeoutMs ?? 120000, options.shutdownTimeoutMs ?? 15000]
        .some(value => !Number.isFinite(value) || value <= 0))
      throw new Error('local_backend_configuration_invalid');
    this.#options = { ...options, environment: { ...options.environment } };
  }

  get origin(): string {
    if (!this.#ready || this.#exited) throw new Error('local_backend_not_ready');
    return `http://127.0.0.1:${this.#options.port}`;
  }

  start(signal: AbortSignal): Promise<void> {
    if (this.#child || this.#starting || this.#stopping)
      return Promise.reject(new Error('local_backend_already_started'));
    const abort = new AbortController(); this.#abort = abort;
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) abort.abort();
    const starting = this.#launch(abort.signal);
    this.#starting = starting;
    const finished = () => { signal.removeEventListener('abort', cancel); this.#starting = null; };
    void starting.then(finished, finished);
    return starting;
  }

  async #launch(signal: AbortSignal): Promise<void> {
    const options = this.#options;
    const timeout = AbortSignal.timeout(options.startupTimeoutMs ?? 120000);
    const bounded = AbortSignal.any([signal, timeout]);
    try {
      bounded.throwIfAborted();
      const env = { ...options.environment, NODE_ENV: 'production', SHENSI_SKIP_LOCAL_ENV: 'true',
        CRM_STORE: 'mysql', CRM_SEED_DEVELOPMENT_DATA: 'false', BACKEND_HOST: '127.0.0.1', PORT: String(options.port),
        DOUYIN_OUTREACH_ACTIONS_ENABLED: 'false', DOUYIN_OUTREACH_APPROVALS_ENABLED: 'false',
        DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: 'false', DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: 'false',
        XHS_MODULE_ENABLED: 'false', XHS_DESKTOP_SENDING_ENABLED: 'false',
        PROSPECT_WORKER_ENABLED: 'false', PROSPECT_SCHEDULER_ENABLED: 'false', PROSPECT_QUEUE_REQUIRED: 'false' };
      // Do not allow host Node injection even if mistakenly included by a caller.
      delete (env as Record<string, string>).NODE_OPTIONS;
      delete (env as Record<string, string>).NODE_PATH;
      const child = spawn(options.nodeExecutable, [options.entrypoint], {
        cwd: dirname(options.entrypoint), env, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.#child = child; this.#exited = false;
      this.#exit = new Promise(resolve => {
        const exited = () => { this.#exited = true; this.#ready = false; resolve(); };
        child.once('exit', exited); child.once('error', exited);
      });
      const origin = `http://127.0.0.1:${options.port}`;
      const expectedLine = `GoodJob CRM API listening on ${origin}`;
      let listening = false; let tail = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        tail += chunk;
        const lines = tail.split('\n'); tail = lines.pop()!.slice(-4096);
        if (lines.some(line => line.trimEnd() === expectedLine)) listening = true;
      });
      // Drain output without forwarding potentially private database diagnostics to renderer/logs.
      child.stderr!.resume();
      for (;;) {
        bounded.throwIfAborted();
        if (this.#exited) throw new Error('child_exited');
        if (listening) {
          try {
            const response = await fetch(`${origin}/api/health`, {
              signal: AbortSignal.any([bounded, AbortSignal.timeout(1000)]), redirect: 'error',
            });
            const health = response.ok ? await response.json() : null;
            bounded.throwIfAborted();
            if (health?.ok === true && health.store === 'mysql' && !this.#exited) {
              this.#ready = true; return;
            }
          } catch { /* Startup deadline and child exit are checked each iteration. */ }
        }
        await delay(25, undefined, { signal: bounded });
      }
    } catch {
      await this.#terminate();
      throw new Error(signal.aborted ? 'local_backend_start_cancelled' : 'local_backend_start_failed');
    }
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#ready = false; this.#abort?.abort();
    const stopping = (async () => {
      await this.#starting?.catch(() => undefined);
      await this.#terminate();
    })();
    this.#stopping = stopping;
    void stopping.then(() => { this.#stopping = null; }, () => { this.#stopping = null; });
    return stopping;
  }

  async #terminate(): Promise<void> {
    const child = this.#child; this.#ready = false;
    if (!child) return;
    if (!this.#exited) {
      child.kill('SIGTERM');
      const timeout = this.#options.shutdownTimeoutMs ?? 15000;
      const deadline = Date.now() + timeout;
      while (!this.#exited && Date.now() < deadline) await delay(25);
      // Keep ownership on failure. Never kill a PID discovered from a port or old pidfile.
      if (!this.#exited) throw new Error('local_backend_stop_timeout');
    }
    await this.#exit; this.#child = null;
  }
}
