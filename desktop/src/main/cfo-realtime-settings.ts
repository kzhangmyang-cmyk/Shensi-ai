import { createHash } from 'node:crypto';
import type { SafeStorage } from './device-credential-store.ts';
import { readPrivateFile, writePrivateFile, removePrivateFile, serialized, exactObject } from './private-storage.ts';
import { normalizeVoiceSettings, type VoiceSettingsInput } from '../shared/cfo-realtime.ts';

export interface VoiceScope { workspaceId: string; actorId: string; }
export function voiceScopeKey(scope: VoiceScope): string {
  if (![scope.workspaceId, scope.actorId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(value))) throw new Error('voice_input_invalid');
  return createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.actorId])).digest('hex');
}
export function validateVoiceSettings(raw: unknown): VoiceSettingsInput {
  return normalizeVoiceSettings(raw);
}
export function createCfoRealtimeSettingsStore(options: { directory: string; safeStorage: SafeStorage }) {
  const { directory, safeStorage } = options;
  const available = () => { if (!safeStorage.isEncryptionAvailable()) throw new Error('voice_storage_unavailable'); };
  return {
    load: (scope: VoiceScope): Promise<VoiceSettingsInput | null> => serialized(directory, async () => {
      available(); const name = voiceScopeKey(scope);
      try {
        const raw = await readPrivateFile(directory, `${name}.json`); if (raw === null) return null;
        const envelope = exactObject(JSON.parse(raw), ['version', 'ciphertext']);
        if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string') throw new Error();
        const record = exactObject(JSON.parse(safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'))), ['scope', 'settings']);
        if (record.scope !== name) throw new Error();
        return validateVoiceSettings(record.settings);
      } catch { throw new Error('voice_storage_unavailable'); }
    }),
    save: (scope: VoiceScope, raw: unknown) => serialized(directory, async () => {
      const settings = validateVoiceSettings(raw); const name = voiceScopeKey(scope); available();
      try {
        const ciphertext = safeStorage.encryptString(JSON.stringify({ scope: name, settings })).toString('base64');
        if (!ciphertext) throw new Error();
        await writePrivateFile(directory, `${name}.json`, JSON.stringify({ version: 1, ciphertext }));
      } catch { throw new Error('voice_storage_unavailable'); }
    }),
    remove: (scope: VoiceScope) => serialized(directory, async () => {
      try { await removePrivateFile(directory, `${voiceScopeKey(scope)}.json`); }
      catch { throw new Error('voice_storage_unavailable'); }
    })
  };
}
export type VoiceSettingsStore = ReturnType<typeof createCfoRealtimeSettingsStore>;
