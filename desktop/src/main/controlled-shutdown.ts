export interface SignalBoundary {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function installControlledQuitSignalHandlers(
  source: SignalBoundary,
  requestQuit: () => void,
): () => void {
  let requested = false;
  const onSignal = () => {
    if (requested) return;
    requested = true;
    requestQuit();
  };
  source.once("SIGINT", onSignal);
  source.once("SIGTERM", onSignal);
  return () => {
    source.removeListener("SIGINT", onSignal);
    source.removeListener("SIGTERM", onSignal);
  };
}

export async function stopDesktopServices(services: {
  coordinator: { stop(): Promise<void> };
  sidecar: { stop(): Promise<unknown> };
  renderer: { close(): Promise<void> };
  local?: {
    backend: { stop(): Promise<void> };
    database: { stop(): Promise<void> };
  };
}): Promise<void> {
  let failed = false;
  // Keep the Sidecar alive while the coordinator saves/uploads its last receipt.
  const stops = [() => services.coordinator.stop(), () => services.sidecar.stop(), () => services.renderer.close()];
  const local = services.local;
  // Keep persistence available until desktop receipts and API work have drained.
  if (local) stops.push(() => local.backend.stop(), () => local.database.stop());
  for (const stop of stops) {
    try { await stop(); } catch { failed = true; }
  }
  if (failed) throw new Error("desktop_shutdown_failed");
}
