import { csrfFromCookie } from '../acquisition/csrf';
import { mountReferenceBindingApproval } from './binding-page';
import { centralRequest } from './central-http';

/** Central-origin entry. Uses the existing normal login, never a reader token. */
export function mountReferenceApprovalPage(host: HTMLElement, options: {
  search: string;
  hash?: string;
  cookie?: () => string;
  fetchImpl?: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const document = host.ownerDocument, cookie = options.cookie ?? (() => document.cookie), fetcher = options.fetchImpl ?? fetch;
  let controller = new AbortController();
  let disposed = false, attempted = false, epoch = 0, approval: ReturnType<typeof mountReferenceBindingApproval> | undefined;
  const params = new URLSearchParams(options.search), requestId = params.get('requestId'), displayCode = params.get('displayCode');
  const validInput = !options.hash && params.size === 2 && !!requestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(requestId) && !!displayCode && /^\d{8}$/u.test(displayCode);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const login = document.createElement('a'); login.href = '/'; login.target = '_blank'; login.rel = 'noopener noreferrer'; login.textContent = '前往中央登录';
  const recheck = document.createElement('button'); recheck.type = 'button'; recheck.dataset.referenceRecheck = ''; recheck.textContent = '重新检查登录';
  const onRecheck = () => { void load(); }; recheck.addEventListener('click', onRecheck);
  host.replaceChildren(status);
  const csrf = () => { try { return csrfFromCookie(cookie()); } catch { return null; } };
  async function session(signal: AbortSignal) {
    const capturedCsrf = csrf();
    const value = await centralRequest(fetcher, '/api/auth/me', { method: 'GET', headers: { Accept: 'application/json' } }, signal);
    if (!value || typeof value !== 'object' || !('user' in value)) throw new Error('session_invalid');
    const user = value.user;
    if (!user || typeof user !== 'object' || !('id' in user) || typeof user.id !== 'string' || !user.id
      || !('teamId' in user) || typeof user.teamId !== 'string' || !user.teamId
      || !('authVersion' in user) || typeof user.authVersion !== 'number' || !Number.isSafeInteger(user.authVersion) || user.authVersion < 1
      || !('name' in user) || typeof user.name !== 'string' || !user.name || !capturedCsrf || capturedCsrf !== csrf()) throw new Error('session_invalid');
    signal.throwIfAborted();
    return { subjectId: JSON.stringify([user.id, user.teamId, user.authVersion]), label: user.name, csrf: capturedCsrf };
  }
  async function load() {
    if (disposed || attempted || !validInput) return;
    const generation = ++epoch; controller.abort(); controller = new AbortController();
    approval?.dispose(); approval = undefined; host.replaceChildren(status); recheck.disabled = true;
    status.textContent = '正在核对中央登录账号…';
    try {
      const user = await session(controller.signal);
      if (disposed || generation !== epoch) return;
      approval = mountReferenceBindingApproval(host, {
        pending: { requestId: requestId!, displayCode: displayCode! },
        account: () => csrf() === user.csrf ? user : null,
        approve: async (id, input, signal) => {
          if (attempted || csrf() !== user.csrf) throw new Error('session_changed');
          attempted = true;
          const current = await session(signal);
          if (current.subjectId !== user.subjectId || current.csrf !== user.csrf) throw new Error('session_changed');
          await centralRequest(fetcher, `/api/v1/system-reference/binding-requests/${id}/approve`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': user.csrf }, body: JSON.stringify(input) }, signal, true);
          signal.throwIfAborted(); if (csrf() !== user.csrf) throw new Error('session_changed');
        }
      });
    } catch { if (!disposed && generation === epoch) { status.textContent = '无法核对中央登录账号，请在中央首页正常登录，再返回此页重新检查。'; host.replaceChildren(status, login, recheck); } }
    finally { if (!disposed && generation === epoch) recheck.disabled = false; }
  }
  const leave = () => {
    if (disposed || !validInput) return;
    epoch++; controller.abort(); approval?.dispose(); approval = undefined;
    status.textContent = attempted ? '批准结果需在原客户端核对；本页不会重复提交。' : '页面已离开，请重新检查中央登录账号并核对匹配码。';
    recheck.disabled = false; host.replaceChildren(status, ...(attempted ? [] : [login, recheck]));
  };
  const visibility = () => { if (document.visibilityState === 'hidden') leave(); };
  document.defaultView?.addEventListener('blur', leave); document.addEventListener('visibilitychange', visibility);
  if (!validInput) {
    status.textContent = '连接申请无效，请从原客户端重新发起连接。';
  } else { void load(); }
  return { dispose() { disposed = true; epoch++; controller.abort(); recheck.removeEventListener('click', onRecheck);
    document.defaultView?.removeEventListener('blur', leave); document.removeEventListener('visibilitychange', visibility); approval?.dispose(); host.replaceChildren(); } };
}
