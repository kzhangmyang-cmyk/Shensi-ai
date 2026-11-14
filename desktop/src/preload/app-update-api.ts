import { UPDATE_CHANNELS, type PublicUpdateState } from "../shared/app-update.ts";

export interface AppUpdateBridge {
  getState(): Promise<PublicUpdateState>;
  check(): Promise<PublicUpdateState>;
  download(): Promise<PublicUpdateState>;
  cancel(): Promise<PublicUpdateState>;
  retry(): Promise<PublicUpdateState>;
  reveal(): Promise<PublicUpdateState>;
  onChange(listener: (state: PublicUpdateState) => void): () => void;
}

export function exposeAppUpdateApi(input: {
  contextBridge: { exposeInMainWorld(key: string, value: unknown): void };
  ipcRenderer: {
    invoke(channel: string): Promise<unknown>;
    on(channel: string, listener: (event: unknown, value: unknown) => void): void;
    removeListener(channel: string, listener: (event: unknown, value: unknown) => void): void;
  };
}): void {
  const invoke = (channel: string) => input.ipcRenderer.invoke(channel) as Promise<PublicUpdateState>;
  const bridge: AppUpdateBridge = {
    getState: () => invoke(UPDATE_CHANNELS.getState),
    check: () => invoke(UPDATE_CHANNELS.check),
    download: () => invoke(UPDATE_CHANNELS.download),
    cancel: () => invoke(UPDATE_CHANNELS.cancel),
    retry: () => invoke(UPDATE_CHANNELS.retry),
    reveal: () => invoke(UPDATE_CHANNELS.reveal),
    onChange(listener) {
      const callback = (_event: unknown, value: unknown) => {
        if (value && typeof value === "object" && (value as { automaticInstallSupported?: unknown }).automaticInstallSupported === false)
          listener(value as PublicUpdateState);
      };
      input.ipcRenderer.on(UPDATE_CHANNELS.changed, callback);
      return () => input.ipcRenderer.removeListener(UPDATE_CHANNELS.changed, callback);
    }
  };
  input.contextBridge.exposeInMainWorld("shensiAppUpdate", Object.freeze(bridge));
}
