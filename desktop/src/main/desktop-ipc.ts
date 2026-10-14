import { createHash } from 'node:crypto';
import { DESKTOP_CHANNELS, type DesktopRuntimeInfo, type DesktopOutreachBridge } from '../shared/contracts.ts';
import { validateInvoke, validateDesktopOutreachView } from '../shared/validation.ts';

type Handler = (event: {
  senderFrame?: { url?: string } | null;
  sender?: unknown;
}, value?: unknown) => unknown;
interface RendererSender { mainFrame: { url?: string }; send(channel: string, value: unknown): void; isDestroyed(): boolean; }
export interface DesktopIpcOptions { onCollectionDiagnostic?: (value: { taskId: string; stage: string; outcome: string }) => void; localOrigin: string; authorizedSender: () => RendererSender | undefined; outreach?: DesktopOutreachBridge; ipcMain: { handle(channel: string, handler: Handler): void; removeHandler(channel: string): void; }; manager: any; appVersion(): string; openLogsDirectory(): Promise<void>; runtimeInfo(): DesktopRuntimeInfo; }
function accountKey(accountId: string): string { return createHash('sha256').update(`douyin-profile:${accountId}`, 'utf8').digest('hex'); }
function client(manager: any): any { if (!manager.client) throw new Error('connector_unavailable'); return manager.client; }
function hasOrigin(value: string, expectedOrigin: string): boolean {
  try { return new URL(value).origin === expectedOrigin; }
  catch { return false; }
}
export function registerDesktopIpc(options: DesktopIpcOptions): { dispose(): void } {
  const channels = Object.values(DESKTOP_CHANNELS).filter((channel) => channel !== DESKTOP_CHANNELS.connectorStatusChanged && channel !== DESKTOP_CHANNELS.desktopOutreachStatusChanged);
  let disposed = false;
  const origin = new URL(options.localOrigin).origin; const loginFlights = new Map<string, Promise<unknown>>(); const identities = new Map<string, { handle: string; version: number }>(); const sessions = new Map<string, string>(); let connectorGeneration = 0;
  const accountGenerations = new Map<string, number>();
  const accountGeneration = (key: string) => accountGenerations.get(key) ?? 0;
  const revokeIdentity = (key: string) => {
    const generation = accountGeneration(key) + 1;
    accountGenerations.set(key, generation);
    identities.delete(key);
    return generation;
  };
  const assertAccountGeneration = (key: string, generation: number) => {
    if (disposed || accountGeneration(key) !== generation)
      throw new Error('desktop_login_identity_unavailable');
  };
  const remember = (key: string, status: any, generation: number, expectedSessionId?: string) => {
    assertAccountGeneration(key, generation);
    if (!status?.sessionId || (expectedSessionId && status.sessionId !== expectedSessionId))
      throw new Error('desktop_login_session_mismatch');
    if (status.state === 'expired' || status.state === 'failed') {
      revokeIdentity(key);
      sessions.delete(status.sessionId);
      return status;
    }
    sessions.set(status.sessionId, key);
    if (status.state === 'active' && status.accountHandle && status.loginStateVersion)
      identities.set(key, { handle: status.accountHandle, version: status.loginStateVersion });
    return status;
  };
  const unsubscribe = options.manager.onStatus?.((status: { state: string }) => {
    if (status.state !== 'ready') { connectorGeneration += 1; identities.clear(); sessions.clear(); }
  }) ?? (() => undefined);
  const unsubscribeOutreach = options.outreach?.onDesktopOutreachStatusChanged((view) => {
    const sender = options.authorizedSender();
    if (disposed || !sender || sender.isDestroyed() || !sender.mainFrame?.url || !hasOrigin(sender.mainFrame.url, origin)) return;
    try { sender.send(DESKTOP_CHANNELS.desktopOutreachStatusChanged, validateDesktopOutreachView(view)); } catch { /* A detached Renderer does not stop Main. */ }
  }) ?? (() => undefined);
  const loginCall = (operation: (sidecar: any) => Promise<unknown> | unknown) => {
    const sidecar = client(options.manager);
    const generation = connectorGeneration;
    return Promise.resolve(operation(sidecar)).then((status) => {
      if (generation !== connectorGeneration || options.manager.client !== sidecar)
        throw new Error('desktop_connector_generation_stale');
      return status;
    });
  };
  for (const channel of channels) options.ipcMain.handle(channel, async (event, raw) => {
    if (disposed) throw new Error('desktop_ipc_disposed');
    const sender = options.authorizedSender();
    if (!event.senderFrame?.url
      || !sender || sender.isDestroyed() || event.sender !== sender || event.senderFrame !== sender.mainFrame
      || !hasOrigin(event.senderFrame.url, origin)) throw new Error('IPC sender is not local');
    const value: any = validateInvoke(channel, raw);
    if ([DESKTOP_CHANNELS.getDesktopInstallationInfo, DESKTOP_CHANNELS.registerDesktopInstallation,
      DESKTOP_CHANNELS.recordDesktopBinding, DESKTOP_CHANNELS.setDesktopWorkspace,
      DESKTOP_CHANNELS.getDesktopOutreachStatus].includes(channel as never)) {
      if (!options.outreach) throw new Error('desktop_outreach_unavailable');
      try {
        if (channel === DESKTOP_CHANNELS.getDesktopInstallationInfo) return await options.outreach.getDesktopInstallationInfo();
        if (channel === DESKTOP_CHANNELS.registerDesktopInstallation) return await options.outreach.registerDesktopInstallation(value);
        if (channel === DESKTOP_CHANNELS.recordDesktopBinding) return await options.outreach.recordDesktopBinding(value);
        if (channel === DESKTOP_CHANNELS.setDesktopWorkspace) return await options.outreach.setDesktopWorkspace(value);
        return validateDesktopOutreachView(await options.outreach.getDesktopOutreachStatus());
      } catch { throw new Error('desktop_outreach_request_failed'); }
    }
    if (channel === DESKTOP_CHANNELS.getRuntimeInfo) return options.runtimeInfo();
    if (channel === DESKTOP_CHANNELS.getConnectorStatus) return options.manager.getStatus();
    if (channel === DESKTOP_CHANNELS.restartConnector) return options.manager.restart();
    if (channel === DESKTOP_CHANNELS.openLogsDirectory) return options.openLogsDirectory();
    if (channel === DESKTOP_CHANNELS.getAppVersion) return options.appVersion();
    if (channel === DESKTOP_CHANNELS.checkDouyinLogin) {
      const key = accountKey(value.accountId);
      const generation = accountGeneration(key);
      try {
        const identity: any = await loginCall((sidecar) => sidecar.resolveDouyinIdentity(key));
        assertAccountGeneration(key, generation);
        identities.set(key, { handle: identity.accountHandle, version: identity.loginStateVersion });
        return { accountHandle: identity.accountHandle, accountDisplayName: identity.accountDisplayName,
          loginStateVersion: identity.loginStateVersion };
      } catch {
        if (accountGeneration(key) === generation) identities.delete(key);
        throw new Error('desktop_login_identity_unavailable');
      }
    }
    if (channel === DESKTOP_CHANNELS.startDouyinLogin) {
      const key = accountKey(value.accountId);
      const pending = loginFlights.get(key);
      if (pending) return pending;
      const generation = revokeIdentity(key);
      // Retired handles can still be cancelled in Sidecar, but no longer own this account's identity.
      for (const [sessionId, owner] of sessions) {
        if (owner === key) sessions.delete(sessionId);
      }
      const flight = Promise.resolve().then(() => {
        assertAccountGeneration(key, generation);
        return loginCall((sidecar) => sidecar.startDouyinLogin(key));
      }).then((status: any) => remember(key, status, generation));
      loginFlights.set(key, flight);
      void flight.finally(() => { if (loginFlights.get(key) === flight) loginFlights.delete(key); }).catch(() => undefined);
      return flight;
    }
    if (channel === DESKTOP_CHANNELS.getDouyinLoginStatus || channel === DESKTOP_CHANNELS.confirmDouyinLogin) {
      const key = sessions.get(value.sessionId);
      if (!key) throw new Error('desktop_login_session_unavailable');
      const generation = accountGeneration(key);
      const status = await loginCall((sidecar) => channel === DESKTOP_CHANNELS.getDouyinLoginStatus
        ? sidecar.getDouyinLoginStatus(value.sessionId) : sidecar.confirmDouyinLogin(value.sessionId));
      // Cancellation can revoke this session while its Sidecar request is pending.
      if (sessions.get(value.sessionId) !== key) throw new Error('desktop_login_session_unavailable');
      return remember(key, status, generation, value.sessionId);
    }
    if (channel === DESKTOP_CHANNELS.cancelDouyinLogin) { const key = sessions.get(value.sessionId); if (key) revokeIdentity(key); sessions.delete(value.sessionId); return client(options.manager).cancelDouyinLogin(value.sessionId); }
    if (channel === DESKTOP_CHANNELS.startDouyinCollection) {
      const key = accountKey(value.accountId);
      const generation = accountGeneration(key);
      let identity = identities.get(key);
      // Cold Main has no in-memory identity. Resolve the persisted profile, but
      // never resurrect an explicitly revoked account or change login versions.
      if (!identity && generation === 0) {
        try {
          const restored: any = await loginCall((sidecar) => sidecar.resolveDouyinIdentity(key));
          assertAccountGeneration(key, generation);
          if (restored.loginStateVersion !== value.task.loginStateVersion || !restored.accountHandle)
            throw new Error('desktop_login_identity_unavailable');
          identity = { handle: restored.accountHandle, version: restored.loginStateVersion };
          identities.set(key, identity);
        } catch {
          options.onCollectionDiagnostic?.({ taskId: value.task.taskId, stage: 'restore_identity', outcome: 'failed' });
          throw new Error('desktop_login_identity_unavailable');
        }
      }
      if (!identity || identity.version !== value.task.loginStateVersion) throw new Error('desktop_login_identity_unavailable');
      try {
        const result = await client(options.manager).startDouyinCollection(identity.handle, value.task);
        options.onCollectionDiagnostic?.({ taskId: value.task.taskId, stage: 'start_sidecar', outcome: 'accepted' });
        return result;
      } catch (error) {
        options.onCollectionDiagnostic?.({ taskId: value.task.taskId, stage: 'start_sidecar', outcome: 'failed' });
        throw error;
      }
    }
    if (channel === DESKTOP_CHANNELS.getDouyinCollectionStatus) return client(options.manager).getDouyinCollectionStatus(value.taskId);
    if (channel === DESKTOP_CHANNELS.controlDouyinCollection) return client(options.manager).controlDouyinCollection(value.taskId, value.action);
    if (channel === DESKTOP_CHANNELS.getDouyinCollectionResults) return client(options.manager).getDouyinCollectionResults(value.taskId, value.cursor ?? null);
    if (channel === DESKTOP_CHANNELS.acknowledgeDouyinCollection) return client(options.manager).acknowledgeDouyinCollection(value.taskId);
    return client(options.manager).cancelDouyinCollection(value.taskId);
  });
  return { dispose() { if (disposed) return; disposed = true; unsubscribe(); unsubscribeOutreach(); for (const channel of channels) options.ipcMain.removeHandler(channel); loginFlights.clear(); identities.clear(); sessions.clear(); accountGenerations.clear(); } };
}
export { accountKey };
