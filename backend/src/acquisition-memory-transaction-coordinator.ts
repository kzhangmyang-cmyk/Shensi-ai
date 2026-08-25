import { AsyncLocalStorage } from "node:async_hooks";

const tokenOwners = new WeakMap<object, AcquisitionMemoryTransactionCoordinator>();

export type AcquisitionMemoryTransactionToken = Readonly<object>;

export class AcquisitionMemoryTransactionCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<AcquisitionMemoryTransactionToken>();

  transaction<T>(
    work: (token: AcquisitionMemoryTransactionToken) => T | Promise<T>
  ): Promise<T> {
    const active = this.context.getStore();
    if (active && tokenOwners.get(active) === this) return Promise.resolve(work(active));
    const current = this.tail.then(async () => {
      const token = Object.freeze({});
      tokenOwners.set(token, this);
      try {
        return await this.context.run(token, () => work(token));
      } finally {
        tokenOwners.delete(token);
      }
    });
    this.tail = current.then(() => undefined, () => undefined);
    return current;
  }

  assertOwns(token: AcquisitionMemoryTransactionToken) {
    if (tokenOwners.get(token) !== this) {
      throw new Error("acquisition_memory_transaction_token_mismatch");
    }
  }
}
