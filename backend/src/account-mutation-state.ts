// In-flight identity changes are never usable before durable commit.
const pending = new Map<string, number>();
export function isAccountMutationPending(id: string) { return pending.has(id); }
export function beginAccountMutation(id: string) {
  pending.set(id, (pending.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (pending.get(id) ?? 1) - 1;
    if (count === 0) pending.delete(id); else pending.set(id, count);
  };
}

const platformPending = new WeakMap<object, number>();
export function isPlatformMutationPending(store: object) { return (platformPending.get(store) ?? 0) > 0; }
export function beginPlatformMutation(store: object) {
  platformPending.set(store, (platformPending.get(store) ?? 0) + 1);
  let released = false;
  return () => { if (!released) { released = true; const count = (platformPending.get(store) ?? 1) - 1; if (count) platformPending.set(store, count); else platformPending.delete(store); } };
}
