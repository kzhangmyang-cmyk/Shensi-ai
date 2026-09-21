import { createHash } from "node:crypto";
import { exactObject, parsePrivateJson, positiveVersion, privateFileNames, readPrivateFile, removePrivateFile, safeIdentifier, serialized, storageDirectory, storageError, writePrivateFile } from "./private-storage.js";

// These types stay private to Electron Main; none are part of Preload's API.
export interface DesktopBindingReference { accountId: string; bindingGeneration: number; }
export interface DesktopWorkspaceCredential {
  workspaceId: string; deviceToken: string; protocolVersion: 1; bindings: DesktopBindingReference[];
}
export interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export interface DeviceCredentialStore {
  registeredWorkspaceIds(): Promise<string[]>;
  save(value: DesktopWorkspaceCredential): Promise<void>;
  load(workspaceId: string): Promise<DesktopWorkspaceCredential | null>;
  recordBinding(workspaceId: string, binding: DesktopBindingReference): Promise<void>;
  remove(workspaceId: string): Promise<void>;
}

function binding(value: unknown): DesktopBindingReference {
  const data = exactObject(value, ["accountId", "bindingGeneration"]);
  return { accountId: safeIdentifier(data.accountId), bindingGeneration: positiveVersion(data.bindingGeneration) };
}
function credential(value: unknown): DesktopWorkspaceCredential {
  const data = exactObject(value, ["workspaceId", "deviceToken", "protocolVersion", "bindings"]);
  if (data.protocolVersion !== 1 || typeof data.deviceToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(data.deviceToken)
    || !Array.isArray(data.bindings) || data.bindings.length > 100) throw storageError();
  const bindings = data.bindings.map(binding).sort((a, b) => a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0);
  if (new Set(bindings.map((value) => value.accountId)).size !== bindings.length) throw storageError();
  return { workspaceId: safeIdentifier(data.workspaceId), deviceToken: data.deviceToken, protocolVersion: 1, bindings };
}
const filename = (workspaceId: string) => `${createHash("sha256").update(`shensi-desktop-workspace-credential\0${safeIdentifier(workspaceId)}`, "utf8").digest("hex")}.json`;

export function createDeviceCredentialStore({ directory, safeStorage }: { directory: string; safeStorage: SafeStorage }): DeviceCredentialStore {
  storageDirectory(directory);
  const available = () => { if (!safeStorage.isEncryptionAvailable()) throw new Error("desktop_credential_encryption_unavailable"); };
  async function loadFile(name: string): Promise<DesktopWorkspaceCredential | null> {
    available();
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw storageError();
    const text = await readPrivateFile(directory, name);
    if (text === null) return null;
    const envelope = exactObject(parsePrivateJson(text), ["version", "ciphertext"]);
    if (envelope.version !== 1 || typeof envelope.ciphertext !== "string" || envelope.ciphertext.length === 0) throw storageError();
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    if (ciphertext.toString("base64") !== envelope.ciphertext) throw storageError();
    let plaintext: string;
    try { plaintext = safeStorage.decryptString(ciphertext); } catch { throw new Error("desktop_credential_decryption_failed"); }
    const value = credential(parsePrivateJson(plaintext));
    if (filename(value.workspaceId) !== name || JSON.stringify(value) !== plaintext) throw storageError();
    return value;
  }
  const load = (workspaceId: string) => loadFile(filename(workspaceId));
  async function save(input: DesktopWorkspaceCredential): Promise<void> {
    available(); const value = credential(input);
    let encrypted: Buffer;
    try { encrypted = safeStorage.encryptString(JSON.stringify(value)); } catch { throw new Error("desktop_credential_encryption_failed"); }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw storageError();
    await writePrivateFile(directory, filename(value.workspaceId), `${JSON.stringify({ version: 1, ciphertext: encrypted.toString("base64") })}\n`);
  }
  return {
    registeredWorkspaceIds: () => serialized(directory, async () => {
      available();
      const ids: string[] = [];
      for (const name of await privateFileNames(directory)) {
        const value = await loadFile(name);
        if (value === null) throw storageError();
        ids.push(value.workspaceId);
      }
      return ids.sort();
    }),
    save: (value) => serialized(directory, () => save(value)),
    load: (workspaceId) => serialized(directory, () => load(workspaceId)),
    recordBinding: (workspaceId, input) => serialized(directory, async () => {
      const update = binding(input); const current = await load(workspaceId);
      if (current === null) throw new Error("desktop_credential_missing");
      const prior = current.bindings.find((value) => value.accountId === update.accountId);
      if (prior && prior.bindingGeneration > update.bindingGeneration) throw new Error("desktop_binding_generation_conflict");
      current.bindings = [...current.bindings.filter((value) => value.accountId !== update.accountId), update];
      await save(current);
    }),
    remove: (workspaceId) => serialized(directory, () => removePrivateFile(directory, filename(workspaceId)))
  };
}
