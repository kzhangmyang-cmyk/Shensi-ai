import { randomBytes } from 'node:crypto';
import type { SafeStorage } from './device-credential-store.js';
import { exactObject, parsePrivateJson, readPrivateFile, serialized, storageDirectory,
  storageError, writePrivateFile } from './private-storage.js';

export const LOCAL_BACKEND_SECRET_NAMES = [
  'JWT_SECRET', 'PROVIDER_CREDENTIAL_KEY', 'AGENT_JOB_ENCRYPTION_KEY', 'ACQUISITION_MASTER_SECRET',
  'ACQUISITION_V1_CURSOR_SECRET', 'TRADE_OBSERVATION_CURSOR_SECRET', 'MARKET_OPPORTUNITY_CURSOR_SECRET',
  'PROSPECT_RUN_IDEMPOTENCY_SECRET', 'PROSPECT_RUN_CURSOR_SECRET', 'PROSPECT_EXECUTION_CLAIM_SECRET',
  'ORGANIZATION_IDENTITY_MASTER_SECRET', 'PROSPECT_SOURCE_RAW_ENVELOPE_SECRET', 'PROSPECT_COVERAGE_MASTER_SECRET',
] as const;

export interface LocalInstallationSecrets {
  version: 1;
  mysqlRootPassword: string;
  mysqlAppPassword: string;
  bootstrapPassword: string;
  backend: Record<typeof LOCAL_BACKEND_SECRET_NAMES[number], string>;
}

function validate(input: unknown): LocalInstallationSecrets {
  const value = exactObject(input, ['version', 'mysqlRootPassword', 'mysqlAppPassword', 'bootstrapPassword', 'backend']);
  const backend = exactObject(value.backend, LOCAL_BACKEND_SECRET_NAMES);
  const secrets = [value.mysqlRootPassword, value.mysqlAppPassword, value.bootstrapPassword, ...Object.values(backend)];
  if (value.version !== 1 || secrets.some(secret => typeof secret !== 'string' || !/^[a-f0-9]{64}$/u.test(secret))
    || new Set(secrets).size !== secrets.length) throw storageError();
  return value as unknown as LocalInstallationSecrets;
}

/** Main-only installation credentials. Missing credentials for an existing DB must fail closed. */
export function createLocalInstallationSecretStore({ directory, safeStorage }: {
  directory: string; safeStorage: SafeStorage;
}) {
  storageDirectory(directory);
  return { loadOrCreate: (allowCreate: boolean): Promise<LocalInstallationSecrets> => serialized(directory, async () => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('local_installation_encryption_unavailable');
    const stored = await readPrivateFile(directory, 'installation.json');
    if (stored !== null) {
      const envelope = exactObject(parsePrivateJson(stored), ['version', 'ciphertext']);
      if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string' || !envelope.ciphertext) throw storageError();
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
      if (ciphertext.toString('base64') !== envelope.ciphertext) throw storageError();
      let plaintext: string;
      try { plaintext = safeStorage.decryptString(ciphertext); }
      catch { throw new Error('local_installation_decryption_failed'); }
      return validate(parsePrivateJson(plaintext));
    }
    if (!allowCreate) throw new Error('local_installation_secrets_missing');
    const secret = () => randomBytes(32).toString('hex');
    const value = validate({ version: 1, mysqlRootPassword: secret(), mysqlAppPassword: secret(), bootstrapPassword: secret(),
      backend: Object.fromEntries(LOCAL_BACKEND_SECRET_NAMES.map(name => [name, secret()])) });
    let ciphertext: Buffer;
    try { ciphertext = safeStorage.encryptString(JSON.stringify(value)); }
    catch { throw new Error('local_installation_encryption_failed'); }
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) throw storageError();
    if (!await writePrivateFile(directory, 'installation.json',
      JSON.stringify({ version: 1, ciphertext: ciphertext.toString('base64') }), true))
      throw new Error('local_installation_creation_conflict');
    return value;
  }) };
}
