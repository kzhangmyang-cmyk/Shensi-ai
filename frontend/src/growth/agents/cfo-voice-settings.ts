import { voiceErrorMessage, normalizeVoiceSettings, type CfoRealtimeBridge, type VoiceSettingsView } from '../../../../desktop/src/shared/cfo-realtime';

declare global { interface Window { shensiCfoRealtime?: CfoRealtimeBridge; } }
export const voiceFailure = (error: unknown) => voiceErrorMessage(error instanceof Error
  ? error.message.match(/voice_[a-z_]+/u)?.[0] ?? '' : '');

export function mountCfoVoiceSettings(options: { host: HTMLElement; workspace(): string | null; scope(): string | null;
  bridge?: CfoRealtimeBridge; onState?(view: VoiceSettingsView): void }) {
  const { host, bridge } = options; const doc = host.ownerDocument; const scope = options.scope();
  let disposed = false; let busy = false; let state: VoiceSettingsView | undefined;
  host.innerHTML = `<button type="button" data-voice-settings>语音服务设置</button>
  <dialog class="cfo-voice-dialog" aria-labelledby="cfoVoiceTitle">
    <div class="cfo-voice-heading"><div><span class="eyebrow">VOICE CONNECTION</span><h2 id="cfoVoiceTitle">实时语音服务配置</h2>
      <p>给经营总管接上声音。文字问答的模型配置保持不变。</p></div><button type="button" data-voice-close aria-label="关闭语音服务设置">×</button></div>
    <div class="cfo-voice-content"><div class="cfo-voice-provider"><div class="cfo-voice-mark" aria-hidden="true">声</div>
      <div><strong>阿里云百炼</strong><p>中国内地 · 北京 · 实时音频</p></div><span data-voice-badge>尚未配置</span></div>
      <form class="cfo-voice-form"><label for="cfoVoiceKey">API Key <button type="button" data-voice-help="key">获取 Key ↗</button></label>
        <input id="cfoVoiceKey" name="apiKey" type="password" autocomplete="off" spellcheck="false" required maxlength="4096" placeholder="粘贴北京地域的百炼 API Key">
        <p class="cfo-voice-help">密钥在这台 Mac 上加密保存，保存后不会回显。</p>
        <label for="cfoVoiceWorkspace">百炼业务空间 ID（可选）<button type="button" data-voice-help="workspace">在哪里找？↗</button></label>
        <input id="cfoVoiceWorkspace" name="workspaceId" autocomplete="off" spellcheck="false" maxlength="63" placeholder="可留空；如需记录，从百炼空间详情复制 ID">
        <p class="cfo-voice-help">使用百炼北京公共入口，仅需 API Key。空间 ID 仅在本机记录，不用于拼接连接地址。</p>
        <details class="cfo-voice-details"><summary>连接参数</summary><dl><dt>模型</dt><dd>qwen3.5-omni-flash-realtime</dd><dt>地域</dt><dd>cn-beijing（北京）</dd><dt>保存范围</dt><dd>当前 Shensi 账号与工作区 · 仅此 Mac</dd></dl></details>
        <div data-voice-feedback class="cfo-voice-feedback" role="status" aria-live="polite">尚未配置</div>
        <div class="cfo-voice-buttons"><button type="button" data-voice-remove disabled>移除配置</button><div>
          <button type="button" data-voice-check disabled>检测连接</button><button type="submit" class="primary">保存配置</button></div></div>
      </form><p class="cfo-voice-footnote">检测只建立实时连接，不打开麦克风。开始语音对话时再授权麦克风。</p></div>
  </dialog>`;
  const dialog = host.querySelector('dialog')!; const open = host.querySelector<HTMLButtonElement>('[data-voice-settings]')!;
  const form = host.querySelector('form')!; const key = host.querySelector<HTMLInputElement>('[name=apiKey]')!;
  const workspace = host.querySelector<HTMLInputElement>('[name=workspaceId]')!;
  const feedback = host.querySelector<HTMLElement>('[data-voice-feedback]')!;
  const badge = host.querySelector<HTMLElement>('[data-voice-badge]')!;
  const check = host.querySelector<HTMLButtonElement>('[data-voice-check]')!;
  const remove = host.querySelector<HTMLButtonElement>('[data-voice-remove]')!;
  const save = host.querySelector<HTMLButtonElement>('[type=submit]')!;
  const valid = () => !disposed && !!scope && options.scope() === scope && !!options.workspace();
  const lock = (value: boolean) => { busy = value; form.setAttribute('aria-busy', String(value));
    key.disabled = workspace.disabled = save.disabled = value || !bridge;
    check.disabled = remove.disabled = value || !state?.configured || !bridge; };
  function render(view: VoiceSettingsView) {
    state = view; workspace.value = view.workspaceId; key.value = '';
    key.placeholder = view.configured ? '已安全保存；替换时输入新的 API Key' : '粘贴北京地域的百炼 API Key';
    save.textContent = view.configured ? '更新配置' : '保存配置';
    const labels = { not_configured: '尚未配置', saved: '已保存，尚未检测', ready: '实时连接检测通过',
      credentials_failed: 'Key 校验失败', permission_failed: '访问未获授权', network_failed: '连接未完成', protocol_failed: '音频配置未确认' };
    badge.textContent = labels[view.state]; badge.dataset.ready = String(view.state === 'ready');
    feedback.dataset.error = String(view.state.endsWith('_failed'));
    feedback.textContent = view.state.endsWith('_failed') ? voiceErrorMessage(`voice_${view.state}`)
      : view.state === 'ready' ? '实时服务已确认连接与音频参数。麦克风和连续对话需另行开始并实测。' : labels[view.state];
    lock(false); options.onState?.(view);
  }
  async function run(action: 'settings' | 'save' | 'check' | 'remove') {
    if (busy || !valid()) return;
    if (!bridge) { feedback.textContent = '请在最新版 Shensi 桌面应用中配置实时语音。'; return; }
    lock(true); feedback.dataset.error = 'false';
    feedback.textContent = action === 'check' ? '正在检测百炼实时连接，请稍候…' : action === 'settings' ? '正在读取安全配置…' : '正在保存更改…';
    let input = { apiKey: key.value.trim(), workspaceId: workspace.value.trim() };
    try {
      if (action === 'save') input = normalizeVoiceSettings(input);
      const ws = options.workspace()!;
      const view = action === 'save' ? await bridge.save(ws, input) : await bridge[action](ws);
      if (valid()) render(view);
    } catch (error) { if (valid()) { feedback.textContent = voiceFailure(error); feedback.dataset.error = 'true'; } }
    finally { input.apiKey = ''; if (!disposed) lock(false); }
  }
  function show() { if (disposed) return; if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    void run('settings'); }
  function close() { key.value = ''; if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); open.focus(); }
  const submit = (event: Event) => { event.preventDefault(); void run('save'); };
  const click = (event: Event) => { const element = event.target as HTMLElement;
    if (element.closest('[data-voice-close]')) close();
    else if (element.closest('[data-voice-check]')) void run('check');
    else if (element.closest('[data-voice-remove]')) void run('remove');
    else { const kind = element.closest<HTMLElement>('[data-voice-help]')?.dataset.voiceHelp;
      if (kind === 'key' || kind === 'workspace') void bridge?.help(kind).catch(error => { if (!disposed) feedback.textContent = voiceFailure(error); }); }
  };
  dialog.addEventListener('cancel', close); dialog.addEventListener('click', click); form.addEventListener('submit', submit); open.addEventListener('click', show);
  lock(false);
  return { refresh: () => run('settings'), open: show, dispose() { disposed = true; key.value = ''; dialog.remove();
    open.removeEventListener('click', show); form.removeEventListener('submit', submit); dialog.removeEventListener('click', click); dialog.removeEventListener('cancel', close); } };
}
