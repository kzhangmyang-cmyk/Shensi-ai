import { DESKTOP_CHANNELS, type DesktopOutreachBridge } from '../shared/contracts.ts';
import { validateDesktopOutreachView, validateInvoke } from '../shared/validation.ts';
export function exposeDesktopApi(input: { contextBridge: { exposeInMainWorld(key: string, value: unknown): void }; ipcRenderer: { invoke(channel: string, value?: unknown): Promise<unknown>; on(channel: string, listener: (event: unknown, value: unknown) => void): void; removeListener(channel: string, listener: (event: unknown, value: unknown) => void): void; }; }) {
  const invoke = (channel: string, value?: unknown) => input.ipcRenderer.invoke(channel, value);
  const outreach: DesktopOutreachBridge = {
    getDesktopInstallationInfo: () => invoke(DESKTOP_CHANNELS.getDesktopInstallationInfo) as ReturnType<DesktopOutreachBridge["getDesktopInstallationInfo"]>,
    registerDesktopInstallation: (value) => invoke(DESKTOP_CHANNELS.registerDesktopInstallation,
      validateInvoke(DESKTOP_CHANNELS.registerDesktopInstallation, value)) as ReturnType<DesktopOutreachBridge["registerDesktopInstallation"]>,
    recordDesktopBinding: (value) => invoke(DESKTOP_CHANNELS.recordDesktopBinding,
      validateInvoke(DESKTOP_CHANNELS.recordDesktopBinding, value)) as ReturnType<DesktopOutreachBridge["recordDesktopBinding"]>,
    setDesktopWorkspace: (value) => invoke(DESKTOP_CHANNELS.setDesktopWorkspace,
      validateInvoke(DESKTOP_CHANNELS.setDesktopWorkspace, value)) as Promise<void>,
    getDesktopOutreachStatus: async () => validateDesktopOutreachView(await invoke(DESKTOP_CHANNELS.getDesktopOutreachStatus)),
    onDesktopOutreachStatusChanged: (listener) => {
      let active = true;
      const callback = (_event: unknown, value: unknown) => {
        if (!active) return;
        let view;
        try { view = validateDesktopOutreachView(value); } catch { return; }
        listener(view);
      };
      input.ipcRenderer.on(DESKTOP_CHANNELS.desktopOutreachStatusChanged, callback);
      return () => { if (!active) return; active = false; input.ipcRenderer.removeListener(DESKTOP_CHANNELS.desktopOutreachStatusChanged, callback); };
    }
  };
  const api = { controlDouyinCollection: (taskId: string, action: string) => invoke(DESKTOP_CHANNELS.controlDouyinCollection, { taskId, action }), ...outreach, getRuntimeInfo: () => invoke(DESKTOP_CHANNELS.getRuntimeInfo), getConnectorStatus: () => invoke(DESKTOP_CHANNELS.getConnectorStatus), restartConnector: () => invoke(DESKTOP_CHANNELS.restartConnector), startDouyinLogin: (accountId: string) => invoke(DESKTOP_CHANNELS.startDouyinLogin, { accountId }), getDouyinLoginStatus: (sessionId: string) => invoke(DESKTOP_CHANNELS.getDouyinLoginStatus, { sessionId }), confirmDouyinLogin: (sessionId: string) => invoke(DESKTOP_CHANNELS.confirmDouyinLogin, { sessionId }), cancelDouyinLogin: (sessionId: string) => invoke(DESKTOP_CHANNELS.cancelDouyinLogin, { sessionId }), startDouyinCollection: (accountId: string, task: unknown) => invoke(DESKTOP_CHANNELS.startDouyinCollection, { accountId, task }), getDouyinCollectionStatus: (taskId: string) => invoke(DESKTOP_CHANNELS.getDouyinCollectionStatus, { taskId }), getDouyinCollectionResults: (taskId: string, cursor?: string) => invoke(DESKTOP_CHANNELS.getDouyinCollectionResults, cursor === undefined ? { taskId } : { taskId, cursor }), acknowledgeDouyinCollection: (taskId: string) => invoke(DESKTOP_CHANNELS.acknowledgeDouyinCollection, { taskId }), cancelDouyinCollection: (taskId: string) => invoke(DESKTOP_CHANNELS.cancelDouyinCollection, { taskId }), openLogsDirectory: () => invoke(DESKTOP_CHANNELS.openLogsDirectory), getAppVersion: () => invoke(DESKTOP_CHANNELS.getAppVersion), onConnectorStatus: (listener: (status: unknown) => void) => { const callback = (_event: unknown, status: unknown) => listener(status); input.ipcRenderer.on(DESKTOP_CHANNELS.connectorStatusChanged, callback); return () => input.ipcRenderer.removeListener(DESKTOP_CHANNELS.connectorStatusChanged, callback); } };
  const exposed = { ...api, checkDouyinLogin: (accountId: string) =>
    invoke(DESKTOP_CHANNELS.checkDouyinLogin, validateInvoke(DESKTOP_CHANNELS.checkDouyinLogin, { accountId })) };
  input.contextBridge.exposeInMainWorld('shensiDesktop', exposed); return exposed;
}
