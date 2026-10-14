import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { components } from '../generated/platform-admin';
import { PlatformReferencePanel } from '../system-reference/admin-panel';
import { createReferenceAdminApi } from '../system-reference/admin-api';

type Overview = components['schemas']['Overview'];
type NewEnterprise = components['schemas']['NewEnterprise'];
type WorkspaceUpdate = components['schemas']['WorkspaceUpdate'];
type PlanDraft = components['schemas']['PlanDraft'];
type AccountAccess = components['schemas']['AccountAccess'];
type Workspace = components['schemas']['Workspace'];
type NewAccount = components['schemas']['NewAccount'];
type PasswordResetResult = components['schemas']['PasswordResetResult'];
const tabs = ['企业客户', '账号', '套餐授权', '操作日志', '默认参考库'] as const;
const planNames = { trial: '试用版', basic: '基础版', pro: '专业版' };
const featureNames = { acquisition: '获客中心', agents: '智能体中心', decision: '星盘决策模拟', crm: '客户管理', growth: '经营管理', outreach: '社媒外联' };
const localPreviewPasswordOnly = typeof location !== 'undefined' && location.origin === 'http://localhost:5681';
const date = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN') : '未设置';
async function api<T>(path: string, value?: unknown, method = value === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<T> {
  const csrf = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('gj_csrf='))?.slice(8) ?? '';
  const response = await fetch(path, { method, credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.message || '请求失败，请重试'), { status: response.status });
  return result;
}

export function App() {
  const [resetPage, setResetPage] = useState(() => typeof location !== 'undefined' && location.hash === '#reset');
  useEffect(() => { const changed = () => setResetPage(location.hash === '#reset'); window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, []);
  return resetPage ? <PasswordResetPage/> : <AdminApp/>;
}

function PasswordResetPage() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(false);
  const pending = useRef(false);
  return <main><section className="login panel"><h1>设置新密码</h1><p>粘贴运营人员提供的一次性恢复凭证。成功后旧登录会话将失效。</p>{error && <p role="alert" className="alert">{error}</p>}{done ? <p role="status" className="notice">密码已更新，请返回神思客户端，使用新密码登录。</p> : <form onSubmit={async event => {
    event.preventDefault(); if (pending.current) return;
    const form = event.currentTarget, fields = new FormData(form);
    if (fields.get('password') !== fields.get('confirm')) { setError('两次输入的密码不一致'); return; }
    pending.current = true; setBusy(true); setError('');
    try { const input: components['schemas']['PasswordResetInput'] = { token: String(fields.get('token')).trim(), password: String(fields.get('password')) }; await api('/api/auth/reset-password', input); form.reset(); setDone(true); }
    catch (error) { setError(error instanceof Error ? error.message : '密码更新失败'); }
    finally { pending.current = false; setBusy(false); }
  }}><label>一次性恢复凭证<input name="token" autoComplete="off" required/></label><label>新密码<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required/></label><label>确认新密码<input name="confirm" type="password" autoComplete="new-password" minLength={8} maxLength={128} required/></label><button className="primary" disabled={busy}>{busy ? '正在更新…' : '更新密码'}</button></form>}</section></main>;
}

function WorkspacePicker() {
  const [query, setQuery] = useState(''), [rows, setRows] = useState<Workspace[]>([]), [selected, setSelected] = useState<Workspace | null>(null), [error, setError] = useState('');
  useEffect(() => { const controller = new AbortController(); setError(''); setRows([]);
    api<Overview>(`/api/platform/v1/overview?page=1&q=${encodeURIComponent(query)}`, undefined, 'GET', controller.signal).then(result => { if (!controller.signal.aborted) setRows(result.workspaces); }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [query]);
  return <div className="workspace-picker"><label>搜索所属企业<input value={query} onChange={event => setQuery(event.target.value)} placeholder="输入企业名称或完整编号"/></label>{error && <p role="alert">{error}</p>}<label>所属企业<select name="workspaceId" required value={selected?.id ?? ''} onChange={event => setSelected(rows.find(row => row.id === event.target.value) ?? null)}><option value="">请选择企业</option>{selected && !rows.some(row => row.id === selected.id) && <option value={selected.id}>{selected.name} · {selected.id}</option>}{rows.map(row => <option key={row.id} value={row.id}>{row.name} · {row.id}</option>)}</select></label><small>显示最多 50 家匹配企业，可输入完整编号定位。{selected && ` 已选择：${selected.name}`}</small></div>;
}

function AdminApp() {
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [tab, setTab] = useState<typeof tabs[number]>('企业客户');
  const [snapshot, setSnapshot] = useState<Overview | null>(null);
  const referenceApi = useMemo(() => createReferenceAdminApi(), [snapshot]);
  const [page, setPage] = useState(1), [query, setQuery] = useState(''), [search, setSearch] = useState('');
  const [reload, setReload] = useState(0), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [form, setForm] = useState<'enterprise' | 'account' | 'plan' | Workspace | null>(null);
  const [resetCredential, setResetCredential] = useState<PasswordResetResult | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [accountInput, setAccountInput] = useState(localPreviewPasswordOnly ? 'adminkamiran' : '');
  const passwordOnlyForLogin = localPreviewPasswordOnly && accountInput.trim().toLowerCase() === 'adminkamiran';
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setSnapshot(null);
    api<Overview>(`/api/platform/v1/overview?page=${page}&q=${encodeURIComponent(search)}`, undefined, 'GET', controller.signal)
      .then(value => { if (!controller.signal.aborted) { setSnapshot(value); setNeedsAuth(false); } })
      .catch(value => { if (!controller.signal.aborted) { setError(value.message); setNeedsAuth(value.status === 401); setResetCredential(null); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload, page, search]);

  async function mutate(path: string, value: NewEnterprise | NewAccount | WorkspaceUpdate | PlanDraft | AccountAccess | Record<string, never>, reason: string, method = 'POST') {
    if (!snapshot || pending.current) return;
    pending.current = true;
    setBusy(true); setError(''); setNotice('');
    try { const result = await api<PasswordResetResult>(`/api/platform/v1${path}`, { revision: snapshot.revision, reason, value }, method); if (!alive.current) return; if (path.endsWith('/password-reset')) setResetCredential(result); setForm(null); setNotice('已保存'); setReload(value => value + 1); }
    catch (value) {
      if (!alive.current) return;
      const status = (value as { status?: number }).status;
      setError(value instanceof Error ? value.message : '保存失败');
      if (status === 401) { setNeedsAuth(true); setSnapshot(null); setForm(null); setResetCredential(null); }
      if (status === 409) {
        try {
          const current = await api<Overview>(`/api/platform/v1/overview?page=${page}&q=${encodeURIComponent(search)}`);
          if (alive.current) { setSnapshot(current); if (current.revision !== snapshot.revision) setError('数据已被其他运营者更新。已保留您的输入，请核对最新列表后再次保存。'); }
        } catch { if (alive.current) setError('数据存在冲突，最新版本读取失败。请保留输入并稍后重试。'); }
      }
    }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function authenticate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending.current) return; pending.current = true;
    const fields = new FormData(event.currentTarget); setBusy(true); setError('');
    try {
      const account = String(fields.get('account') ?? '').trim();
      if (account) await api('/api/auth/login', { email: account, password: fields.get('password') });
      await api('/api/platform/v1/session', passwordOnlyForLogin ? {} : { code: fields.get('code') });
      if (alive.current) setReload(value => value + 1);
    } catch (value) { if (alive.current) setError(value instanceof Error ? value.message : '验证失败'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function logout() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await api('/api/platform/v1/session', undefined, 'DELETE');
      if (alive.current) { setSnapshot(null); setForm(null); setResetCredential(null); setNeedsAuth(true); setNotice('运营会话已撤销'); }
    } catch (value) { if (alive.current) setError(value instanceof Error ? value.message : '退出失败，请重试'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  const count = snapshot ? tab === '企业客户' ? snapshot.workspaceCount : tab === '账号' ? snapshot.accountCount : tab === '操作日志' ? snapshot.auditCount : snapshot.plans.length : 0;
  return <div className="platform-app"><a className="reference-skip" href="#platform-main">跳至主要内容</a><aside><a className="brand" href="/admin.html">神思<span>运营管理</span></a><nav aria-label="运营导航">{tabs.map(label => <button key={label} disabled={busy || loading} aria-current={tab === label ? 'page' : undefined} onClick={() => { setTab(label); setPage(1); setForm(null); setNotice(''); setError(''); }}>{label}</button>)}</nav><button type="button" className="product-theme-toggle" data-theme-toggle>切换主题</button><p className="aside-note">企业账号与授权管理<br/>客户业务数据保持独立</p></aside><main id="platform-main" tabIndex={-1}>
    <header><div><p className="eyebrow">神思管理工作台</p><h1>{tab}</h1></div><button disabled={busy || loading || !!form} onClick={() => setReload(value => value + 1)}>刷新</button>{snapshot && <button disabled={busy || loading} onClick={() => void logout()}>退出运营</button>}</header>
    {error && <p role="alert" className="alert">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    {needsAuth ? <section className="login panel"><h2>运营身份验证</h2><p>{localPreviewPasswordOnly ? '本机隔离预览：adminkamiran 暂时只需账号密码，其他运营账号仍需验证码。' : '使用已配置运营权限的账号及身份验证器。当前已有登录会话时，可仅填写验证码。'}</p><form onSubmit={authenticate}><label>账号<input name="account" autoComplete="username" value={accountInput} onChange={event => setAccountInput(event.target.value)}/></label><label>密码<input name="password" type="password" autoComplete="current-password"/></label>{!passwordOnlyForLogin && <label>身份验证器验证码<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required/></label>}<button className="primary" disabled={busy}>验证并进入</button></form></section>
    : loading ? <p role="status">正在读取运营数据…</p> : !snapshot ? <section className="login panel"><p>当前无法读取运营数据。请确认账号具有运营权限，或刷新后重试。</p><button onClick={() => setNeedsAuth(true)}>使用运营账号验证</button></section>
    : tab === '默认参考库' ? <PlatformReferencePanel api={referenceApi} role={snapshot.role} platformRevision={snapshot.revision}/> : <>
      <section className="toolbar"><form onSubmit={event => { event.preventDefault(); if (busy || form) return; setPage(1); setSearch(query); }}><input aria-label={tab === '操作日志' ? '搜索操作日志' : '搜索企业或账号'} placeholder={tab === '操作日志' ? '搜索动作、操作者、目标或原因' : '搜索企业名称、账号或编号'} value={query} onChange={event => setQuery(event.target.value)}/><button disabled={busy || !!form}>搜索</button></form><span>{count} 条记录</span>{tab === '企业客户' && <button className="primary" disabled={busy} onClick={() => setForm('enterprise')}>创建企业</button>}{tab === '账号' && <button className="primary" disabled={busy} onClick={() => setForm('account')}>创建账号</button>}{tab === '套餐授权' && snapshot.role === 'owner' && <button className="primary" disabled={busy} onClick={() => setForm('plan')}>配置套餐版本</button>}</section>
      {resetCredential && <section className="panel editor"><h2>一次性密码恢复凭证</h2><p>请通过可信渠道交给账号本人。此凭证仅在本次显示，有效期至 {date(resetCredential.expiresAt)}。</p><label>恢复凭证<input readOnly value={resetCredential.token} onFocus={event => event.target.select()}/></label><p>账号本人打开 <a href="/admin.html#reset" target="_blank" rel="noreferrer">设置新密码页面</a>，粘贴凭证并设置密码。</p><button onClick={() => setResetCredential(null)}>已保存，关闭凭证</button></section>}
      {form && <section className="panel editor"><div className="editor-heading"><h2>{form === 'enterprise' ? '创建企业与管理员账号' : form === 'account' ? '创建企业成员账号' : form === 'plan' ? '配置套餐版本' : `管理 ${form.name}`}</h2><button disabled={busy} onClick={() => setForm(null)}>取消</button></div><form key={typeof form === 'string' ? form : form.id} onSubmit={event => {
        event.preventDefault(); const fields = new FormData(event.currentTarget), reason = String(fields.get('reason'));
        if (form === 'enterprise') void mutate('/enterprises', { name: String(fields.get('name')), contact: String(fields.get('contact')), account: String(fields.get('account')), password: String(fields.get('password')) }, reason);
        else if (form === 'account') void mutate('/accounts', { workspaceId: String(fields.get('workspaceId')), name: String(fields.get('name')), account: String(fields.get('account')), password: String(fields.get('password')), role: fields.get('role') as NewAccount['role'] }, reason);
        else if (form === 'plan') void mutate('/plans', { code: fields.get('code') as PlanDraft['code'], features: fields.getAll('features') as PlanDraft['features'], seatLimit: fields.get('seatLimit') ? Number(fields.get('seatLimit')) : null, durationDays: fields.get('durationDays') ? Number(fields.get('durationDays')) : null, published: fields.get('published') === 'on' }, reason);
        else void mutate(`/enterprises/${encodeURIComponent(form.id)}`, { status: fields.get('status') as WorkspaceUpdate['status'], planVersionId: String(fields.get('planVersionId') || '') || null, startsAt: fields.get('startsAt') ? new Date(String(fields.get('startsAt'))).toISOString() : null, expiresAt: fields.get('expiresAt') ? new Date(String(fields.get('expiresAt'))).toISOString() : null }, reason, 'PATCH');
      }}>
        {form === 'enterprise' ? <><label>企业名称<input name="name" maxLength={100} required/></label><label>联系人<input name="contact" maxLength={180}/></label><label>管理员账号<input name="account" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}" required/></label><label>初始密码<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required/></label><p>新企业处于待开通状态，选择已发布套餐和期限后才能使用业务功能。</p></>
        : form === 'account' ? <><WorkspacePicker/><label>成员姓名<input name="name" maxLength={100} required/></label><label>登录账号<input name="account" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}" required/></label><label>初始密码<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required/></label><label>成员角色<select name="role"><option value="sales">销售成员</option><option value="manager">团队经理</option></select></label><p>账号占用企业套餐席位。企业仍需有效授权才能使用业务功能。</p></>
        : form === 'plan' ? <><label>套餐<select name="code">{Object.entries(planNames).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label><fieldset><legend>可用功能</legend>{Object.entries(featureNames).map(([key, name]) => <label className="check" key={key}><input type="checkbox" name="features" value={key}/>{name}</label>)}</fieldset><label>席位数<input name="seatLimit" type="number" min={1} max={10000}/></label><label>标准有效天数<input name="durationDays" type="number" min={1} max={3650}/></label><label className="check"><input name="published" type="checkbox"/>发布此版本</label><p>未发布版本不能用于开通。新版本不会自动修改既有企业授权。</p></>
        : <><label>企业状态<select name="status" defaultValue={form.status}><option value="pending">待开通</option><option value="active">已开通</option><option value="suspended">已冻结</option></select></label><label>套餐版本<select name="planVersionId" defaultValue={form.planVersionId ?? ''}><option value="">未配置</option>{snapshot.plans.filter(row => row.published).map(row => <option key={row.id} value={row.id}>{planNames[row.code]} · v{row.version}</option>)}</select></label><label>生效时间<input name="startsAt" type="datetime-local" defaultValue={form.startsAt ? new Date(Date.parse(form.startsAt) - new Date(form.startsAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}/></label><label>到期时间<input name="expiresAt" type="datetime-local" defaultValue={form.expiresAt ? new Date(Date.parse(form.expiresAt) - new Date(form.expiresAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}/></label><p>修改企业状态或授权将撤销该企业成员的现有登录会话。</p></>}
        <label>操作原因<input name="reason" maxLength={500} required/></label><button className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
      </form></section>}
      <section className="panel table-wrap">
        {tab === '企业客户' && <table><thead><tr><th>企业</th><th>联系人</th><th>状态</th><th>套餐</th><th>到期时间</th><th>操作</th></tr></thead><tbody>{snapshot.workspaces.map(row => <tr key={row.id}><td><strong>{row.name}</strong><small>{row.id}</small></td><td>{row.contact || '—'}</td><td>{{ pending: '待开通', active: '已开通', suspended: '已冻结' }[row.status]}</td><td>{snapshot.plans.find(plan => plan.id === row.planVersionId) ? `${planNames[snapshot.plans.find(plan => plan.id === row.planVersionId)!.code]} · v${snapshot.plans.find(plan => plan.id === row.planVersionId)!.version}` : '未配置'}</td><td>{date(row.expiresAt)}</td><td><button disabled={busy} onClick={() => setForm(row)}>管理</button></td></tr>)}</tbody></table>}
        {tab === '账号' && <table><thead><tr><th>账号</th><th>企业编号</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>{snapshot.accounts.map(row => <tr key={row.id}><td><strong>{row.name}</strong><small>{row.email}</small></td><td>{row.workspaceId}</td><td>{row.role}</td><td>{row.status === 'active' ? '正常' : '停用'}</td><td><form onSubmit={event => { event.preventDefault(); const fields = new FormData(event.currentTarget); const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement; if (submitter?.value === 'password-reset') { setResetCredential(null); void mutate(`/accounts/${encodeURIComponent(row.id)}/password-reset`, {}, String(fields.get('reason'))); } else void mutate(`/accounts/${encodeURIComponent(row.id)}`, { action: (submitter?.value || (row.status === 'active' ? 'disable' : 'enable')) as AccountAccess['action'] }, String(fields.get('reason')), 'PATCH'); }}><input name="reason" aria-label={`${row.name}操作原因`} placeholder="填写操作原因" maxLength={500} required/><button name="action" value={row.status === 'active' ? 'disable' : 'enable'} disabled={busy}>{row.status === 'active' ? '停用' : '恢复'}</button><button name="action" value="revoke" disabled={busy}>撤销会话</button><button name="action" value="password-reset" disabled={busy}>密码恢复</button></form></td></tr>)}</tbody></table>}
        {tab === '套餐授权' && <table><thead><tr><th>套餐版本</th><th>功能</th><th>席位</th><th>天数</th><th>状态</th></tr></thead><tbody>{snapshot.plans.map(row => <tr key={row.id}><td>{planNames[row.code]} · v{row.version}</td><td>{row.features.map(value => featureNames[value]).join('、') || '未配置'}</td><td>{row.seatLimit ?? '未配置'}</td><td>{row.durationDays ?? '未配置'}</td><td>{row.published ? '已发布' : '草稿'}</td></tr>)}</tbody></table>}
        {tab === '操作日志' && <table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>目标</th><th>原因</th></tr></thead><tbody>{snapshot.audits.map(row => <tr key={row.id}><td>{date(row.occurredAt)}</td><td>{row.actorId}</td><td>{row.action}</td><td>{row.targetId}</td><td>{row.reason}</td></tr>)}</tbody></table>}
        {!count && <p className="empty">暂无记录。此页面仅显示已纳入运营管理的企业与账号。</p>}
      </section>
      {tab !== '套餐授权' && <footer><span>第 {page} 页 · 每页 {snapshot.pageSize} 条</span><button disabled={page <= 1 || busy || !!form} onClick={() => setPage(value => value - 1)}>上一页</button><button disabled={page * snapshot.pageSize >= count || busy || !!form} onClick={() => setPage(value => value + 1)}>下一页</button></footer>}
    </>}
  </main></div>;
}
