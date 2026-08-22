import type {
  AiJobModelSnapshot,
  ModelConnection,
  StoredAiJobModelSnapshot
} from "./types.js";

interface JobSnapshotVersions {
  promptVersion: string;
  schemaVersion: string;
}

export function createAiJobModelSnapshot(
  connection: ModelConnection,
  credentialVersion: number,
  versions: JobSnapshotVersions
): AiJobModelSnapshot {
  const capabilitySnapshot = Object.freeze({
    ...connection.capabilitySnapshot
  });
  return Object.freeze({
    connectionId: connection.id,
    credentialVersion,
    provider: connection.provider,
    model: connection.model,
    capabilitySnapshot,
    promptVersion: versions.promptVersion,
    schemaVersion: versions.schemaVersion
  });
}

export function appendStoredAiJobModelSnapshot(
  history: StoredAiJobModelSnapshot[],
  pending: StoredAiJobModelSnapshot[],
  snapshot: StoredAiJobModelSnapshot
) {
  history.push(snapshot);
  pending.push(snapshot);
  return snapshot;
}
