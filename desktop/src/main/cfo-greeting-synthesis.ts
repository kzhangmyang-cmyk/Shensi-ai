import type { VoiceSettingsInput } from '../shared/cfo-realtime.ts';
import { openQwenRealtime, type ProviderEvent, type QwenRealtimePort } from './cfo-realtime-provider.ts';

const MAX_GREETING_PCM_BYTES = 960_000;

export async function synthesizeQwenGreeting(
  settings: VoiceSettingsInput,
  text: string,
  signal: AbortSignal,
  options: {
    timeoutMs?: number;
    connect?: typeof openQwenRealtime;
    voice?: 'Tina' | 'Ethan';
    onDiagnostic?: (value: Record<string, unknown>) => void;
  } = {}
): Promise<Buffer> {
  if (signal.aborted) throw new Error('cfo_greeting_cancelled');
  const instructions = '你是 Shensi 的固定启动问候语音层。只自然、亲切地逐字朗读 JSON 中的 text，'
    + '不调用工具，不回答问题，不补充、改写或朗读字段名。' + JSON.stringify({ text });
  const chunks: Buffer[] = [];
  let port: QwenRealtimePort | undefined;
  let responseId: string | undefined;
  let transcript: string | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return await new Promise<Buffer>(async (resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
      port?.close();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const cancelled = () => finish(new Error('cfo_greeting_cancelled'));
    signal.addEventListener('abort', cancelled, { once: true });
    timer = setTimeout(() => finish(new Error('cfo_greeting_unavailable')), options.timeoutMs ?? 20_000);
    timer.unref();
    const receive = (event: ProviderEvent) => {
      if (settled) return;
      try {
        if (event.type === 'closed') { finish(new Error('cfo_greeting_unavailable')); return; }
        if (event.type === 'session.updated') {
          const acknowledged = { instructions: event.session?.instructions === instructions,
            tools: event.session?.tools === undefined
              || (Array.isArray(event.session.tools) && event.session.tools.length === 0) };
          if (!acknowledged.instructions || !acknowledged.tools) {
            options.onDiagnostic?.({ stage: 'greeting_session_update', reason: 'acknowledgement_mismatch', acknowledged });
            finish(new Error('cfo_greeting_unavailable')); return;
          }
          port?.send({ type: 'response.create' }); return;
        }
        if (event.type === 'response.created') {
          if (typeof event.response?.id !== 'string' || responseId) throw new Error();
          responseId = event.response.id; return;
        }
        if (event.type === 'response.audio.delta' && event.response_id === responseId) {
          if (typeof event.delta !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(event.delta)) throw new Error();
          const chunk = Buffer.from(event.delta, 'base64');
          if (!chunk.length || chunk.length % 2 || chunk.toString('base64') !== event.delta) throw new Error();
          if (chunks.reduce((sum, value) => sum + value.length, 0) + chunk.length > MAX_GREETING_PCM_BYTES) throw new Error();
          chunks.push(chunk); return;
        }
        if (event.type === 'response.audio_transcript.done' && event.response_id === responseId) {
          if (typeof event.transcript !== 'string') throw new Error();
          transcript = event.transcript; return;
        }
        if (event.type === 'response.done' && event.response?.id === responseId) {
          if (event.response.status && event.response.status !== 'completed') throw new Error();
          const transcriptMatches = transcript?.normalize('NFKC').replace(/\s/gu, '') === text.normalize('NFKC').replace(/\s/gu, '');
          if (!chunks.length || !transcriptMatches) {
            options.onDiagnostic?.({ stage: 'greeting_response', reason: 'output_validation_failed',
              hasAudio: chunks.length > 0, transcriptPresent: transcript !== undefined, transcriptMatches });
            throw new Error();
          }
          finish();
        }
      } catch { finish(new Error('cfo_greeting_unavailable')); }
    };
    try {
      port = await (options.connect ?? openQwenRealtime)(settings, [], receive, signal, {
        endpoint: 'dashscope', voice: options.voice, onDiagnostic: options.onDiagnostic
      });
      if (settled) { port.close(); return; }
      port.send({ type: 'session.update', session: { instructions, tools: [] } });
    } catch (error) {
      finish(error instanceof Error && error.message === 'cfo_greeting_cancelled'
        ? error : new Error('cfo_greeting_unavailable'));
    }
  });
}
