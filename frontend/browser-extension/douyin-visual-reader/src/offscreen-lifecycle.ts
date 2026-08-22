export function createOffscreenCaptureLifecycle(): {
  begin(epoch: string, generation: number, releaseRaw: () => void): symbol | null;
  active(token: symbol): boolean;
  finish(token: symbol): void;
  synchronize(epoch: string, generation: number): boolean;
  end(epoch: string, generation: number): boolean;
} {
  let currentEpoch: string | null = null;
  let minimumGeneration = 0;
  const inflight = new Map<symbol, { epoch: string; generation: number; releaseRaw: () => void }>();
  const validEpoch = (epoch: string) => /^[A-Za-z0-9_-]{16,128}$/u.test(epoch);
  const releaseWhere = (predicate: (entry: { epoch: string; generation: number }) => boolean) => {
    for (const [token, entry] of inflight) {
      if (!predicate(entry)) continue;
      inflight.delete(token);
      try { entry.releaseRaw(); } catch { /* fail closed; release remaining captures */ }
    }
  };
  return {
    begin(epoch, generation, releaseRaw) {
      if (epoch !== currentEpoch || !Number.isSafeInteger(generation)
        || generation !== minimumGeneration) return null;
      const token = Symbol("offscreen-capture");
      inflight.set(token, { epoch, generation, releaseRaw });
      return token;
    },
    active(token) {
      const entry = inflight.get(token);
      return entry !== undefined && entry.epoch === currentEpoch
        && entry.generation === minimumGeneration;
    },
    finish(token) {
      inflight.delete(token);
    },
    synchronize(epoch, generation) {
      if (!validEpoch(epoch) || !Number.isSafeInteger(generation) || generation < 0) return false;
      if (epoch !== currentEpoch) {
        releaseWhere(() => true);
        currentEpoch = epoch;
        minimumGeneration = generation;
        return true;
      }
      if (generation < minimumGeneration) return false;
      minimumGeneration = generation;
      releaseWhere((entry) => entry.epoch === epoch && entry.generation < generation);
      return true;
    },
    end(epoch, generation) {
      if (epoch !== currentEpoch || !Number.isSafeInteger(generation) || generation < 0) return false;
      minimumGeneration = Math.max(minimumGeneration, generation + 1);
      releaseWhere((entry) => entry.epoch === epoch && entry.generation <= generation);
      return true;
    }
  };
}

export function createSensitiveResourceScope(): {
  track<T extends object>(resource: T, cleanup: (resource: T) => void): T;
  dispose(resource: object): void;
  transfer(resource: object): void;
  disposeAll(): void;
} {
  const cleanups = new Map<object, () => void>();
  return {
    track(resource, cleanup) {
      cleanups.set(resource, () => cleanup(resource));
      return resource;
    },
    dispose(resource) {
      const cleanup = cleanups.get(resource);
      cleanups.delete(resource);
      try { cleanup?.(); } catch { /* continue releasing remaining sensitive resources */ }
    },
    transfer(resource) {
      cleanups.delete(resource);
    },
    disposeAll() {
      for (const resource of [...cleanups.keys()]) this.dispose(resource);
    }
  };
}

export async function runPreparedOcr<Prepared, Result>(options: {
  prepare(): Promise<Prepared>;
  releaseRaw(): void;
  recognize(prepared: Prepared): Promise<Result>;
  releasePrepared(prepared: Prepared): void;
}): Promise<Result> {
  let prepared!: Prepared;
  try {
    prepared = await options.prepare();
  } finally {
    options.releaseRaw();
  }
  try {
    return await options.recognize(prepared);
  } finally {
    options.releasePrepared(prepared);
  }
}
