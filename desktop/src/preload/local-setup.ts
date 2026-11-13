import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('shensiInitialSetup', Object.freeze({
  submit: (input: unknown) => ipcRenderer.invoke('shensi:local:initial-account', input),
}));
