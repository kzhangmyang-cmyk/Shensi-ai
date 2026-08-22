export function createVisualTransitionBarrier(): {
  schedule<T>(operation: () => Promise<T>): Promise<T>;
  invalidatePending(): number;
  currentRevision(): number;
  isCurrent(revision: number): boolean;
  whenSettled(): Promise<void>;
} {
  let tail: Promise<void> = Promise.resolve();
  let revision = 0;
  return {
    schedule(operation) {
      const result = tail.then(operation);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    invalidatePending() {
      revision += 1;
      return revision;
    },
    currentRevision() {
      return revision;
    },
    isCurrent(candidate) {
      return candidate === revision;
    },
    whenSettled() {
      return tail;
    }
  };
}
