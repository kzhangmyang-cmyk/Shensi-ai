export function invalidateCoordinatorOwnership<T>(ownership: {
  current: T | null;
  generation: number;
}): T | null {
  const target = ownership.current;
  ownership.current = null;
  ownership.generation += 1;
  return target;
}
