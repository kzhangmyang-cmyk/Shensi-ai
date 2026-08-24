const tokenOwners = new WeakMap<object, AcquisitionMemoryTransactionCoordinator>();

export type AcquisitionMemoryTransactionToken = Readonly<object>;

export class AcquisitionMemoryTransactionCoordinator {
  private tail: Promise<void> = Promise.resolve();

  transaction<T>(
    work: (token: AcquisitionMemoryTransactionToken) => T | Promise<T>
  ): Promise<T> {
    const current = this.tail.then(async () => {
      const token = Object.freeze({});
      tokenOwners.set(token, this);
      try {
        return await work(token);
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
