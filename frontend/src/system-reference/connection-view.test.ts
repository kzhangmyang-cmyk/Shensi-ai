import assert from 'node:assert/strict';
import test from 'node:test';
import {parseHTML} from 'linkedom';
import {connectionBeginFixture as begin} from './test-fixtures';
import {createReferenceApi} from './api';
import type {ReferenceApi,ConnectionStatus} from './api';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function mount(){const mod=await import('./connection-view').catch(()=>null);assert.ok(mod,'explicit reference connection controls required');return mod.mountReferenceConnection;}
function fixture(){const {document}=parseHTML('<html><body><main></main></body></html>');document.body.dataset.sessionUserId='a';document.body.dataset.sessionWorkspaceId='team-a';return {document,host:document.querySelector('main')!};}
const button=(host:HTMLElement,action:string)=>{const node=host.querySelector<HTMLButtonElement>(`[data-reference-${action}]`);assert.ok(node);return node;};
test('embedded references are ready for default use without connection, approval or unbind actions',async()=>{
  const render=await mount(),{host,document}=fixture();const requests:Array<{path:string;method:string}>=[];
  const api=createReferenceApi({workspaceId:()=> 'team-a',fetchImpl:async(path,init)=>{
    requests.push({path,method:init?.method??'GET'});return Response.json({status:'embedded_ready',generation:0});
  }});
  const view=render(host,{api,identity:()=> 'a'});await tick();
  assert.match(host.textContent!,/应用内置参考资料，智能体默认使用/);
  assert.match(host.textContent!,/无需上传或连接/);
  assert.equal(host.querySelector('section')!.getAttribute('aria-label'),'应用内置参考资料');
  assert.equal(button(host,'refresh').textContent,'检查资料状态');
  assert.doesNotMatch(host.querySelector('.reference-connection > p')!.textContent!,/需要联网|发送固定通用主题/);
  for(const name of ['begin','complete','unbind']){const item=button(host,name);assert.equal(item.hidden,true);assert.equal(item.disabled,true);item.click();}
  const approval=host.querySelector('a')!;assert.equal(approval.hidden,true);assert.equal(approval.hasAttribute('href'),false);
  const check=host.querySelector<HTMLInputElement>('[data-reference-confirm-unbind]')!;
  assert.equal(check.parentElement!.hidden,true);assert.equal(check.disabled,true);check.checked=true;check.dispatchEvent(new document.defaultView!.Event('change'));button(host,'unbind').click();
  button(host,'refresh').click();await tick();
  assert.deepEqual(requests,[{path:'/api/v1/reference-connection',method:'GET'},{path:'/api/v1/reference-connection',method:'GET'}]);view.dispose();
});
test('central session access offers status refresh without client binding mutations',async()=>{
  const render=await mount(),{host,document}=fixture();let reads=0,writes=0;
  const view=render(host,{api:{status:async()=>{reads++;return {status:'session_ready',generation:0};},
    begin:async()=>{writes++;return begin;},complete:async()=>{writes++;return {status:'ready',generation:1};},unbind:async()=>{writes++;return {status:'unbound',generation:2};}},identity:()=> 'a'});
  await tick();assert.match(host.textContent!,/当前中央会话，无需绑定/);
  for(const name of ['begin','complete','unbind']){const item=button(host,name);assert.equal(item.hidden,true);assert.equal(item.disabled,true);item.click();}
  const check=host.querySelector<HTMLInputElement>('[data-reference-confirm-unbind]')!;
  assert.equal(check.parentElement!.hidden,true);check.checked=true;check.dispatchEvent(new document.defaultView!.Event('change'));button(host,'unbind').click();
  button(host,'refresh').click();await tick();assert.equal(reads,2);assert.equal(writes,0);view.dispose();
});
test('connection reads safe status then requires explicit begin, manual completion and confirmed unbind, without polling/replay',async()=>{
  const render=await mount(),{document,host}=fixture();assert.ok(document.defaultView);const sent:unknown[]=[];let changes=0;
  document.addEventListener('shensi:reference-connection-changed',()=>changes++);
  const api:Pick<ReferenceApi,'status'|'begin'|'complete'|'unbind'>={status:async()=>{sent.push('status');return {status:'unbound',generation:1};},
    begin:async()=>{sent.push('begin');return begin;},complete:async id=>{sent.push(['complete',id]);return {status:'ready',generation:2,centralAccountLabel:'<img>Central'};},
    unbind:async()=>{sent.push('unbind');return {status:'unbound',generation:3};}};
  const view=render(host,{api,identity:()=> 'a'});await tick();assert.deepEqual(sent,['status']);
  assert.match(host.textContent!,/公网搜索/);button(host,'begin').click();await tick();assert.deepEqual(sent,['status','begin']);
  const link=host.querySelector('a')!;assert.equal(link.href,begin.approvalUrl);assert.equal(link.getAttribute('rel'),'noopener noreferrer');
  assert.match(host.textContent!,/01234567/);button(host,'complete').click();await tick();assert.match(host.textContent!,/已连接/);assert.equal(host.querySelector('img'),null);
  button(host,'unbind').click();await tick();assert.equal(sent.includes('unbind'),false);
  const check=host.querySelector<HTMLInputElement>('[data-reference-confirm-unbind]')!;check.checked=true;check.dispatchEvent(new document.defaultView.Event('change'));
  button(host,'unbind').click();await tick();assert.deepEqual(sent,['status','begin',['complete',begin.requestId],'unbind']);assert.equal(changes,3);view.dispose();
});
test('uncertain exchange is not automatically or manually replayed from the same pending request',async()=>{
  const render=await mount(),{host}=fixture();let calls=0;
  const api={status:async()=>({status:'unbound',generation:1} as ConnectionStatus),begin:async()=>begin,complete:async()=>{calls++;throw Error('private-error');},unbind:async()=>({status:'unconfirmed',generation:2} as ConnectionStatus)};
  const view=render(host,{api,identity:()=> 'a'});await tick();button(host,'begin').click();await tick();button(host,'complete').click();await tick();button(host,'complete').click();await tick();
  assert.equal(calls,1);assert.match(host.textContent!,/未确认/);assert.doesNotMatch(host.textContent!,/private-error/);assert.equal(button(host,'complete').disabled,true);view.dispose();
});
test('pending status after remount offers cancel but never reconstructs/replays an exchange',async()=>{
  const render=await mount(),{host}=fixture();let writes=0;const view=render(host,{api:{status:async()=>({status:'pending',generation:2}),begin:async()=>{writes++;return begin;},
    complete:async()=>{writes++;return {status:'ready',generation:2};},unbind:async()=>{writes++;return {status:'unbound',generation:3};}},identity:()=> 'a'});
  await tick();assert.equal(button(host,'begin').disabled,true);assert.equal(button(host,'complete').disabled,true);assert.equal(writes,0);view.dispose();
});
test('connection identity change/dispose discards late status and cancels pending read',async()=>{
  const render=await mount();for(const dispose of [true,false]){const {document,host}=fixture();let done!:(v:ConnectionStatus)=>void,signal:AbortSignal|undefined;
    const api={status:async(s?:AbortSignal)=>{signal=s;return new Promise<ConnectionStatus>(resolve=>{done=resolve;});},begin:async()=>begin,complete:async()=>({status:'ready',generation:2} as ConnectionStatus),unbind:async()=>({status:'unbound',generation:3} as ConnectionStatus)};
    const view=render(host,{api,identity:()=> 'a'});if(dispose)view.dispose();else document.body.dataset.sessionWorkspaceId='b';await tick();assert.equal(signal?.aborted,true);
    done({status:'ready',generation:2,centralAccountLabel:'old-account'});await tick();assert.doesNotMatch(host.textContent!,/old-account/);view.dispose();}
});
