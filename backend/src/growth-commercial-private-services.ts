export interface GrowthPrivateServiceKey<T> {
  readonly id: symbol;
  readonly description: string;
  readonly __value?: T;
}

export interface GrowthPrivateServiceRegistry {
  provide<T>(key: GrowthPrivateServiceKey<T>, value: T): void;
  require<T>(key: GrowthPrivateServiceKey<T>): T;
  get<T>(key: GrowthPrivateServiceKey<T>): T | null;
}

export function defineGrowthPrivateServiceKey<T>(
  description: string
): GrowthPrivateServiceKey<T> {
  const normalized = description.trim();
  if (!normalized) throw new Error("INVALID_GROWTH_PRIVATE_SERVICE_KEY");
  return Object.freeze({
    id: Symbol(normalized),
    description: normalized
  });
}

export function createGrowthPrivateServiceRegistry():
GrowthPrivateServiceRegistry {
  const values = new Map<symbol, unknown>();
  return Object.freeze({
    provide<T>(key: GrowthPrivateServiceKey<T>, value: T) {
      if (values.has(key.id)) {
        throw new Error(
          `DUPLICATE_GROWTH_PRIVATE_SERVICE:${key.description}`
        );
      }
      values.set(key.id, value);
    },
    require<T>(key: GrowthPrivateServiceKey<T>): T {
      if (!values.has(key.id)) {
        throw new Error(
          `MISSING_GROWTH_PRIVATE_SERVICE:${key.description}`
        );
      }
      return values.get(key.id) as T;
    },
    get<T>(key: GrowthPrivateServiceKey<T>): T | null {
      return values.has(key.id) ? values.get(key.id) as T : null;
    }
  });
}
