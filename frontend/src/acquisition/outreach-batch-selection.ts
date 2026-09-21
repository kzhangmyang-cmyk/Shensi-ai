export const LAST_OUTREACH_BATCH_KEY = "shensi:acquisition:last-outreach-batch";

export interface OutreachBatchSelectionStore {
  read(): string | null;
  remember(batchId: string): void;
  clear(): void;
  subscribe(listener: (batchId: string | null) => void): () => void;
}

type BatchSelectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserSessionStorage(): BatchSelectionStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function createOutreachBatchSelectionStore(
  storage: BatchSelectionStorage | null = browserSessionStorage()
): OutreachBatchSelectionStore {
  const listeners = new Set<(batchId: string | null) => void>();
  const broadcast = (batchId: string | null) => {
    listeners.forEach((listener) => listener(batchId));
  };
  return {
    read() {
      try {
        const batchId = storage?.getItem(LAST_OUTREACH_BATCH_KEY)?.trim() ?? "";
        return batchId || null;
      } catch {
        return null;
      }
    },
    remember(batchId) {
      const normalized = batchId.trim();
      if (!normalized || !storage) return;
      try {
        storage.setItem(LAST_OUTREACH_BATCH_KEY, normalized);
      } catch {
        return;
      }
      broadcast(normalized);
    },
    clear() {
      if (!storage) return;
      try {
        storage.removeItem(LAST_OUTREACH_BATCH_KEY);
      } catch {
        return;
      }
      broadcast(null);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export const outreachBatchSelection = createOutreachBatchSelectionStore();
