import type {components} from '../generated/xiaohongshu-messaging';
import {csrfFromCookie} from '../acquisition/csrf';
type Schema=components['schemas'];
interface State {
  accounts:Schema['XhsAccount'][];drafts:Schema['XhsDraft'][];busy:boolean;error:string|null;
  loginAccountId:string|null;accountId?:string;recipient?:string;body?:string;displayName?:string;
  edits?:Record<string,{recipient:string;body:string}>;
}
interface Bridge {
  open(workspace:string,account:string):Promise<unknown>;
  connect(workspace:string,account:string,name:string):Promise<unknown>;
  close(workspace:string,account:string):Promise<unknown>;
  send(workspace:string,draft:string,revision:number):Promise<unknown>;
}
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const labels:Record<Schema['XhsDraft']['status'],string>={draft:'待审批',approved:'已批准 · 待确认发送',executing:'正在发送',unknown:'结果未知 · 不自动重发',confirmed:'平台已确认',rejected:'平台拒绝'};
export function xhsErrorMessage(error:unknown):string {
  const message=error instanceof Error?error.message:'操作失败';
  const code=/^(?:Error invoking remote method 'shensi:xiaohongshu': Error: )?(xhs_[a-z_]+)$/u.exec(message)?.[1];
  if(code==='xhs_sending_disabled')return '当前尚未启用小红书发送，账号登录可单独使用。';
  if(code==='xhs_login_not_open')return '登录窗口已关闭或尚未打开，请先打开登录浏览器。';
  return message;
}
export function renderXhs(state:State) {
  const disabled=state.busy?'disabled':'';
  return `<section class="xhs-workspace" aria-label="小红书私信"><header><div><p class="xhs-eyebrow">社媒对话 / 小红书</p><h2>小红书私信</h2><p>专用浏览器登录，逐条核对收件人与正文。</p></div><button type="button" data-xhs-back>返回抖音</button></header>
    ${state.error?`<p role="alert" class="xhs-error">${escape(state.error)}</p>`:''}
    <p role="status" aria-live="polite">${state.busy?'正在处理，请稍候…':'每条私信需先批准，再确认发送。结果未知时不会重发。'}</p>
    <div class="xhs-grid"><section class="xhs-card"><h3>1 · 发送账号</h3>
      <label>账号备注<input name="xhs-name" value="${escape(state.displayName??'小红书账号')}" maxlength="100" ${disabled}></label>
      <div class="xhs-actions"><button type="button" data-xhs-open-login ${disabled}>打开登录浏览器</button>
      ${state.loginAccountId?`<button type="button" data-xhs-connect ${disabled}>已登录，连接账号</button><button type="button" data-xhs-cancel-login ${disabled}>关闭登录窗口</button>`:''}</div>
      <p class="xhs-help">在打开的官方页面手动登录，然后点击“已登录，连接账号”。</p>
      <label>发送账号<select name="xhs-account" ${disabled}><option value="">请选择已连接账号</option>${state.accounts.map(a=>`<option value="${escape(a.accountId)}" ${state.accountId===a.accountId?'selected':''}>${escape(a.displayName)} · ${a.state==='ready'?'已连接':'需重新连接'}</option>`).join('')}</select></label>
      <button type="button" data-xhs-disconnect ${disabled || !state.accountId?'disabled':''}>断开当前账号</button></section>
    <section class="xhs-card"><h3>2 · 新建私信草稿</h3><label>精确收件人用户 ID<input name="xhs-recipient" maxlength="160" value="${escape(state.recipient)}" ${disabled}></label>
      <label>私信正文<textarea name="xhs-body" maxlength="800" rows="6" ${disabled}>${escape(state.body)}</textarea></label>
      <button type="button" data-xhs-create ${disabled}>保存待审批草稿</button></section></div>
    <section class="xhs-card"><div class="xhs-actions"><h3>3 · 审批与发送记录</h3><button type="button" data-xhs-refresh ${disabled}>刷新记录</button></div>
      ${state.drafts.length?state.drafts.map(d=>`<article class="xhs-draft" data-xhs-draft="${escape(d.id)}"><div class="xhs-actions"><strong>${escape(labels[d.status])}</strong><span>版本 ${d.revision}</span></div>
        <p>收件人：${escape(d.recipientId)}</p><p class="xhs-message">${escape(d.body)}</p>
        ${d.receipt?.status==='confirmed'?`<p>平台消息 ID：${escape(d.receipt.serverMessageId)}</p>`:''}
        ${d.status==='draft'||d.status==='approved'?`<label>编辑收件人<input data-xhs-edit-recipient value="${escape(state.edits?.[d.id]?.recipient??d.recipientId)}" maxlength="160" ${disabled}></label><label>编辑正文<textarea data-xhs-edit-body maxlength="800" ${disabled}>${escape(state.edits?.[d.id]?.body??d.body)}</textarea></label><div class="xhs-actions"><button type="button" data-xhs-edit="${escape(d.id)}" ${disabled}>保存修改（撤销批准）</button>
        ${d.status==='draft'?`<button type="button" data-xhs-approve="${escape(d.id)}" ${disabled}>批准当前内容</button>`:`<button type="button" data-xhs-send="${escape(d.id)}" ${disabled}>核对并发送</button>`}</div>`:''}</article>`).join(''):'<p class="xhs-empty">暂无私信草稿。连接账号后，填写精确收件人与正文开始。</p>'}
    </section></section>`;
}

export function createXhsController(host:HTMLElement) {
  let state:State={accounts:[],drafts:[],busy:false,error:null,loginAccountId:null};
  let active=false,epoch=0,workspace='',actor='';
  const draw=()=>{if(current())host.innerHTML=renderXhs(state);};
  const current=()=>active && document.body.dataset.sessionWorkspaceId===workspace && document.body.dataset.sessionUserId===actor;
  const bridge=()=>{const value=(window as Window & {shensiXiaohongshu?:Bridge}).shensiXiaohongshu;
    if(!value)throw new Error('请在桌面应用中使用小红书私信');return value;};
  async function api(path:string,method='GET',input?:unknown) {
    if(!current())throw new Error('登录身份已变更，请重新打开页面');
    const headers:Record<string,string>={'X-Workspace-Id':workspace};
    if(input!==undefined){headers['Content-Type']='application/json';headers['X-CSRF-Token']=csrfFromCookie(document.cookie);}
    const response=await fetch(`/api/v1/acquisition/xiaohongshu${path}`,{method,credentials:'include',headers,
      body:input===undefined?undefined:JSON.stringify(input),signal:AbortSignal.timeout(15000)});
    const value=await response.json();
    if(!response.ok)throw new Error(value?.code==='xhs_sending_disabled'?'当前尚未启用小红书发送，账号登录可单独使用。':value?.code??'请求失败');
    return value;
  }
  async function refresh() {
    const version=epoch;
    const [accounts,drafts]=await Promise.all([api('/accounts'),api('/drafts')]);
    if(version!==epoch || !current())return;
    state.accounts=accounts.items;state.drafts=drafts.items;
  }
  async function perform(action:()=>Promise<void>) {
    if(state.busy)return;
    const version=epoch;state.busy=true;state.error=null;draw();
    try{await action();}catch(error){if(version===epoch)state.error=xhsErrorMessage(error);}
    finally{if(version===epoch){state.busy=false;draw();}}
  }
  const onInput=()=>{
    state.displayName=host.querySelector<HTMLInputElement>('[name="xhs-name"]')?.value;
    state.accountId=host.querySelector<HTMLSelectElement>('[name="xhs-account"]')?.value;
    state.recipient=host.querySelector<HTMLInputElement>('[name="xhs-recipient"]')?.value;
    state.body=host.querySelector<HTMLTextAreaElement>('[name="xhs-body"]')?.value;
    const disconnect=host.querySelector<HTMLButtonElement>('[data-xhs-disconnect]');
    if(disconnect)disconnect.disabled=state.busy || !state.accountId;
    for(const article of host.querySelectorAll<HTMLElement>('[data-xhs-draft]')) {
      const recipient=article.querySelector<HTMLInputElement>('[data-xhs-edit-recipient]');
      const body=article.querySelector<HTMLTextAreaElement>('[data-xhs-edit-body]');
      if(recipient&&body)(state.edits??={})[article.dataset.xhsDraft!]={recipient:recipient.value,body:body.value};
    }
  };
  const onClick=(event:Event)=>{
    const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button || !current() || state.busy)return;
    onInput();
    const draft=state.drafts.find(d=>d.id===(button.dataset.xhsEdit??button.dataset.xhsApprove??button.dataset.xhsSend));
    const article=button.closest('article');
    const edit={recipientId:article?.querySelector<HTMLInputElement>('[data-xhs-edit-recipient]')?.value,
      body:article?.querySelector<HTMLTextAreaElement>('[data-xhs-edit-body]')?.value};
    if(button.hasAttribute('data-xhs-back'))return;
    void perform(async()=>{
      if(draft && (button.dataset.xhsApprove || button.dataset.xhsSend)
        && (edit.body!==draft.body || edit.recipientId!==draft.recipientId))throw new Error('请先保存修改，再批准新内容。');
      if(button.hasAttribute('data-xhs-open-login')){const id=state.accountId||crypto.randomUUID();await bridge().open(workspace,id);if(current())state.loginAccountId=id;}
      else if(button.hasAttribute('data-xhs-connect')&&state.loginAccountId){await bridge().connect(workspace,state.loginAccountId,state.displayName||'小红书账号');state.accountId=state.loginAccountId;await refresh();}
      else if(button.hasAttribute('data-xhs-cancel-login')&&state.loginAccountId){await bridge().close(workspace,state.loginAccountId);state.loginAccountId=null;await refresh();}
      else if(button.hasAttribute('data-xhs-disconnect')&&state.accountId){await bridge().close(workspace,state.accountId);await refresh();}
      else if(button.hasAttribute('data-xhs-create')){const account=state.accounts.find(a=>a.accountId===state.accountId&&a.state==='ready');
        if(!account)throw new Error('请先连接并选择发送账号');
        await api('/drafts','POST',{id:crypto.randomUUID(),accountId:account.accountId,deviceId:account.deviceId,recipientId:state.recipient,body:state.body});
        state.recipient='';state.body='';await refresh();}
      else if(draft&&button.dataset.xhsEdit){await api(`/drafts/${draft.id}`,'PATCH',{revision:draft.revision,...edit});if(state.edits)delete state.edits[draft.id];await refresh();}
      else if(draft&&button.dataset.xhsApprove){await api(`/drafts/${draft.id}/approve`,'POST',{revision:draft.revision});await refresh();}
      else if(draft&&button.dataset.xhsSend){if(!confirm(`发送账号：${state.accounts.find(a=>a.accountId===draft.accountId)?.displayName??draft.accountId}\n收件人：${draft.recipientId}\n正文：${draft.body}\n\n确认发送这条已批准的私信？`))return;
        await bridge().send(workspace,draft.id,draft.revision);await refresh();}
      else if(button.hasAttribute('data-xhs-refresh'))await refresh();
    });
  };
  return {async open(){if(current())return;active=true;epoch++;workspace=document.body.dataset.sessionWorkspaceId??'';actor=document.body.dataset.sessionUserId??'';
    state={accounts:[],drafts:[],busy:false,error:null,loginAccountId:null};host.addEventListener('input',onInput);host.addEventListener('change',onInput);host.addEventListener('click',onClick);await perform(refresh);},
    deactivate(){active=false;epoch++;host.removeEventListener('input',onInput);host.removeEventListener('change',onInput);host.removeEventListener('click',onClick);}};
}
