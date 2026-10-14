/** Drivers own their processes and must honour startup cancellation.
 * This controller neither discovers nor terminates unrelated host services. */
export interface LocalManagedService {
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

export type LocalServiceState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';

export class LocalServiceLifecycle {
  #state: LocalServiceState = 'stopped';
  #abort: AbortController | null = null;
  #starting: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;
  #attempted: LocalManagedService[] = [];

  constructor(private readonly services: {
    database: LocalManagedService;
    backend: LocalManagedService;
  }) {}

  getState(): LocalServiceState { return this.#state; }

  start(): Promise<void> {
    if (this.#state === 'failed') return Promise.reject(new Error('local_services_cleanup_required'));
    if (this.#state !== 'stopped' || this.#starting || this.#stopping)
      return Promise.reject(new Error('local_services_already_started'));
    this.#state = 'starting';
    const abort = new AbortController();
    this.#abort = abort;
    const starting = this.#launch(abort);
    this.#starting = starting;
    // Register both outcomes without creating an unhandled rejected finally promise.
    void starting.then(() => { this.#starting = null; }, () => { this.#starting = null; });
    return starting;
  }

  async #launch(abort: AbortController): Promise<void> {
    try {
      for (const service of [this.services.database, this.services.backend]) {
        if (abort.signal.aborted) throw new Error('cancelled');
        this.#attempted.push(service);
        await service.start(abort.signal);
      }
      if (abort.signal.aborted) throw new Error('cancelled');
      this.#state = 'ready';
    } catch {
      await this.#cleanup();
      throw new Error(abort.signal.aborted ? 'local_services_start_cancelled' : 'local_services_start_failed');
    }
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    if (this.#state === 'failed') return Promise.reject(new Error('local_services_cleanup_required'));
    if (this.#state === 'stopped' && !this.#starting) return Promise.resolve();
    this.#state = 'stopping';
    this.#abort?.abort();
    const stopping = (async () => {
      // Startup owns cleanup on cancellation; do not race it with another stop.
      await this.#starting?.catch(() => undefined);
      if (this.#state !== 'failed') await this.#cleanup();
      if (this.#state === 'failed') throw new Error('local_services_stop_failed');
    })();
    this.#stopping = stopping;
    void stopping.then(() => { this.#stopping = null; }, () => { this.#stopping = null; });
    return stopping;
  }

  async #cleanup(): Promise<void> {
    const failed: LocalManagedService[] = [];
    for (const service of [...this.#attempted].reverse()) {
      try { await service.stop(); } catch { failed.unshift(service); }
    }
    this.#attempted = failed;
    this.#state = failed.length ? 'failed' : 'stopped';
  }
}
