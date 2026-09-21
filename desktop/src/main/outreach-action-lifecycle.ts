import type { ConnectorStatus } from "../shared/contracts.ts";
import type { SidecarClient } from "./sidecar-client.ts";

type ActionClient = Pick<SidecarClient, "resolveDouyinIdentity" | "executeDouyinAction" | "reconcileDouyinAction" | "acknowledgeDouyinAction">;

export function sidecarActionPort(manager: { readonly client: ActionClient | null }): ActionClient {
  const current = () => {
    if (!manager.client) throw new Error("sidecar_unavailable");
    return manager.client;
  };
  return {
    resolveDouyinIdentity: async (...args) => current().resolveDouyinIdentity(...args),
    executeDouyinAction: async (...args) => current().executeDouyinAction(...args),
    reconcileDouyinAction: async (...args) => current().reconcileDouyinAction(...args),
    acknowledgeDouyinAction: async (...args) => current().acknowledgeDouyinAction(...args),
  };
}

/** The Main-owned manager, not a Renderer mount, defines connector generations. */
export function attachOutreachSidecarLifecycle(options: {
  manager: {
    readonly client: object | null;
    getStatus(): ConnectorStatus;
    onStatus(listener: (status: ConnectorStatus) => void): () => void;
  };
  coordinator: { start(): Promise<void>; onSidecarChanged(ready: boolean, generation: number): Promise<void> };
  onFailure(): void;
}): () => void {
  let disposed = false;
  let started = false;
  let generation = 0;
  let sequence = 0;
  let lastClient: object | null | undefined;
  const observe = (status: ConnectorStatus) => {
    if (disposed) return;
    const client = status.state === "ready" ? options.manager.client : null;
    if (client === lastClient) return;
    lastClient = client;
    if (client) generation += 1;
    const ownSequence = ++sequence;
    const notify = async () => {
      await options.coordinator.onSidecarChanged(client !== null, generation);
      if (disposed || !client || ownSequence !== sequence || started) return;
      started = true;
      try { await options.coordinator.start(); }
      catch (error) { started = false; throw error; }
    };
    void notify().catch(() => { if (!disposed) options.onFailure(); });
  };
  const unsubscribe = options.manager.onStatus(observe);
  observe(options.manager.getStatus());
  return () => { disposed = true; sequence += 1; unsubscribe(); };
}
