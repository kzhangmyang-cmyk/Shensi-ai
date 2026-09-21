import WebSocket from 'ws';
import { CFO_AUDIO_MODEL, type VoiceSettingsInput, type VoiceTurn } from '../shared/cfo-realtime.ts';

export interface QwenRealtimePort { send(event: Record<string, unknown>): void; close(): void; }
export type ProviderEvent = Record<string, any>;
function redactedDiagnosticText(value: unknown, settings: VoiceSettingsInput): string {
  if (typeof value !== 'string') return '';
  let text = value;
  for (const secret of [settings.apiKey, settings.workspaceId, encodeURIComponent(settings.apiKey), encodeURIComponent(settings.workspaceId)]) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ').replace(/&(?:amp|quot|lt|gt|nbsp);/giu, ' ')
    .replace(/(?:https?|wss?):\/\/[^\s<>"']+/giu, '[url]')
    .replace(/\b(?:authorization|cookie|api[_ -]?key|token|request[_ -]?id|workspace[_ -]?id|session[_ -]?id)\s*[:=]\s*[^\s,;]+/giu, '[private-field]')
    .replace(/\b(?:Bearer\s+\S+|[A-Za-z0-9_-]{20,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/giu, '[redacted]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, '[ip]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email]')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 400);
}
function httpRejectionDiagnostic(body: string, headers: Record<string, unknown>, settings: VoiceSettingsInput) {
  let parsed: any; try { parsed = JSON.parse(body); } catch { /* Categorize non-JSON below. */ }
  const rawError = parsed?.error ?? parsed;
  const error = { code: rawError?.code ?? rawError?.Code, message: rawError?.message ?? rawError?.Message,
    param: rawError?.param };
  const contentType = String(headers['content-type'] ?? '').toLowerCase();
  const server = String(headers.server ?? '').toLowerCase();
  const code = redactedDiagnosticText(error.code, settings);
  return { error, details: { ...safeProviderDiagnostic(error),
    contentType: contentType.includes('json') ? 'json' : contentType.includes('html') ? 'html' : contentType.startsWith('text/') ? 'text' : 'other',
    responseFormat: parsed !== undefined ? 'json' : !body.trim() ? 'empty' : /<!doctype html|<html|<body/iu.test(body) ? 'html' : 'text',
    sourceServer: ['tengine', 'nginx', 'envoy', 'cloudflare'].find(name => server.includes(name)) ?? 'other',
    viaPresent: headers.via !== undefined,
    errorCode: /^[A-Za-z0-9_.-]{1,80}$/u.test(code) ? code : 'other',
    detail: redactedDiagnosticText(parsed !== undefined ? error.message : body, settings) } };
}
function safeProviderDiagnostic(error: any): Record<string, string> {
  const rawCode = typeof error?.code === 'string' ? error.code.toLowerCase().replace(/[^a-z0-9]/gu, '') : '';
  const providerCode = ['invalidvalue', 'invalidparameter', 'invalidrequesterror', 'invalidapikey', 'modelnotfound',
    'modelnotexist', 'accessdenied', 'forbidden', 'throttling', 'insufficientquota'].includes(rawCode) ? rawCode : 'other';
  const fields = ['model', 'modalities', 'voice', 'audio', 'audio.input.format', 'audio.output.format',
    'turn_detection', 'tools', 'enable_search', 'enable_input_audio_transcription', 'input_audio_transcription', 'instructions'];
  const parameter = fields.flatMap(field => [field, `session.${field}`]).includes(error?.param) ? error.param : 'other';
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  const messageKind = /model.*(?:not found|not exist|not supported|unavailable)/u.test(message) ? 'model_unavailable'
    : /(?:unknown|unrecognized|unsupported).*(?:field|parameter)/u.test(message) ? 'unsupported_parameter'
    : /(?:missing|required).*(?:parameter|field)|(?:parameter|field).*required/u.test(message) ? 'missing_parameter' : 'other';
  return { providerCode, parameter, messageKind };
}
export function providerFailure(value: unknown): string {
  const code = typeof value === 'string' ? value.toLowerCase() : '';
  if (/invalid.?api.?key|authentication|unauthorized|401/u.test(code)) return 'voice_credentials_failed';
  if (/forbidden|permission|access.?denied|403|quota|balance|limit|429/u.test(code)) return 'voice_permission_failed';
  return 'voice_protocol_failed';
}
export function realtimeSessionConfig(history: VoiceTurn[], voice = 'Tina') {
  return {
    model: CFO_AUDIO_MODEL, modalities: ['text', 'audio'], voice,
    audio: { input: { format: { type: 'pcm', sample_rate: 16000 } }, output: { format: { type: 'pcm', sample_rate: 24000 } } },
    turn_detection: { type: 'semantic_vad', threshold: 0.5, silence_duration_ms: 600 },
    enable_input_audio_transcription: true, enable_search: false,
    instructions: '你是 Shensi AI经营总管的语音交互层。每次用户发言都先调用 ask_cfo，将用户原意作为question传入。'
      + '不要自行做经营分析、计算财务数字、查询资料或执行操作；只有ask_cfo结果是业务回答依据。'
      + '收到工具结果后，用自然简短中文忠实转述，不补充事实；缺资料就说明缺少什么。'
      + '用户可以随时打断。以下是本次对话中确认的用户发言与完整播放的回答，未完整播放的回答没有逐字记录：'
      + JSON.stringify(history.slice(-10)),
    tools: [{ type: 'function', function: { name: 'ask_cfo', description: '将用户问题交给有当前工作区权限、已验证报表与既有文字模型的经营总管。',
      parameters: { type: 'object', additionalProperties: false, properties: { question: { type: 'string', maxLength: 2000 } }, required: ['question'] } } }]
  };
}

// Only Main supplies settings and this connector. No Renderer URL or headers.
export function openQwenRealtime(settings: VoiceSettingsInput, history: VoiceTurn[],
  onEvent: (event: ProviderEvent) => void, signal: AbortSignal,
  options: { timeoutMs?: number; endpoint?: 'workspace' | 'dashscope'; socket?: (url: string, apiKey: string) => WebSocket;
    voice?: 'Tina' | 'Ethan'; onDiagnostic?: (value: Record<string, unknown>) => void } = {}): Promise<QwenRealtimePort> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('voice_network_failed')); return; }
    const host = options.endpoint === 'dashscope' ? 'dashscope.aliyuncs.com' : `${settings.workspaceId}.cn-beijing.maas.aliyuncs.com`;
    const url = `wss://${host}/api-ws/v1/realtime?model=${CFO_AUDIO_MODEL}`;
    const socket = (options.socket ?? ((target, key) => new WebSocket(target, {
      headers: { Authorization: `Bearer ${key}` }, followRedirects: false,
      handshakeTimeout: 15_000, maxPayload: 262144, perMessageDeflate: false
    })))(url, settings.apiKey);
    let closed = false, ready = false, configured = false;
    let stage = 'websocket_connecting';
    const close = () => {
      if (closed) return; closed = true; clearTimeout(timer); signal.removeEventListener('abort', aborted);
      // terminate is bounded and does not wait 5–10s for an idle provider close.
      socket.terminate();
      if (!ready) reject(new Error('voice_network_failed'));
    };
    const fail = (code: string, reason = 'transport_failure', details: Record<string, unknown> = {}) => {
      if (closed) return;
      // HTTP diagnostics are bounded and redacted before reaching the private log.
      // Never forward the raw body, credentials, URLs, identifiers or headers.
      try { options.onDiagnostic?.({ stage, reason, ...details }); } catch { /* Logging cannot retain the socket. */ }
      if (!ready) reject(new Error(code)); else onEvent({ type: 'closed', code });
      close();
    };
    const aborted = () => close();
    const timer = setTimeout(() => fail('voice_network_failed'), options.timeoutMs ?? 20_000);
    timer.unref(); signal.addEventListener('abort', aborted, { once: true });
    const send = (event: Record<string, unknown>) => {
      if (closed || socket.readyState !== WebSocket.OPEN) throw new Error('voice_network_failed');
      if (socket.bufferedAmount > 1_048_576) throw new Error('voice_backpressure');
      socket.send(JSON.stringify(event));
    };
    socket.on('unexpected-response', (_request, response) => {
      let body = ''; let bytesRead = 0;
      const finish = () => {
        const { error, details } = httpRejectionDiagnostic(body, response.headers, settings);
        body = '';
        const statusFailure = providerFailure(String(response.statusCode));
        fail(statusFailure === 'voice_protocol_failed' ? providerFailure(error?.code) : statusFailure,
          'http_rejected', { httpStatus: response.statusCode ?? 0, ...details });
      };
      response.on('data', (chunk: Buffer) => {
        bytesRead += chunk.length;
        if (bytesRead > 16384) { body = ''; finish(); response.destroy(); return; }
        body += chunk.toString('utf8');
      });
      response.on('end', finish);
      response.on('error', () => { body = ''; fail('voice_network_failed'); });
    });
    socket.on('open', () => { stage = 'websocket_open'; });
    socket.on('error', () => fail('voice_network_failed'));
    socket.on('close', () => fail('voice_network_failed'));
    socket.on('message', bytes => {
      if (closed) return;
      try {
        const buffer = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes as ArrayBuffer);
        if (buffer.length > 262144) { fail('voice_protocol_failed'); return; }
        const event = JSON.parse(buffer.toString());
        if (!event || typeof event.type !== 'string') throw new Error();
        if (event.type === 'error') { fail(providerFailure(event.error?.code), 'provider_error', safeProviderDiagnostic(event.error)); return; }
        if (event.type === 'session.created' && !configured) {
          configured = true; send({ type: 'session.update', session: realtimeSessionConfig(history, options.voice) }); stage = 'session_update_sent'; return;
        }
        if (event.type === 'session.updated' && !ready) {
          const session = event.session;
          const confirmed = { created: configured, model: session?.model === CFO_AUDIO_MODEL,
            modalities: Array.isArray(session?.modalities) && session.modalities.includes('audio'),
            input_format: session?.audio?.input?.format?.type === 'pcm' && session.audio.input.format.sample_rate === 16000,
            output_format: session?.audio?.output?.format?.type === 'pcm' && session.audio.output.format.sample_rate === 24000,
            vad: session?.turn_detection?.type === 'semantic_vad',
            tools: session?.tools?.length === 1 && session.tools[0]?.function?.name === 'ask_cfo' };
          const unconfirmed = Object.entries(confirmed).filter(([, value]) => !value).map(([name]) => name);
          if (unconfirmed.length) { fail('voice_protocol_failed', 'acknowledgement_mismatch', { unconfirmed }); return; }
          stage = 'session_ready'; ready = true; clearTimeout(timer); resolve({ send, close }); return;
        }
        if (ready) onEvent(event);
      } catch { fail('voice_protocol_failed', 'invalid_event'); }
    });
  });
}
