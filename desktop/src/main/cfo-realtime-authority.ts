import type { VoiceScope } from './cfo-realtime-settings.ts';
import type { VoiceTurn } from '../shared/cfo-realtime.ts';

interface AppSession {
  fetch(url: string, init: RequestInit): Promise<Response>;
  cookies: { get(filter: { url: string }): Promise<{ name: string; value: string }[]> };
}
export function createCfoVoiceAuthority(options: { localOrigin: string; session(): AppSession | undefined }) {
  async function request(path: string, workspaceId: string, input?: unknown, signal?: AbortSignal) {
    const session = options.session(); if (!session) throw new Error('voice_auth_required');
    const headers: Record<string, string> = { 'X-Workspace-Id': workspaceId, Origin: options.localOrigin };
    if (input !== undefined) {
      const csrf = (await session.cookies.get({ url: options.localOrigin })).find(c => c.name === 'gj_csrf')?.value;
      if (!csrf) throw new Error('voice_auth_required');
      headers['x-csrf-token'] = decodeURIComponent(csrf); headers['Content-Type'] = 'application/json';
    }
    let response: Response;
    try { response = await session.fetch(`${options.localOrigin}${path}`, { credentials: 'include', redirect: 'error', headers,
      method: input === undefined ? 'GET' : 'POST', body: input === undefined ? undefined : JSON.stringify(input),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(130_000)]) : AbortSignal.timeout(10_000) }); }
    catch { throw new Error('voice_network_failed'); }
    if (response.status === 401) throw new Error('voice_auth_required');
    if (response.status === 403) throw new Error('voice_permission_denied');
    if (!response.ok) {
      if (path === '/api/v1/finance/cfo-conversation' && response.status === 409) {
        const error = await response.json().catch(() => null);
        if (['finance_document_expired', 'finance_document_not_selected', 'finance_document_selection_changed',
          'finance_document_not_found'].includes(error?.code)) throw new Error('voice_material_unavailable');
      }
      throw new Error('voice_tool_failed');
    }
    try { return await response.json(); } catch { throw new Error('voice_protocol_failed'); }
  }
  async function authorize(workspaceId: string): Promise<VoiceScope> {
    if (typeof workspaceId !== 'string' || !workspaceId || workspaceId === 'all' || workspaceId.length > 255
      || /[\u0000-\u001f\u007f]/u.test(workspaceId)) throw new Error('voice_input_invalid');
    const me = await request('/api/auth/me', workspaceId);
    if (typeof me?.user?.id !== 'string' || !me.user.id) throw new Error('voice_auth_required');
    const center = await request('/api/v1/finance/council-agent-center', workspaceId);
    if (center?.capabilities?.canRun !== true) throw new Error('voice_permission_denied');
    return { workspaceId, actorId: me.user.id };
  }
  return { authorize,
    async ask(scope: VoiceScope, input: { question: string; history: VoiceTurn[]; documentId?: string | null }, signal: AbortSignal) {
      const current = await authorize(scope.workspaceId);
      if (current.actorId !== scope.actorId || signal.aborted) throw new Error('voice_auth_required');
      // Voice turns must not auto-enter public research planning; that path needs a separate
      // planner/model and otherwise surfaces as voice_tool_failed / 文字模型配置.
      return request('/api/v1/finance/cfo-conversation', scope.workspaceId, { ...input, webSearchMode: 'off' }, signal);
    }
  };
}
