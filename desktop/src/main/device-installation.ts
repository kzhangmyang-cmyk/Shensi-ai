import { randomBytes } from "node:crypto";
import { exactObject, parsePrivateJson, readPrivateFile, serialized, storageDirectory, storageError, writePrivateFile } from "./private-storage.js";

export interface DeviceInstallationStore { getOrCreateInstallationId(): Promise<string>; }

export function createProcessInstanceId(): string { return randomBytes(32).toString("base64url"); }

export function createDeviceInstallationStore(directory: string): DeviceInstallationStore {
  storageDirectory(directory);
  return { getOrCreateInstallationId: () => serialized(directory, async () => {
    let contents = await readPrivateFile(directory, "installation.json");
    if (contents === null) {
      const value = { installationId: randomBytes(32).toString("base64url"), protocolVersion: 1 };
      await writePrivateFile(directory, "installation.json", `${JSON.stringify(value)}\n`, true);
      contents = await readPrivateFile(directory, "installation.json");
    }
    const value = exactObject(parsePrivateJson(contents!), ["installationId", "protocolVersion"]);
    if (value.protocolVersion !== 1 || typeof value.installationId !== "string"
      || !/^[A-Za-z0-9_-]{43}$/u.test(value.installationId)
      || Buffer.from(value.installationId, "base64url").toString("base64url") !== value.installationId) throw storageError();
    return value.installationId;
  }) };
}
