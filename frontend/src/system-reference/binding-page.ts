import type { components } from '../generated/system-reference';
type Pending = components['schemas']['BindingPending'];
type Approval = components['schemas']['BindingApprove'];

/** Central page only: supplied account is projected from the normal validated session. */
export function mountReferenceBindingApproval(host: HTMLElement, options: {
  // The central approval URL carries only the challenge and display code. Its
  // five-minute deadline is enforced by the server, never invented by the UI.
  pending: Pick<Pending, 'requestId' | 'displayCode'> & Partial<Pick<Pending, 'expiresAt'>>;
  account(): { subjectId: string; label: string } | null;
  approve(requestId: string, input: Approval, signal: AbortSignal): Promise<void>;
}) {
  const document = host.ownerDocument, initial = options.account(), controller = new AbortController();
  let disposed = false, attempted = false;
  const form = document.createElement('form'); form.className = 'reference-binding-approval';
  const title = document.createElement('h2'); title.textContent = '连接默认参考库';
  const account = document.createElement('p'); account.textContent = initial ? `中央账号：${initial.label}` : '请先正常登录中央账号，再打开此批准页面。';
  const code = document.createElement('p'); code.textContent = `请核对两端匹配码：${options.pending.displayCode}`;
  const label = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox';
  label.append(check, document.createTextNode('我确认这是本人发起的连接，且两端匹配码一致'));
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = '批准连接'; submit.disabled = true;
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const stillCurrent = () => !!initial && initial.subjectId === options.account()?.subjectId;
  const valid = () => !disposed && !attempted && stillCurrent() && /^\d{8}$/u.test(options.pending.displayCode)
    && (options.pending.expiresAt === undefined || Date.parse(options.pending.expiresAt) > Date.now());
  const change = () => { submit.disabled = !check.checked || !valid(); };
  const approve = async (event: Event) => {
    event.preventDefault();
    if (disposed || attempted) return;
    if (!valid() || !check.checked) { submit.disabled = true; if (!disposed) status.textContent = '账号或连接状态已变化，请重新核对。'; return; }
    attempted = true; submit.disabled = true; check.disabled = true; form.setAttribute('aria-busy', 'true');
    status.textContent = '正在批准连接…';
    try {
      await options.approve(options.pending.requestId, { displayCode: options.pending.displayCode }, controller.signal);
      if (!disposed && stillCurrent()) status.textContent = '已批准。请返回原客户端，手动完成连接。';
      else if (!disposed) status.textContent = '账号已变化，请重新核对连接状态。';
    } catch {
      if (!disposed) status.textContent = '批准结果未确认，请核对连接状态；本页不会自动重发。';
    } finally { if (!disposed) form.removeAttribute('aria-busy'); }
  };
  const onSubmit = (event: Event) => { void approve(event); };
  // A real form supports keyboard submission; explicit click keeps the same
  // behavior in small DOM renderers and prevents the default duplicate submit.
  check.addEventListener('change', change); form.addEventListener('submit', onSubmit); submit.addEventListener('click', onSubmit);
  form.append(title, account, code, label, submit, status); host.replaceChildren(form);
  return { dispose() { disposed = true; controller.abort(); check.removeEventListener('change', change); form.removeEventListener('submit', onSubmit); submit.removeEventListener('click', onSubmit); host.replaceChildren(); } };
}
