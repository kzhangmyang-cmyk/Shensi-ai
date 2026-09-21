import type { CfoVoiceBridge, CfoVoiceStatus, GreetingPreferences, GreetingVoice } from '../../../desktop/src/shared/cfo-voice';

export function mountGreetingSettings(host: HTMLElement, bridge?: CfoVoiceBridge) {
  const doc = host.ownerDocument;
  const enabled = host.querySelector<HTMLInputElement>('[data-greeting-enabled]');
  const random = host.querySelector<HTMLInputElement>('[data-greeting-random]');
  const voices = [...host.querySelectorAll<HTMLButtonElement>('[data-greeting-voice]')];
  const preview = host.querySelector<HTMLButtonElement>('[data-greeting-preview]');
  const save = host.querySelector<HTMLButtonElement>('[data-greeting-save]');
  const status = host.querySelector<HTMLElement>('[data-greeting-preference-status]');
  const enabledLabel = host.querySelector<HTMLElement>('[data-greeting-enabled-label]');
  let disposed = false; let voice: GreetingVoice = 'female'; let dirty = false; let busy = false; let previewing = false;
  const controls = [...voices, preview, save, enabled, random].filter((value): value is HTMLButtonElement | HTMLInputElement => Boolean(value));
  const feedback = (text: string, error = false) => { if (status && !disposed) { status.textContent = text; status.dataset.error = String(error); } };
  const syncEnabledLabel = () => {
    if (enabledLabel) enabledLabel.textContent = enabled?.checked ? '已开启' : '已关闭';
  };
  const show = (value: CfoVoiceStatus) => {
    if (disposed) return;
    voice = value.voice; if (enabled) enabled.checked = !value.muted; if (random) random.checked = value.random;
    voices.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.greetingVoice === value.voice)));
    syncEnabledLabel();
  };
  const selected = (): GreetingPreferences => ({ muted: !(enabled?.checked ?? false), voice, random: random?.checked ?? false });
  const lock = (value: boolean) => { busy = value; controls.forEach(control => { control.disabled = value || !bridge; }); };
  const persist = async () => {
    if (!bridge || busy) return null;
    lock(true); feedback('正在保存本机偏好…');
    try {
      const next = await bridge.setPreferences(selected());
      if (!disposed) {
        show(next); dirty = false; feedback('偏好已保存到这台 Mac');
        doc.dispatchEvent(new doc.defaultView!.Event('goodjob:greeting-preferences-changed'));
      }
      return next;
    } catch { feedback('启动问候偏好保存失败，请重试。', true); return null; }
    finally { lock(false); }
  };
  const choose = (event: Event) => {
    const target = event.currentTarget as HTMLButtonElement;
    if (target.dataset.greetingVoice === 'male' || target.dataset.greetingVoice === 'female') {
      voice = target.dataset.greetingVoice; dirty = true;
      voices.forEach(button => button.setAttribute('aria-pressed', String(button === target)));
    }
  };
  voices.forEach(button => button.addEventListener('click', choose));
  const changed = () => { dirty = true; syncEnabledLabel(); };
  enabled?.addEventListener('change', changed); random?.addEventListener('change', changed);
  const saveClicked = () => { void persist(); };
  save?.addEventListener('click', saveClicked);
  const previewClicked = () => { void (async () => {
    if (!bridge || busy) return;
    const workspaceId = doc.body.dataset.sessionWorkspaceId ?? '';
    if (!workspaceId) { feedback('请先登录工作区。', true); return; }
    const draft = selected();
    previewing = true; lock(true); feedback(dirty ? '正在试听未保存的问候设置…' : '正在试听启动问候…');
    try { await bridge.preview(workspaceId, draft); if (!disposed) feedback(dirty ? '试听完成；保存后生效' : '试听完成'); }
    catch { feedback('试听未完成，请先检查语音服务配置。', true); }
    finally { previewing = false; if (!disposed) lock(false); }
  })(); };
  preview?.addEventListener('click', previewClicked);
  if (!bridge) { lock(false); feedback('当前不是桌面语音环境。', true); }
  else {
    lock(true);
    void bridge.status().then(value => { show(value); feedback('偏好已从这台 Mac 载入'); }, () => {
      feedback('无法读取启动问候偏好。', true);
    }).finally(() => lock(false));
  }
  return { dispose() {
    disposed = true; voices.forEach(button => button.removeEventListener('click', choose));
    enabled?.removeEventListener('change', changed); random?.removeEventListener('change', changed);
    save?.removeEventListener('click', saveClicked); preview?.removeEventListener('click', previewClicked);
    if (previewing && bridge) void bridge.stop().catch(() => undefined);
  } };
}
