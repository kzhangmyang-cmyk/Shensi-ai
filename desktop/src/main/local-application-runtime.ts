import { LocalBackendRuntime } from './local-backend-runtime.js';
import { LocalMysqlRuntime } from './local-mysql-runtime.js';
import { LocalServiceLifecycle } from './local-service-lifecycle.js';
import type { LocalInstallationSecrets } from './local-installation-secrets.js';
import { parseLocalInitialAccount, type LocalInitialAccount } from './local-initial-account.js';
import { isAbsolute } from 'node:path';
import { embeddedReferenceEnvironment, type EmbeddedReferencePack } from './embedded-reference-pack.js';

export interface LocalApplicationRuntimeOptions {
  databaseDirectory: string;
  knowledgeDirectory: string;
  mysqlRuntimeDirectory: string;
  nodeExecutable: string;
  backendEntrypoint: string;
  port: number;
  buildDigest: string;
  secrets: LocalInstallationSecrets;
  initialAccount?: LocalInitialAccount;
  embeddedReference?: EmbeddedReferencePack;
}

/** Main-only composition. Never expose database URLs or installation keys through Preload. */
export class LocalApplicationRuntime {
  readonly #lifecycle: LocalServiceLifecycle;
  #backend: LocalBackendRuntime | null = null;
  constructor(input: LocalApplicationRuntimeOptions) {
    if (!/^[a-f0-9]{64}$/u.test(input.buildDigest)) throw new Error('local_application_build_identity_invalid');
    const options = structuredClone(input);
    const initialAccount = options.initialAccount === undefined ? undefined : parseLocalInitialAccount(options.initialAccount);
    if (!isAbsolute(options.knowledgeDirectory ?? '')) throw new Error('local_application_knowledge_directory_invalid');
    const referenceEnvironment = embeddedReferenceEnvironment(options.embeddedReference);
    const database = new LocalMysqlRuntime({ directory: options.databaseDirectory,
      runtimeDirectory: options.mysqlRuntimeDirectory, rootPassword: options.secrets.mysqlRootPassword,
      appPassword: options.secrets.mysqlAppPassword });
    this.#lifecycle = new LocalServiceLifecycle({ database, backend: {
      start: async signal => {
        const origin = `http://127.0.0.1:${options.port}`;
        this.#backend = new LocalBackendRuntime({ nodeExecutable: options.nodeExecutable,
          entrypoint: options.backendEntrypoint, port: options.port,
          environment: { ...options.secrets.backend, ...referenceEnvironment, DATABASE_URL: database.databaseUrl,
            SHENSI_KNOWLEDGE_STORAGE_ROOT: options.knowledgeDirectory,
            CORS_ORIGINS: origin, SESSION_COOKIE_SECURE: 'false', TRUSTED_PROXY_CIDRS: '', SHENSI_API_GATEWAY_IP: '',
            SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: 'exact', SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: options.buildDigest,
            INITIAL_ADMIN_EMAIL: initialAccount ? `${initialAccount.account}@shensi.local` : 'bootstrap@shensi.local',
            INITIAL_ADMIN_PASSWORD: initialAccount?.password ?? options.secrets.bootstrapPassword,
            SHENSI_LOCAL_INITIAL_ACCOUNT: initialAccount ? 'true' : 'false',
            INITIAL_ADMIN_NAME: initialAccount?.account ?? 'Local Bootstrap', REDIS_URL: '', ENABLE_API_DOCS: 'false' } });
        await this.#backend.start(signal);
      },
      stop: async () => { await this.#backend?.stop(); this.#backend = null; },
    } });
  }
  get origin(): string {
    if (this.#lifecycle.getState() !== 'ready' || !this.#backend) throw new Error('local_application_not_ready');
    return this.#backend.origin;
  }
  start(): Promise<void> { return this.#lifecycle.start(); }
  stop(): Promise<void> { return this.#lifecycle.stop(); }
}
