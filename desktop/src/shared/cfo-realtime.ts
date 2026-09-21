export const CFO_REALTIME_CHANNEL = 'shensi:cfo-realtime:command';
export const CFO_REALTIME_EVENT = 'shensi:cfo-realtime:event';
export const CFO_AUDIO_MODEL = 'qwen3.5-omni-flash-realtime';
export type VoiceCheckState = 'not_configured' | 'saved' | 'ready' | 'credentials_failed' | 'permission_failed' | 'network_failed' | 'protocol_failed';
export interface VoiceSettingsView {
  state: VoiceCheckState; configured: boolean; workspaceId: string; model: string;
  region: 'cn-beijing'; checkedAt: string | null;
}
// Empty provider workspace is valid for the fixed public Beijing endpoint.
export interface VoiceSettingsInput { apiKey: string; workspaceId: string; }
// Format checks only. Credential ownership/model access are provider checks.
export function normalizeVoiceSettings(raw: unknown): VoiceSettingsInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'apiKey,workspaceId')
    throw new Error('voice_input_invalid');
  const value = raw as Record<string, unknown>;
  if (typeof value.apiKey !== 'string' || !/^[!-~]{1,4096}$/u.test(value.apiKey.trim())
    || /^https?:\/\//iu.test(value.apiKey.trim())) throw new Error('voice_key_invalid');
  if (typeof value.workspaceId !== 'string' || (value.workspaceId.trim() !== ''
    && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(value.workspaceId.trim())))
    throw new Error('voice_workspace_invalid');
  return { apiKey: value.apiKey.trim(), workspaceId: value.workspaceId.trim().toLowerCase() };
}
export interface VoiceTurn { role: 'user' | 'assistant'; text: string; }
export function voiceDocumentId(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string' || !value || value.length > 255 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('voice_input_invalid');
  return value;
}
export type VoiceEvent = { sessionId: string } & (
  | { type: 'listening' | 'thinking' | 'interrupted' | 'ended' }
  | { type: 'error'; code: string }
  | { type: 'user'; text: string }
  | { type: 'audio'; responseId: string; pcm: string }
  | { type: 'response_done'; responseId: string; text: string }
  | { type: 'transcript'; responseId: string; text: string }
  | { type: 'business'; text: string; model: string }
);
export interface CfoRealtimeBridge {
  settings(workspaceId: string): Promise<VoiceSettingsView>;
  save(workspaceId: string, input: VoiceSettingsInput): Promise<VoiceSettingsView>;
  remove(workspaceId: string): Promise<VoiceSettingsView>;
  check(workspaceId: string): Promise<VoiceSettingsView>;
  start(workspaceId: string, history: VoiceTurn[], documentId?: string | null): Promise<{ sessionId: string }>;
  audio(sessionId: string, pcm: string): Promise<void>;
  played(sessionId: string, responseId: string, playedMs: number, complete: boolean): Promise<void>;
  stop(): Promise<void>;
  help(kind: 'key' | 'workspace'): Promise<void>;
  onEvent(listener: (event: VoiceEvent) => void): () => void;
}
export const voiceErrorMessage = (code: string) => ({
  voice_input_invalid: '语音配置提交格式异常，尚未连接百炼，请更新开发应用后重试。',
  voice_key_invalid: 'API Key 格式不完整：请只粘贴密钥本身，不含空白、Bearer 前缀或调用地址。尚未连接百炼。',
  voice_workspace_invalid: '业务空间 ID 格式不正确：请复制百炼的空间 ID，不是空间名称或调用地址。尚未连接百炼。',
  voice_storage_unavailable: '系统安全存储不可用，请解锁 Mac 钥匙串后重试。',
  voice_auth_required: '登录已失效，请重新登录工作台。',
  voice_permission_denied: '当前账号没有此工作区的经营总管权限。',
  voice_credentials_failed: 'API Key 无效或已失效，请更换北京地域的百炼 Key。',
  voice_permission_failed: '百炼拒绝访问，请核对业务空间、模型权限与账户状态。',
  voice_network_failed: '暂时无法连接百炼，请检查网络后重新检测。',
  voice_protocol_failed: '实时服务未确认音频配置，请稍后重新检测。',
  voice_not_ready: '请先保存配置并通过连接检测。',
  voice_busy: '另一项语音操作尚未结束，请稍后重试。',
  voice_microphone_denied: '麦克风未获授权，请在 macOS 隐私与安全中允许 Shensi 使用麦克风。',
  voice_audio_unavailable: '音频设备无法启动，请检查麦克风和输出设备后重试。',
  voice_tool_failed: '经营总管本次未能回答，请检查文字模型配置或稍后重试。',
  voice_material_unavailable: '本次选择的资料已过期或不再可用，请重新读取资料，或明确切回已确认报表。',
  voice_tool_required: '语音服务未调用经营总管，本轮没有播放未经业务模型确认的回答，请再说一次。',
  voice_transcription_missing: '本轮语音没有返回完整识别结果，对话已停止，请重新开始。',
  voice_backpressure: '网络或播放速度跟不上，语音已停止，请重新开始。',
} as Record<string, string>)[code] ?? '语音操作未完成，请重试。';
