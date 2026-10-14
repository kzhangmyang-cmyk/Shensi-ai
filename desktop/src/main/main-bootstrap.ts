export interface SingleInstanceApplicationOptions {
  requestSingleInstanceLock(): boolean;
  whenReady(): Promise<unknown>;
  start(): Promise<void>;
  quit(): void;
  onFailure(error: unknown): void;
}

/** Startup may close setup before the business window exists. Explicit app.quit still works. */
export function keepApplicationAliveBetweenWindows(application: {
  on(event: 'window-all-closed', listener: () => void): unknown;
}): void {
  application.on('window-all-closed', () => {});
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
