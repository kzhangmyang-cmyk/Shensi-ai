import type { CfoVoiceBridge, CfoVoiceStatus } from '../../../desktop/src/shared/cfo-voice';
declare global { interface Window { readonly shensiCfoVoice?: CfoVoiceBridge; } }

export function installCfoGreeting(doc: Document, voice?: CfoVoiceBridge, startupFinished: Promise<void> = Promise.resolve()) {
  if (!voice) return;
  let greeted = false; let disposed = false; let activeScopeKey = ''; let muted = false; let generation = 0;
  const host = doc.createElement('aside'); host.className = 'cfo-greeting-tools'; host.hidden = true;
  host.setAttribute('aria-label', '启动问候控制');
  host.innerHTML = '<span data-greeting-status role="status">启动问候</span><button type="button" data-greeting-stop aria-label="停止播报" title="停止播报"><i class="ph ph-stop-circle" aria-hidden="true"></i><span data-greeting-stop-label>停止播报</span></button><button type="button" data-greeting-mute aria-pressed="false" aria-label="静音问候" title="静音问候"><i class="ph ph-speaker-high" data-greeting-mute-icon aria-hidden="true"></i><span data-greeting-mute-label>静音问候</span></button>';
  const sidebarBottom = doc.querySelector<HTMLElement>('.replica-sidebar-bottom');
  const userControl = sidebarBottom?.querySelector<HTMLElement>('.replica-user');
  if (sidebarBottom) sidebarBottom.insertBefore(host, userControl ?? null);
  else doc.body.append(host);
  const status = host.querySelector<HTMLElement>('[data-greeting-status]')!;
  const mute = host.querySelector<HTMLButtonElement>('[data-greeting-mute]')!;
  const muteIcon = host.querySelector<HTMLElement>('[data-greeting-mute-icon]')!;
  const muteLabel = host.querySelector<HTMLElement>('[data-greeting-mute-label]')!;
  const stop = host.querySelector<HTMLButtonElement>('[data-greeting-stop]')!;
  const show = (value: CfoVoiceStatus) => {
    if (disposed) return;
    muted = value.muted; mute.setAttribute('aria-pressed', String(muted));
    mute.setAttribute('aria-label', muted ? '开启问候' : '静音问候');
    mute.title = muted ? '开启问候' : '静音问候';
    muteIcon.className = muted ? 'ph ph-speaker-slash' : 'ph ph-speaker-high';
    muteLabel.textContent = muted ? '开启问候' : '静音问候';
    status.textContent = muted ? '问候已静音' : '启动问候';
  };
  const failed = () => { if (!disposed) status.textContent = '问候暂不可用'; };
  const stopPlaying = () => { generation++; void voice.stop().then(show, failed); };
  const toggleMute = () => { if (!muted) generation++; void voice.setMuted(!muted).then(show, failed); };
  stop.addEventListener('click', stopPlaying); mute.addEventListener('click', toggleMute);
  async function refresh() {
    if (disposed) return;
    const workspaceId = doc.body.dataset.sessionWorkspaceId ?? '';
    const userId = doc.body.dataset.sessionUserId ?? '';
    const ready = doc.body.classList.contains('is-authenticated') && doc.body.dataset.sessionMode === 'real'
      && Boolean(workspaceId && userId);
    host.hidden = !ready;
    if (!ready) {
      generation++;
      if (activeScopeKey) await voice!.stop().catch(failed);
      activeScopeKey = '';
      return;
    }
    const scopeKey = `${workspaceId}\u0000${userId}`;
    if (activeScopeKey && activeScopeKey !== scopeKey) {
      generation++;
      await voice!.stop().catch(failed);
    }
    activeScopeKey = scopeKey;
    const shouldGreet = !greeted; greeted = true;
    const requestGeneration = generation;
    try {
      show(await voice!.status());
      if (shouldGreet) {
        await startupFinished;
        const sameScope = doc.body.classList.contains('is-authenticated') && doc.body.dataset.sessionMode === 'real'
          && doc.body.dataset.sessionWorkspaceId === workspaceId && doc.body.dataset.sessionUserId === userId;
        if (sameScope && requestGeneration === generation && activeScopeKey === scopeKey && !disposed)
          show(await voice!.greet(workspaceId));
      }
    } catch { failed(); }
  }
  const changed = () => { void refresh(); };
  doc.addEventListener('goodjob:auth-state-changed', changed);
  doc.addEventListener('goodjob:greeting-preferences-changed', changed);
  return { refresh, dispose() { disposed = true; generation++; doc.removeEventListener('goodjob:auth-state-changed', changed);
    doc.removeEventListener('goodjob:greeting-preferences-changed', changed);
    stop.removeEventListener('click', stopPlaying); mute.removeEventListener('click', toggleMute);
    host.remove(); void voice.stop().catch(() => undefined); } };
}
