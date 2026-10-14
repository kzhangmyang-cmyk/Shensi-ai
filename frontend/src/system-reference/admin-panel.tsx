import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { validReleaseId, type ReferenceAdminApi, type ReferenceReleaseDetail, type ReferenceRelease, type PublicationAction } from './admin-api';

const statuses = { staging: '暂存中', ready: '可发布', published: '已发布', revoked: '已撤回', failed: '未完成' };
export function PlatformReferencePanel(props: { api: ReferenceAdminApi; role: 'owner' | 'operator'; platformRevision: number }) {
  const generation = useMemo(() => crypto.randomUUID(), [props.api, props.role, props.platformRevision]);
  return props.role === 'owner' ? <ReferenceOwnerPanel key={generation} api={props.api}/> : <section className="reference-admin-panel"><p>仅平台 owner 可维护默认参考库。此账号没有维护权限。</p></section>;
}
function ReferenceOwnerPanel({ api }: { api: ReferenceAdminApi }) {
  const statusId = useId();
  const [invalidId, setInvalidId] = useState(false);
  const lifetime = useRef(new AbortController()), pending = useRef(false), attempted = useRef(false);
  const [detail, setDetail] = useState<ReferenceReleaseDetail | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState<{ release: ReferenceRelease; action: PublicationAction; key: string } | null>(null);
  useEffect(() => {
    const leave = () => {
      lifetime.current.abort(); lifetime.current = new AbortController(); pending.current = false;
      setDetail(null); setConfirmed(false); setReason(''); setBusy(false); setInvalidId(false);
      setMessage(attempted.current ? '操作已发起，请核对服务端状态；本页不会重发。' : '页面已离开，请重新读取候选并核对。');
    };
    const visibility = () => { if (document.visibilityState === 'hidden') leave(); };
    window.addEventListener('blur', leave); document.addEventListener('visibilitychange', visibility);
    return () => { lifetime.current.abort(); window.removeEventListener('blur', leave); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const inspect = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (pending.current || attempted.current || lifetime.current.signal.aborted) return;
    const releaseId = event.currentTarget.querySelector<HTMLInputElement>('[name=releaseId]')!.value.trim();
    if (!validReleaseId(releaseId)) { setInvalidId(true); setMessage('请填写完整、有效的候选版本编号。'); return; }
    setInvalidId(false);
    pending.current = true; setBusy(true); setDetail(null); setConfirmed(false); setReason(''); setMessage('');
    const signal = lifetime.current.signal;
    try { const value = await api.inspect(releaseId, signal); if (!signal.aborted) setDetail(value); }
    catch { if (!signal.aborted) setMessage('候选读取失败，请确认正常 owner 登录及多因素验证，或核对服务配置。'); }
    finally { if (!signal.aborted) { pending.current = false; setBusy(false); } }
  };
  const transition = async (action: PublicationAction) => {
    if (!detail || !confirmed || !reason.trim() || reason.trim().length > 500 || pending.current || attempted.current || lifetime.current.signal.aborted) return;
    attempted.current = true; pending.current = true; setBusy(true); setConfirmed(false); setMessage('');
    const command = { release: detail.release, action, key: crypto.randomUUID() };
    setUnconfirmed(command);
    const signal = lifetime.current.signal;
    try {
      const release = await api.transition(command.release, action, { reason: reason.trim() }, command.key, signal);
      if (!signal.aborted) { setDetail({ ...detail, release }); setUnconfirmed(null); setMessage(action === 'publish' ? '已发布此版本。' : '已撤回此版本。'); }
    } catch { if (!signal.aborted) { setUnconfirmed(command); setMessage('结果未确认；不会自动重发，请核对服务端操作状态。'); } }
    finally { if (!signal.aborted) { pending.current = false; setBusy(false); } }
  };
  const checkCommand = async () => {
    if (!unconfirmed || pending.current || lifetime.current.signal.aborted) return;
    pending.current = true; setBusy(true);
    const signal = lifetime.current.signal;
    try {
      const result = await api.commandStatus(unconfirmed.release, unconfirmed.action, unconfirmed.key, signal);
      if (signal.aborted) return;
      if (result.outcome === 'not_observed') setMessage('未查到已提交的操作记录；不会重发，请由维护者核对。');
      else { setDetail(current => current ? { ...current, release: result.release } : null); setUnconfirmed(null); setMessage(`操作记录已确认：${statuses[result.release.status]}。`); }
    } catch { if (!signal.aborted) setMessage('操作状态仍未确认；不会重发。'); }
    finally { if (!signal.aborted) { pending.current = false; setBusy(false); } }
  };
  const complete = !!detail && detail.sources.every(source => source.complete && source.totalChunks !== null && source.receivedChunks === source.totalChunks);
  const disabled = busy || attempted.current || !confirmed || !reason.trim() || reason.trim().length > 500;
  return <section className="reference-admin-panel" aria-label="默认参考库维护" aria-busy={busy}>
    <p>通过候选版本编号核对元数据。发布与撤回均需正常 owner 登录和多因素验证。</p>
    <form onSubmit={inspect}><label>候选版本编号<input name="releaseId" autoComplete="off" maxLength={36} required disabled={busy || attempted.current} aria-invalid={invalidId} aria-describedby={statusId} onInput={() => setInvalidId(false)}/></label><button disabled={busy || attempted.current}>读取候选</button></form>
    <p id={statusId} role="status" aria-live="polite">{message}</p>
    {unconfirmed && <button data-reference-command-check disabled={busy} onClick={() => void checkCommand()}>核对操作状态</button>}
    {!detail && !busy && <p>尚未选择候选版本。</p>}
    {detail && <>
      <dl><dt>候选版本</dt><dd>{detail.release.id}</dd><dt>书库</dt><dd>{detail.release.corpusId}</dd><dt>状态</dt><dd>{statuses[detail.release.status]}</dd><dt>候选修订号</dt><dd>{detail.release.revision}</dd><dt>清单哈希</dt><dd>{detail.release.manifestHash}</dd><dt>读取时的发布版本</dt><dd>{detail.activeReleaseId ?? '尚无发布版本'}</dd></dl>
      {detail.manifest.sources.map(source => { const received = detail.sources.find(row => row.sourceHash === source.sourceHash)!; return <article key={source.sourceHash}>
        <h3>{source.title}</h3><dl><dt>适用角色</dt><dd>{source.roles.join('、')}</dd><dt>原件哈希</dt><dd>{source.sourceHash}</dd><dt>产物哈希</dt><dd>{source.artifactHash}</dd><dt>提取文本哈希</dt><dd>{source.parsedHash}</dd><dt>解析器版本</dt><dd>{source.parserVersion}</dd>
          <dt>页面覆盖</dt><dd>物理页 {source.coverage.totalPages ?? '未知'} · 已提取 {source.coverage.extractedPages ?? '未知'} · 缺页 {source.coverage.missingPages.join('、') || '无已记录缺页'}</dd>
          <dt>索引接收</dt><dd>{received.receivedChunks} / {received.totalChunks ?? '未知'} · {received.complete ? '接收完成' : '未完成'}</dd><dt>质量提示</dt><dd>{source.warnings.length ? <ul>{source.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : '无已记录质量提示'}</dd></dl>
      </article>; })}
      <div className="reference-admin-confirm"><label>操作原因<input name="reason" maxLength={500} disabled={busy || attempted.current} value={reason} onInput={event => setReason(event.currentTarget.value)}/></label>
        <label className="reference-check"><input name="confirm" type="checkbox" checked={confirmed} disabled={busy || attempted.current} onChange={() => {}} onClick={event => setConfirmed(event.currentTarget.checked)}/>我已核对以上版本、清单哈希、缺页和质量提示，确认执行所选操作</label>
        <div><button data-reference-publish disabled={disabled || detail.release.status !== 'ready' || !complete} onClick={() => void transition('publish')}>发布此版本</button>
          <button data-reference-revoke disabled={disabled || detail.release.status !== 'published'} onClick={() => void transition('revoke')}>撤回此版本</button></div></div>
    </>}
  </section>;
}
