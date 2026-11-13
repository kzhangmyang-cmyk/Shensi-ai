import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
const id='55555555-5555-4555-8555-555555555555',search=`?requestId=${id}&displayCode=01234567`;
const user={id:'synthetic-user',teamId:'synthetic-team',authVersion:1,name:'<img>中央用户'};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('central entry uses normal session, explicit matching-code approval and accepts only the 204 acknowledgement',async()=>{
  const module=await import('./approval-page').catch(()=>null);assert.ok(module,'normal-session central approval entry is required');
  const {document}=parseHTML('<html><body><main></main></body></html>'),host=document.querySelector('main')!,calls:Array<{path:string;init?:RequestInit}>=[];
  const view=module.mountReferenceApprovalPage(host,{search,cookie:()=> 'gj_csrf=synthetic-csrf',fetchImpl:async(path,init)=>{
    calls.push({path,init});if(path==='/api/auth/me')return new Response(JSON.stringify({user}),{headers:{'content-type':'application/json'}});
    assert.equal(path,`/api/v1/system-reference/binding-requests/${id}/approve`);return new Response(null,{status:204});
  }});
  try{
    await tick();assert.equal(calls.length,1);assert.match(host.textContent!,/中央用户/);assert.equal(host.querySelector('img'),null);
    const checkbox=host.querySelector<HTMLInputElement>('input[type=checkbox]')!;assert.ok(checkbox);assert.equal(host.querySelector<HTMLButtonElement>('form button')!.disabled,true);
    checkbox.checked=true;checkbox.dispatchEvent(new document.defaultView!.Event('change'));host.querySelector<HTMLButtonElement>('form button')!.click();await tick();
    const writes=calls.filter(c=>c.init?.method==='POST');assert.equal(writes.length,1);const post=writes[0].init!;
    assert.equal(post.credentials,'same-origin');assert.equal(new Headers(post.headers).get('x-csrf-token'),'synthetic-csrf');assert.equal(new Headers(post.headers).has('authorization'),false);
    assert.deepEqual(JSON.parse(String(post.body)),{displayCode:'01234567'});assert.match(host.textContent!,/已批准/);
    host.querySelector<HTMLButtonElement>('form button')!.click();await tick();assert.equal(calls.filter(c=>c.init?.method==='POST').length,1);
  }finally{view.dispose();}
});
test('leaving the approval page clears the checked consent and aborts late work; returning requires an explicit session recheck',async()=>{
  const {mountReferenceApprovalPage}=await import('./approval-page');
  const {document}=parseHTML('<html><body><main></main></body></html>'),host=document.querySelector('main')!;
  let reads=0;
  const view=mountReferenceApprovalPage(host,{search,cookie:()=> 'gj_csrf=synthetic-csrf',fetchImpl:async()=>{
    reads++;return new Response(JSON.stringify({user}),{headers:{'content-type':'application/json'}});
  }});
  try{
    await tick();const check=host.querySelector<HTMLInputElement>('input')!;check.checked=true;check.dispatchEvent(new document.defaultView!.Event('change'));
    document.defaultView!.dispatchEvent(new document.defaultView!.Event('blur'));await tick();
    assert.equal(!!host.querySelector('form'),false);assert.match(host.textContent!,/重新检查/);
    document.defaultView!.dispatchEvent(new document.defaultView!.Event('focus'));await tick();assert.equal(reads,1);
    host.querySelector<HTMLButtonElement>('[data-reference-recheck]')!.click();await tick();assert.equal(reads,2);assert.equal(host.querySelector<HTMLButtonElement>('form button')!.disabled,true);
  }finally{view.dispose();}
});
test('central session reads reject wrong MIME and oversized streamed bodies instead of trusting advertised length',async()=>{
  const {mountReferenceApprovalPage}=await import('./approval-page');
  for(const response of [new Response(JSON.stringify({user}),{headers:{'content-type':'text/html'}}),
    new Response(JSON.stringify({user,padding:'x'.repeat(262144)}),{headers:{'content-type':'application/json','content-length':'1'}})]){
    const {document}=parseHTML('<html><body><main></main></body></html>'),host=document.querySelector('main')!;
    const view=mountReferenceApprovalPage(host,{search,cookie:()=> 'gj_csrf=synthetic-csrf',fetchImpl:async()=>response});
    try{await tick();assert.equal(!!host.querySelector('form'),false,'untrusted session body must not produce an approval form');assert.match(host.textContent!,/无法核对/);assert.doesNotMatch(host.textContent!,/padding/);}finally{view.dispose();}
  }
});
test('an account or CSRF change after display cannot approve the old challenge, and an uncertain write is not replayed',async()=>{
  const {mountReferenceApprovalPage}=await import('./approval-page');
  for(const change of ['csrf','account','uncertain'] as const){
    const {document}=parseHTML('<html><body><main></main></body></html>'),host=document.querySelector('main')!;
    let csrf='first',active=user,writes=0;
    const view=mountReferenceApprovalPage(host,{search,cookie:()=> `gj_csrf=${csrf}`,fetchImpl:async(_path,init)=>{
      if(init?.method==='POST'){writes++;throw new Error('synthetic_uncertain');}
      return new Response(JSON.stringify({user:active}),{headers:{'content-type':'application/json'}});
    }});
    try{
      await tick();const check=host.querySelector<HTMLInputElement>('input')!;check.checked=true;check.dispatchEvent(new document.defaultView!.Event('change'));
      if(change==='csrf')csrf='second';if(change==='account')active={...user,id:'other-user'};
      host.querySelector<HTMLButtonElement>('form button')!.click();await tick();
      assert.equal(writes,change==='uncertain'?1:0,change);assert.doesNotMatch(host.textContent!,/已批准/);
      host.querySelector<HTMLButtonElement>('[data-reference-recheck]')?.click();await tick();
      host.querySelector<HTMLButtonElement>('form button')?.click();await tick();assert.equal(writes,change==='uncertain'?1:0);
    }finally{view.dispose();}
  }
});
test('signed-out users use the existing login and explicitly recheck the session without approving automatically',async()=>{
  const {mountReferenceApprovalPage}=await import('./approval-page');
  const {document}=parseHTML('<html><body><main></main></body></html>'),host=document.querySelector('main')!;
  let loggedIn=false,reads=0,writes=0;
  const view=mountReferenceApprovalPage(host,{search,cookie:()=> 'gj_csrf=synthetic-csrf',fetchImpl:async(_path,init)=>{
    if(init?.method==='POST'){writes++;return new Response(null,{status:204});}
    reads++;return loggedIn?new Response(JSON.stringify({user}),{headers:{'content-type':'application/json'}}):new Response(null,{status:401});
  }});
  try{
    await tick();const login=host.querySelector('a');assert.equal(login?.getAttribute('href'),'/');assert.equal(login?.getAttribute('target'),'_blank');
    assert.match(login?.getAttribute('rel')??'',/noopener/);assert.equal(host.querySelector('form'),null);
    loggedIn=true;host.querySelector<HTMLButtonElement>('[data-reference-recheck]')!.click();await tick();
    assert.equal(reads,2);assert.equal(writes,0);assert.equal(!!host.querySelector<HTMLInputElement>('input')?.checked,false);
    assert.equal(host.querySelector<HTMLButtonElement>('form button')?.disabled,true);assert.match(host.textContent!,/中央用户/);
  }finally{view.dispose();}
});
test('invalid challenge URLs do not read a session or reveal a submit form',async()=>{
  const {mountReferenceApprovalPage}=await import('./approval-page');
  for(const value of ['',search+'&displayCode=01234567',search+'&returnTo=https://invalid.example',search.replace(id,'bad-id'),search.replace('01234567','1234')]){
    const {document}=parseHTML('<html><body><main></main></body></html>'),host=document.querySelector('main')!;let calls=0;
    const view=mountReferenceApprovalPage(host,{search:value,fetchImpl:async()=>{calls++;throw new Error('unreachable');}});
    await tick();assert.equal(calls,0);assert.equal(!!host.querySelector('form'),false);assert.match(host.textContent!,/申请无效/);view.dispose();
  }
});
test('a ten-second session deadline discards a transport that resolves late without reviving consent',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {mountReferenceApprovalPage}=await import('./approval-page');
  const {document}=parseHTML('<html><body><main></main></body></html>'),host=document.querySelector('main')!;
  let resolve!: (value:Response)=>void,signal:AbortSignal|undefined;
  const view=mountReferenceApprovalPage(host,{search,cookie:()=> 'gj_csrf=synthetic-csrf',fetchImpl:async(_path,init)=>{
    signal=init?.signal??undefined;return await new Promise<Response>(done=>{resolve=done;});
  }});
  try{
    t.mock.timers.tick(10000);await tick();assert.equal(signal?.aborted,true);assert.match(host.textContent!,/无法核对/);
    resolve(new Response(JSON.stringify({user}),{headers:{'content-type':'application/json'}}));await tick();assert.equal(!!host.querySelector('form'),false);
  }finally{view.dispose();t.mock.timers.reset();}
});
