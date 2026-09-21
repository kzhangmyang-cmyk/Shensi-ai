export interface SingleInstanceApplicationOptions {
  requestSingleInstanceLock(): boolean;
  whenReady(): Promise<unknown>;
  start(): Promise<void>;
  quit(): void;
  onFailure(error: unknown): void;
}

export function launchSingleInstanceApplication(
  options: SingleInstanceApplicationOptions,
): boolean {
  if (!options.requestSingleInstanceLock()) {
    options.quit();
    return false;
  }
  void options.whenReady()
    .then(() => options.start())
    .catch((error: unknown) => {
      try { options.onFailure(error); }
      finally { options.quit(); }
    });
  return true;
}
