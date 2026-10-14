import { CFO_REALTIME_CHANNEL, CFO_REALTIME_EVENT, type CfoRealtimeBridge, type VoiceEvent } from '../shared/cfo-realtime.ts';
export function exposeCfoRealtimeApi(ports: { contextBridge: { exposeInMainWorld(key: string, value: unknown): void };
  ipcRenderer: { invoke(channel: string, input: unknown): Promise<any>; on(channel: string, listener: (event: unknown, value: VoiceEvent) => void): unknown;
    removeListener(channel: string, listener: (event: unknown, value: VoiceEvent) => void): unknown } }) {
  const invoke = (action: string, values = {}) => ports.ipcRenderer.invoke(CFO_REALTIME_CHANNEL, { action, ...values });
  const bridge: CfoRealtimeBridge = Object.freeze({
    settings: (workspaceId: string) => invoke('settings', { workspaceId }),
    save: (workspaceId: string, input: Parameters<CfoRealtimeBridge['save']>[1]) => invoke('save', { workspaceId, input }),
    remove: (workspaceId: string) => invoke('remove', { workspaceId }), check: (workspaceId: string) => invoke('check', { workspaceId }),
    start: (workspaceId: string, history: Parameters<CfoRealtimeBridge['start']>[1], documentId?: string | null) =>
      invoke('start', { workspaceId, history, ...(documentId !== undefined ? { documentId } : {}) }),
    audio: (sessionId: string, pcm: string) => invoke('audio', { sessionId, pcm }),
    played: (sessionId: string, responseId: string, playedMs: number, complete: boolean) => invoke('played', { sessionId, responseId, playedMs, complete }),
    stop: () => invoke('stop'), help: (kind: 'key' | 'workspace') => invoke('help', { kind }),
    onEvent: (listener: (event: VoiceEvent) => void) => {
      const receive = (_event: unknown, value: VoiceEvent) => listener(value);
      ports.ipcRenderer.on(CFO_REALTIME_EVENT, receive); return () => { ports.ipcRenderer.removeListener(CFO_REALTIME_EVENT, receive); };
    }
  });
  ports.contextBridge.exposeInMainWorld('shensiCfoRealtime', bridge);
}
