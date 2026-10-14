import {validConnectionBegin,validConnectionStatus,type ReferenceApi,type ConnectionStatus,type ConnectionBegin} from './api';
import {notifyReferenceConnectionChange,observeReferenceIdentity,referenceIdentity} from './identity';
const labels:Record<ConnectionStatus['status'],string>={unconfigured:'默认参考库尚未配置',unbound:'默认参考库未连接',pending:'待中央账号批准',ready:'默认参考库已连接',session_ready:'默认参考库使用当前中央会话，无需绑定',embedded_ready:'应用内置参考资料，智能体默认使用',unconfirmed:'连接结果未确认',auth_required:'请正常登录后连接',forbidden:'当前账号暂无默认库访问资格',unavailable:'默认参考库暂不可用'};
export function mountReferenceConnection(host:HTMLElement,options:{api:Pick<ReferenceApi,'status'|'begin'|'complete'|'unbind'>;identity:()=>string|null}) {
  const doc=host.ownerDocument,initial=referenceIdentity(doc,options.identity);let disposed=false,invalidated=false,busy=false,attempted=false;
  let pending:ConnectionBegin|null=null,state:ConnectionStatus|null=null,controller:AbortController|null=null;
  const section=doc.createElement('section');section.className='reference-connection';section.setAttribute('aria-label','默认参考库连接');
  const title=doc.createElement('h3');title.textContent='系统默认参考库';
  const note=doc.createElement('p');note.textContent='连接中央参考库需要联网，与“公网搜索”开关独立。只发送固定通用主题，不发送原始问题、附件或历史。';
  const status=doc.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const account=doc.createElement('p'),code=doc.createElement('p');
  const link=doc.createElement('a');link.textContent='打开中央账号批准页';link.target='_blank';link.rel='noopener noreferrer';link.hidden=true;
  const actions=doc.createElement('div');actions.className='reference-actions';
  const make=(action:string,label:string)=>{const b=doc.createElement('button');b.type='button';b.setAttribute(`data-reference-${action}`,'');b.textContent=label;actions.append(b);return b;};
  const refresh=make('refresh','检查连接状态'),begin=make('begin','连接默认参考库'),complete=make('complete','已在中央批准，手动完成');
  const confirm=doc.createElement('label'),check=doc.createElement('input');check.type='checkbox';check.setAttribute('data-reference-confirm-unbind','');confirm.append(check,doc.createTextNode('确认解除或取消当前连接'));
  const unbind=make('unbind','解除或取消连接');
  const active=()=>!disposed&&!invalidated&&initial===referenceIdentity(doc,options.identity);
  const render=(message?:string)=>{
    if(disposed)return;
    const embedded=state?.status==='embedded_ready';
    section.setAttribute('aria-label',embedded?'应用内置参考资料':'默认参考库连接');
    refresh.textContent=embedded?'检查资料状态':'检查连接状态';
    note.textContent=embedded?'参考资料已随应用提供，无需上传或连接；只展示本题引用片段。':'连接中央参考库需要联网，与“公网搜索”开关独立。只发送固定通用主题，不发送原始问题、附件或历史。';
    status.textContent=message??(busy?'正在核对连接…':state?labels[state.status]:'正在读取连接状态…');
    section.setAttribute('aria-busy',String(busy));account.textContent=state?.centralAccountLabel?`中央账号：${state.centralAccountLabel}`:'';
    code.textContent=pending?`两端匹配码：${pending.displayCode} · 有效期至 ${pending.expiresAt}`:'';
    link.hidden=!pending;if(pending)link.href=pending.approvalUrl;else link.removeAttribute('href');
    refresh.disabled=busy||!active();begin.disabled=busy||!active()||state?.status!=='unbound';
    complete.disabled=busy||!active()||!pending||attempted||Date.parse(pending.expiresAt)<=Date.now();
    const noBinding=embedded||state?.status==='session_ready';
    begin.hidden=complete.hidden=confirm.hidden=unbind.hidden=noBinding;
    if(noBinding){begin.disabled=true;complete.disabled=true;}
    check.disabled=busy||!active()||!state||!['ready','pending','unconfirmed'].includes(state.status);
    unbind.disabled=check.disabled||!check.checked;
  };
  const invalidate=()=>{invalidated=true;controller?.abort();pending=null;state=null;check.checked=false;render('账号或工作区已变化，请重新打开连接设置。');};
  const unobserve=observeReferenceIdentity(doc,options.identity,invalidate);
  const execute=async(kind:'status'|'begin'|'complete'|'unbind')=>{
    if(!active()||busy)return;
    if(kind==='begin'&&state?.status!=='unbound')return;
    if(kind==='complete'&&(!pending||attempted||Date.parse(pending.expiresAt)<=Date.now()))return;
    if(kind==='unbind'&&(!check.checked||check.disabled))return;
    const requestId=pending?.requestId;
    if(kind==='complete')attempted=true;
    if(kind!=='status')notifyReferenceConnectionChange(doc);
    const current=new AbortController();controller=current;busy=true;render();
    try {
      if(kind==='begin'){
        const result=await options.api.begin(current.signal);if(!active())return;if(!validConnectionBegin(result))throw Error('invalid');
        pending=result;attempted=false;state={status:'pending',generation:state?.generation??0};
      }else{
        const result=kind==='status'?await options.api.status(current.signal):kind==='complete'?await options.api.complete(requestId!,current.signal):await options.api.unbind(current.signal);
        if(!active())return;if(!validConnectionStatus(result))throw Error('invalid');
        if(kind==='status'&&state&&(result.generation!==state.generation||result.centralAccountLabel!==state.centralAccountLabel||result.status!==state.status))notifyReferenceConnectionChange(doc);
        state=result;if(result.status!=='pending'||kind==='unbind')pending=null;check.checked=false;
      }
      busy=false;render();
    }catch{if(active()){busy=false;state={status:kind==='status'?'unavailable':'unconfirmed',generation:state?.generation??0};render(kind==='status'?labels.unavailable:'连接结果未确认；不会自动重发，请检查状态或解除连接。');}}
    finally {if(controller===current)controller=null;}
  };
  const onRefresh=()=>{void execute('status');},onBegin=()=>{void execute('begin');},onComplete=()=>{void execute('complete');},onUnbind=()=>{void execute('unbind');},onCheck=()=>render();
  refresh.addEventListener('click',onRefresh);begin.addEventListener('click',onBegin);complete.addEventListener('click',onComplete);unbind.addEventListener('click',onUnbind);check.addEventListener('change',onCheck);
  section.append(title,note,status,account,code,link,confirm,actions);host.replaceChildren(section);void execute('status');
  return {dispose(){disposed=true;controller?.abort();unobserve();refresh.removeEventListener('click',onRefresh);begin.removeEventListener('click',onBegin);complete.removeEventListener('click',onComplete);unbind.removeEventListener('click',onUnbind);check.removeEventListener('change',onCheck);host.replaceChildren();}};
}
