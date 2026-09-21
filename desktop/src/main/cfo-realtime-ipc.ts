import { CFO_REALTIME_CHANNEL, voiceDocumentId } from '../shared/cfo-realtime.ts';
import type { CfoRealtimeService } from './cfo-realtime-service.ts';
import type { VoiceScope } from './cfo-realtime-settings.ts';

export function registerCfoRealtimeIpc(options: {
  localOrigin: string; service: CfoRealtimeService;
  authorizedSender(): { mainFrame: { url?: string }; isDestroyed(): boolean } | undefined;
  authorize(workspaceId: string): Promise<VoiceScope>;
  openHelp(kind: 'key' | 'workspace'): Promise<void>;
  ipcMain: { handle(channel: string, handler: (event: any, value: unknown) => Promise<any>): void; removeHandler(channel: string): void };
}) {
  let checking = false; let epoch = 0;
  const monitor = setInterval(() => {
    const scope = options.service.activeScope; const sessionId = options.service.activeSessionId; if (!scope || checking) return;
    checking = true;
    void options.authorize(scope.workspaceId).then(current => {
      if (current.actorId !== scope.actorId && options.service.activeSessionId === sessionId) options.service.stop();
    }, () => { if (options.service.activeSessionId === sessionId) options.service.stop(); }).finally(() => { checking = false; });
  }, 15_000); monitor.unref();
  options.ipcMain.handle(CFO_REALTIME_CHANNEL, async (event, raw) => {
    const sender = options.authorizedSender();
    if (!sender || sender.isDestroyed() || event.sender !== sender || event.senderFrame !== sender.mainFrame)
      throw new Error('voice_sender_invalid');
    try { if (new URL(event.senderFrame.url).origin !== options.localOrigin) throw new Error(); }
    catch { throw new Error('voice_sender_invalid'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('voice_input_invalid');
    const v = raw as Record<string, any>; const keys = Object.keys(v).sort().join(',');
    try {
      if (v.action === 'stop' && keys === 'action') { epoch++; options.service.stop(); return; }
      if (v.action === 'audio' && keys === 'action,pcm,sessionId') { options.service.audio(v.sessionId, v.pcm); return; }
      if (v.action === 'played' && keys === 'action,complete,playedMs,responseId,sessionId') {
        options.service.played(v.sessionId, v.responseId, v.playedMs, v.complete); return;
      }
      if (v.action === 'help' && keys === 'action,kind' && ['key', 'workspace'].includes(v.kind)) { await options.openHelp(v.kind); return; }
      const allowed: Record<string, string> = { settings: 'action,workspaceId', save: 'action,input,workspaceId',
        remove: 'action,workspaceId', check: 'action,workspaceId', start: 'action,history,workspaceId' };
      const selectedSourceStart = v.action === 'start' && keys === 'action,documentId,history,workspaceId';
      if (!Object.hasOwn(allowed, v.action) || (allowed[v.action] !== keys && !selectedSourceStart)) throw new Error('voice_input_invalid');
      const documentId = v.action === 'start' ? voiceDocumentId(v.documentId) : undefined;
      const requestEpoch = epoch;
      const scope = await options.authorize(v.workspaceId);
      if (v.action === 'start' && requestEpoch !== epoch) throw new Error('voice_not_ready');
      if (v.action === 'settings') return await options.service.settings(scope);
      if (v.action === 'save') return await options.service.save(scope, v.input);
      if (v.action === 'remove') return await options.service.remove(scope);
      if (v.action === 'check') return await options.service.check(scope);
      if (v.action === 'start') return await options.service.start(scope, v.history, documentId);
    } catch (error) {
      const safe = error instanceof Error && /^voice_[a-z_]+$/u.test(error.message) ? error.message : 'voice_protocol_failed';
      throw new Error(safe);
    }
  });
  return { dispose() { epoch++; clearInterval(monitor); options.service.dispose(); options.ipcMain.removeHandler(CFO_REALTIME_CHANNEL); } };
}
