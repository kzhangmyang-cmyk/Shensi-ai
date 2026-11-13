import { readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { SafeStorage } from './device-credential-store.js';
import { ensurePrivateDirectory, isMissing } from './private-storage.js';
import { createLocalInstallationSecretStore } from './local-installation-secrets.js';
import { LocalApplicationRuntime } from './local-application-runtime.js';
import { parseLocalInitialAccount, type LocalInitialAccount } from './local-initial-account.js';
import type { EmbeddedReferencePack } from './embedded-reference-pack.js';

export async function prepareLocalApplication(options: {
  userData: string; mysqlRuntimeDirectory: string; nodeExecutable: string;
  backendEntrypoint: string; buildDigest: string; safeStorage: SafeStorage;
  embeddedReference?: EmbeddedReferencePack;
  requestInitialAccount?: () => Promise<LocalInitialAccount | null>;
}): Promise<LocalApplicationRuntime> {
  await ensurePrivateDirectory(options.userData);
  const databaseDirectory = join(options.userData, 'database');
  let empty = false;
  try { empty = (await readdir(databaseDirectory)).length === 0; }
  catch (error) { if (!isMissing(error)) throw error; empty = true; }
  const secrets = await createLocalInstallationSecretStore({ directory: join(options.userData, 'local-secrets'),
    safeStorage: options.safeStorage }).loadOrCreate(empty);
  const initialAccount = empty ? await options.requestInitialAccount?.() : undefined;
  if (empty && !initialAccount) throw new Error('local_initial_setup_cancelled');
  if (initialAccount) parseLocalInitialAccount(initialAccount);
  await access(options.nodeExecutable, constants.X_OK);
  await access(options.backendEntrypoint, constants.R_OK);
  await access(join(options.mysqlRuntimeDirectory, 'bin/mysqld'), constants.X_OK);
  await access(join(options.mysqlRuntimeDirectory, 'bin/mysql'), constants.X_OK);
  const knowledgeDirectory = join(options.userData, 'knowledge');
  await ensurePrivateDirectory(knowledgeDirectory);
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address();
  await new Promise<void>(resolve => listener.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('local_application_port_unavailable');
  return new LocalApplicationRuntime({ databaseDirectory, knowledgeDirectory, secrets, port: address.port,
    mysqlRuntimeDirectory: options.mysqlRuntimeDirectory, nodeExecutable: options.nodeExecutable,
    backendEntrypoint: options.backendEntrypoint, buildDigest: options.buildDigest,
    ...(options.embeddedReference ? { embeddedReference: options.embeddedReference } : {}),
    ...(initialAccount ? { initialAccount } : {}) });
}
