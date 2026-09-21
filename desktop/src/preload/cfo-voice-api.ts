import { CFO_VOICE_CHANNEL, type CfoVoiceBridge, type CfoVoiceStatus, type GreetingPreferences } from '../shared/cfo-voice.ts';
export function exposeCfoVoiceApi(ports: { contextBridge: { exposeInMainWorld(key: string, value: unknown): void };
  ipcRenderer: { invoke(channel: string, value: unknown): Promise<unknown> } }) {
  const invoke = (action: string, extra = {}) => ports.ipcRenderer.invoke(CFO_VOICE_CHANNEL, { action, ...extra }) as Promise<CfoVoiceStatus>;
  const bridge: CfoVoiceBridge = Object.freeze({ status: () => invoke('status'), greet: (workspaceId: string) => invoke('greet', { workspaceId }),
    preview: (workspaceId: string, preferences?: GreetingPreferences) => invoke('preview', preferences
      ? { workspaceId, preferences }
      : { workspaceId }), stop: () => invoke('stop'),
    setMuted: (muted: boolean) => invoke('mute', { muted }),
    setPreferences: (preferences: GreetingPreferences) => invoke('preferences', { preferences }) });
  ports.contextBridge.exposeInMainWorld('shensiCfoVoice', bridge);
}
