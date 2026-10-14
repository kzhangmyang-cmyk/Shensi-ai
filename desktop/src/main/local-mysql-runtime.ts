import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { readdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ensurePrivateDirectory, readPrivateFile, writePrivateFile, removePrivateFile } from './private-storage.js';
import type { LocalManagedService } from './local-service-lifecycle.ts';

export interface LocalMysqlRuntimeOptions {
  directory: string;
  runtimeDirectory: string;
  rootPassword: string;
  appPassword: string;
}

/** macOS native MySQL, socket-only; never attaches to a host database or recreates partial data. */
export class LocalMysqlRuntime implements LocalManagedService {
  readonly #options: LocalMysqlRuntimeOptions;
  #child: ChildProcess | null = null;
  #exited = true;
  #exitCode: number | null = null;
  #ready = false;
  #starting: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;
  #abort: AbortController | null = null;
  #socketDirectory: string | null = null;
  constructor(options: LocalMysqlRuntimeOptions) {
    if (process.platform !== 'darwin') throw new Error('local_mysql_platform_unsupported');
    if (![options.directory, options.runtimeDirectory].every(value => isAbsolute(value) && !/[\r\n\0]/u.test(value))
      || ![options.rootPassword, options.appPassword].every(value => /^[a-f0-9]{64}$/u.test(value))
      || options.rootPassword === options.appPassword) throw new Error('local_mysql_configuration_invalid');
    this.#options = { ...options };
  }

  get databaseUrl(): string {
    if (!this.#ready || this.#exited) throw new Error('local_mysql_not_ready');
    return `mysql://shensi_app:${this.#options.appPassword}@localhost/shensi_desktop?socketPath=${encodeURIComponent(this.#socket)}`;
  }
  get #socket(): string {
    if (!this.#socketDirectory) throw new Error('local_mysql_socket_unavailable');
    return join(this.#socketDirectory, 'mysql.sock');
  }

  start(signal: AbortSignal): Promise<void> {
    if (this.#child || this.#starting || this.#stopping) return Promise.reject(new Error('local_mysql_already_started'));
    const abort = new AbortController(); this.#abort = abort;
    const cancel = () => abort.abort(); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) abort.abort();
    const starting = this.#launch(abort.signal); this.#starting = starting;
    const finish = () => { this.#starting = null; signal.removeEventListener('abort', cancel); };
    void starting.then(finish, finish); return starting;
  }

  #spawn(extra: string[]): void {
    const options = this.#options;
    const child = spawn(join(options.runtimeDirectory, 'bin/mysqld'), [
      '--no-defaults', `--basedir=${options.runtimeDirectory}`, `--datadir=${join(options.directory, 'data')}`, ...extra,
    ], { shell: false, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: options.directory } });
    this.#child = child; this.#exited = false; this.#exitCode = null;
    child.once('error', () => { this.#exited = true; this.#ready = false; this.#exitCode = -1; });
    child.once('exit', code => { this.#exited = true; this.#ready = false; this.#exitCode = code; });
  }

  async #sql(user: 'root' | 'shensi_app', password: string, sql: string, signal: AbortSignal): Promise<void> {
    const directory = this.#options.directory;
    const quote = (value: string) => `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
    await writePrivateFile(directory, 'client.cnf', `[client]\nuser=${user}\npassword=${quote(password)}\nsocket=${quote(this.#socket)}\nprotocol=SOCKET\n`);
    try {
      // SQL/passwords stay out of argv and logs. A private option file is removed after each call.
      const child = execFile(join(this.#options.runtimeDirectory, 'bin/mysql'),
        [`--defaults-file=${join(directory, 'client.cnf')}`, '--batch', '--skip-column-names'],
        { signal, timeout: 5000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
      await new Promise<void>((resolve, reject) => {
        child.once('error', () => { /* close follows both spawn failure and cancellation; retain the option file until then. */ });
        child.once('close', code => code === 0 ? resolve() : reject(new Error('local_mysql_query_failed')));
        child.stdin!.on('error', () => {});
        child.stdin!.end(sql);
      });
    } finally { await removePrivateFile(directory, 'client.cnf'); }
  }

  async #launch(signal: AbortSignal): Promise<void> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    const options = this.#options;
    try {
      bounded.throwIfAborted();
      await ensurePrivateDirectory(options.directory);
      const marker = await readPrivateFile(options.directory, 'initialization.json');
      const fresh = marker === null;
      if (fresh) {
        if ((await readdir(options.directory)).length) throw new Error('local_mysql_directory_not_empty');
        if (!await writePrivateFile(options.directory, 'initialization.json', '{"version":1,"state":"initializing"}', true))
          throw new Error('local_mysql_initialization_conflict');
        this.#spawn(['--initialize-insecure']);
        while (!this.#exited) { bounded.throwIfAborted(); await delay(50, undefined, { signal: bounded }); }
        if (this.#exitCode !== 0) throw new Error('local_mysql_initialization_failed');
        this.#child = null;
      } else if (marker !== '{"version":1,"state":"ready"}') throw new Error('local_mysql_initialization_incomplete');
      bounded.throwIfAborted();
      // macOS userData/TMPDIR can exceed sockaddr_un's limit. Only the ephemeral
      // socket uses this short, randomly named 0700 directory; data never moves.
      this.#socketDirectory = await mkdtemp(join(await realpath('/tmp'), 'shensi-db-'));
      await ensurePrivateDirectory(this.#socketDirectory);
      if (Buffer.byteLength(this.#socket) > 100) throw new Error('local_mysql_socket_path_too_long');
      bounded.throwIfAborted();
      this.#spawn(['--skip-networking', '--mysqlx=OFF', '--default-time-zone=+00:00', `--socket=${this.#socket}`,
        `--pid-file=${join(options.directory, 'mysql.pid')}`, `--log-error=${join(options.directory, 'mysql.log')}`]);
      for (;;) {
        bounded.throwIfAborted();
        if (this.#exited) throw new Error('local_mysql_start_failed');
        try { await this.#sql('root', fresh ? '' : options.rootPassword, 'SELECT 1;', bounded); break; }
        catch { await delay(100, undefined, { signal: bounded }); }
      }
      if (fresh) {
        await this.#sql('root', '', `CREATE DATABASE shensi_desktop;
CREATE USER 'shensi_app'@'localhost' IDENTIFIED BY '${options.appPassword}';
GRANT ALL PRIVILEGES ON shensi_desktop.* TO 'shensi_app'@'localhost';
ALTER USER 'root'@'localhost' IDENTIFIED BY '${options.rootPassword}';`, bounded);
      }
      try { await this.#sql('shensi_app', options.appPassword, 'USE shensi_desktop; SELECT 1;', bounded); }
      catch { throw new Error('local_mysql_credentials_invalid'); }
      bounded.throwIfAborted();
      if (this.#exited) throw new Error('local_mysql_start_failed');
      if (fresh) await writePrivateFile(options.directory, 'initialization.json', '{"version":1,"state":"ready"}');
      this.#ready = true;
    } catch (error) {
      await this.#terminate();
      if (signal.aborted) throw new Error('local_mysql_start_cancelled');
      if (error instanceof Error && /^local_mysql_/u.test(error.message)) throw error;
      throw new Error('local_mysql_start_failed');
    }
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#ready = false; this.#abort?.abort();
    const stopping = (async () => { await this.#starting?.catch(() => undefined); await this.#terminate(); })();
    this.#stopping = stopping;
    void stopping.then(() => { this.#stopping = null; }, () => { this.#stopping = null; });
    return stopping;
  }
  async #terminate(): Promise<void> {
    this.#ready = false;
    if (this.#child && !this.#exited) this.#child.kill('SIGTERM');
    const deadline = Date.now() + 15000;
    while (!this.#exited && Date.now() < deadline) await delay(50);
    if (!this.#exited) throw new Error('local_mysql_stop_timeout');
    this.#child = null;
    if (this.#socketDirectory) {
      await ensurePrivateDirectory(this.#socketDirectory);
      await rm(this.#socketDirectory, { recursive: true });
      this.#socketDirectory = null;
    }
  }
}
