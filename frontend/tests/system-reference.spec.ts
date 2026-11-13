import {test,expect,type Page} from '@playwright/test';
import {connectionBeginFixture,systemCitationFixture} from '../src/system-reference/test-fixtures';
import {releaseDetail,releaseId} from '../src/system-reference/admin-test-fixtures';
const origin='http://127.0.0.1:5394';
const user={id:'synthetic-user',teamId:'synthetic-team',authVersion:1,name:'中央合成用户'};
const sessionId='66666666-6666-4666-8666-666666666666',timestamp='2026-10-08T00:00:00.000Z';
const session={sessionId,revision:1,title:'系统参考合成历史',documentId:null,createdAt:timestamp,updatedAt:timestamp,turnCount:2};
const privateSource={sourceId:'K1',documentId:'99999999-9999-4999-8999-999999999999',versionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',chunkId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',sourceHash:'e'.repeat(64),sourceLabel:'本人合成资料',locator:{page:1},excerpt:'个人合成摘录',warnings:[]};
async function boundary(page:Page,options:{operator?:boolean;adminFailure?:boolean;citationFailure?:boolean;connectionFailure?:boolean;approvalFailure?:boolean;embedded?:boolean}={}){
  const calls:Array<{path:string;method:string;body:unknown;headers:Record<string,string>}>=[],unexpected:string[]=[];
  let connected=false,pending=false,generation=0,published=false,releaseRevision=2;
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(url.origin!==origin){unexpected.push('external');return route.abort();}
    if(!path.startsWith('/api/'))return route.continue();
    calls.push({path,method:request.method(),body:request.postData()?request.postDataJSON():undefined,headers:request.headers()});
    if(path==='/api/auth/me')return route.fulfill({json:{user}});
    if(path===`/api/v1/system-reference/binding-requests/${connectionBeginFixture.requestId}/approve`)return route.fulfill({status:options.approvalFailure?503:204});
    if(path==='/api/platform/v1/overview')return route.fulfill({json:{revision:99,role:options.operator?'operator':'owner',page:1,pageSize:50,workspaceCount:0,accountCount:0,auditCount:0,workspaces:[],accounts:[],plans:[],audits:[]}});
    if(path.startsWith('/api/platform/v1/system-reference/')){
      if(options.adminFailure)return route.fulfill({status:403,json:{error:{code:'reference_forbidden',message:'synthetic'}}});
      if(path.endsWith('/publish')||path.endsWith('/revoke')){published=path.endsWith('/publish');releaseRevision++;return route.fulfill({json:{...releaseDetail.release,revision:releaseRevision,status:published?'published':'revoked'}});}
      if(path.endsWith(releaseId))return route.fulfill({json:{...releaseDetail,release:{...releaseDetail.release,revision:releaseRevision,status:published?'published':'ready'},activeReleaseId:published?releaseId:null}});
    }
    if(path==='/api/v1/reference-connection/begin'){if(options.connectionFailure)return route.fulfill({status:503});pending=true;return route.fulfill({json:connectionBeginFixture});}
    if(path==='/api/v1/reference-connection/complete'){connected=true;pending=false;generation++;return route.fulfill({json:{status:'ready',generation,centralAccountLabel:'中央合成用户'}});}
    if(path==='/api/v1/reference-connection'){
      if(options.embedded)return route.fulfill({json:{status:'embedded_ready',generation:0}});
      if(request.method()==='DELETE'){connected=false;pending=false;generation++;}
      return route.fulfill({json:{status:connected?'ready':pending?'pending':'unbound',generation,...(connected?{centralAccountLabel:'中央合成用户'}:{})}});
    }
    if(path===`/api/v1/reference-connection/grants/${systemCitationFixture.queryGrantId}/references/${systemCitationFixture.referenceId}`)return options.citationFailure?route.fulfill({status:404,json:{error:{code:'reference_not_found',message:'synthetic'}}}):route.fulfill({json:systemCitationFixture});
    if(path.endsWith('/cfo-workflows/latest'))return route.fulfill({json:null});
    if(path.endsWith('/cfo-sessions'))return route.fulfill({json:[session]});
    if(path.endsWith(`/cfo-sessions/${sessionId}`))return route.fulfill({json:{...session,turns:[{role:'user',text:'合成问题'},{role:'assistant',text:'历史摘要',knowledge:{status:'used',detailedText:'合成历史方法说明',sources:[privateSource,systemCitationFixture],warnings:systemCitationFixture.warnings},libraryStatus:{system:'ready',private:'used'}}]}});
    if(path.endsWith('/cfo-conversation'))return route.fulfill({json:{answer:'本题合成回答',model:'fixture',provider:'fixture',material:null,answeredAt:timestamp,libraryStatus:{system:'unavailable',private:'used'}}});
    unexpected.push(path);return route.fulfill({status:503,json:{error:{code:'reference_unavailable',message:'synthetic'}}});
  });
  await page.context().addCookies([{name:'gj_csrf',value:'synthetic-csrf',url:origin}]);
  return {calls,unexpected};
}
test('central approval uses the actual entry theme and a keyboard-confirmed normal session',async({page},info)=>{
  const api=await boundary(page);await page.context().addCookies([{name:'shensi_theme',value:'light',url:origin}]);
  await page.goto(`/reference-approval.html?requestId=${connectionBeginFixture.requestId}&displayCode=${connectionBeginFixture.displayCode}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await expect(page.getByText('中央账号：中央合成用户')).toBeVisible();
  const confirm=page.getByRole('checkbox'),submit=page.getByRole('button',{name:'批准连接',exact:true});
  await expect(submit).toBeDisabled();await confirm.focus();await page.keyboard.press('Space');await page.keyboard.press('Tab');await expect(submit).toBeFocused();
  await page.keyboard.press('Enter');await expect(page.getByRole('status')).toContainText('已批准');
  expect(api.calls.filter(call=>call.method==='POST')).toHaveLength(1);expect(api.unexpected).toEqual([]);
  await page.screenshot({path:info.outputPath('central-approved.png'),fullPage:true});
});

async function readable(page:Page,selector:string){
  const rows=await page.locator(selector).evaluateAll(roots=>{
    const rgb=(value:string)=>value.match(/[\d.]+/gu)!.map(Number);
    const blend=(top:number[],bottom:number[])=>top.slice(0,3).map((n,i)=>n*(top[3]??1)+bottom[i]*(1-(top[3]??1)));
    const lum=(color:number[])=>color.slice(0,3).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
    return roots.flatMap(root=>[root,...root.querySelectorAll('*')]).filter(node=>node.getClientRects().length>0
      && ([...node.childNodes].some(child=>child.nodeType===3&&child.textContent?.trim())||(node instanceof HTMLInputElement&&node.type!=='checkbox'))).map(node=>{
      const layers:number[][]=[];let parent:Element|null=node,unsupported=false,opaque=false;
      while(parent){const style=getComputedStyle(parent);if(Number(style.opacity)!==1)unsupported=true;
        if(!opaque){if(style.backgroundImage!=='none')unsupported=true;const color=rgb(style.backgroundColor);layers.push(color);opaque=(color[3]??1)===1;}parent=parent.parentElement;}
      let bg=[255,255,255];for(const layer of layers.reverse())bg=blend(layer,bg);
      const style=getComputedStyle(node),foreground=blend(rgb(style.color),bg),a=lum(foreground),b=lum(bg);
      const outline=lum(blend(rgb(style.outlineColor),bg));
      const focusRatio=node.matches(':focus-visible')&&parseFloat(style.outlineWidth)>=2?(Math.max(outline,b)+.05)/(Math.min(outline,b)+.05):null;
      return {label:node.tagName+':'+(node.textContent??'').slice(0,24),ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),focusRatio,unsupported,fg:foreground,bg};
    });
  });
  expect(rows.length).toBeGreaterThan(0);
  for(const row of rows){expect(row.unsupported,JSON.stringify(row)).toBe(false);expect(row.ratio,JSON.stringify(row)).toBeGreaterThanOrEqual(4.5);if(row.focusRatio!==null)expect(row.focusRatio,JSON.stringify(row)).toBeGreaterThanOrEqual(3);}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)).toBe(false);
  return Math.min(...rows.map(row=>row.ratio));
}

for(const theme of ['light','dark'])for(const width of [1440,390])test(`embedded reference status ${theme} ${width}: default use without connection actions`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const api=await boundary(page,{embedded:true});await page.setViewportSize({width,height:900});await page.context().addCookies([{name:'shensi_theme',value:theme,url:origin}]);
  await page.goto('/tests/system-reference.html');await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  await page.locator('[data-cfo-reference-connection] > summary').click();
  const panel=page.getByRole('region',{name:'应用内置参考资料',exact:true});
  await expect(panel).toBeVisible();await expect(panel.getByRole('status')).toHaveText('应用内置参考资料，智能体默认使用');
  await expect(panel).toContainText('无需上传或连接');
  for(const name of ['连接默认参考库','已在中央批准，手动完成','解除或取消连接'])await expect(panel.getByRole('button',{name,exact:true})).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);await expect(panel.getByRole('link')).toHaveCount(0);
  const refresh=panel.getByRole('button',{name:'检查资料状态',exact:true});await refresh.focus();await page.keyboard.press('Enter');
  await expect.poll(()=>api.calls.filter(call=>call.path==='/api/v1/reference-connection').length).toBe(2);
  await readable(page,'.reference-connection');
  expect(api.calls.filter(call=>call.method!=='GET')).toEqual([]);expect(api.unexpected).toEqual([]);expect(errors).toEqual([]);
  await page.screenshot({path:info.outputPath(`embedded-${theme}-${width}.png`),fullPage:true});
});

for(const theme of ['light','dark'])for(const width of [1440,1024,390])test(`default-reference flows ${theme} ${width}: topics, connection, exact history, approval and owner controls`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const api=await boundary(page);await page.setViewportSize({width,height:900});await page.context().addCookies([{name:'shensi_theme',value:theme,url:origin}]);
  await page.goto('/tests/system-reference.html');await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  await page.locator('[data-cfo-role-choice=finance]').click();
  const topic=page.locator('[data-cfo-reference-topics] > details > summary');await topic.focus();await page.keyboard.press('Enter');
  await expect(page.locator('[data-reference-topic]')).toHaveCount(12);
  for(const id of ['budget_variance','budget_planning','cost_driver'])await page.locator(`[data-reference-topic=${id}]`).check();
  await expect(page.locator('[data-reference-topic=cost_structure]')).toBeDisabled();
  expect(api.calls.filter(call=>call.method==='POST')).toHaveLength(0);await readable(page,'[data-cfo-reference-topics]');
  await page.locator('[data-cfo-reference-connection] > summary').click();await expect(page.locator('.reference-connection')).toContainText('默认参考库未连接');
  await readable(page,'.reference-connection');await page.getByRole('button',{name:'连接默认参考库',exact:true}).click();
  await expect(page.locator('.reference-connection')).toContainText('01234567');await readable(page,'.reference-connection');
  await expect(page.getByRole('link',{name:'打开中央账号批准页'})).toHaveAttribute('href',connectionBeginFixture.approvalUrl);
  await page.getByRole('button',{name:'已在中央批准，手动完成',exact:true}).click();await expect(page.locator('.reference-connection')).toContainText('默认参考库已连接');
  await page.locator('[data-reference-confirm-unbind]').check();await page.getByRole('button',{name:'解除或取消连接',exact:true}).click();await expect(page.locator('.reference-connection')).toContainText('默认参考库未连接');
  await page.locator('[data-cfo-question-form] textarea').fill('合成企业123万元的预算偏差');await page.getByRole('button',{name:'发送问题',exact:true}).click();
  await expect(page.locator('.cfo-library-status')).toContainText('默认参考库不可用 · 使用本人资料');await expect(page.locator('[data-cfo-status]')).toContainText('未使用公网搜索');
  const call=api.calls.find(row=>row.path.endsWith('/cfo-conversation'))!;expect(call.body).toMatchObject({referenceProtocol:'system-v1',referenceTopicIds:['budget_variance','budget_planning','cost_driver'],webSearchMode:'off',knowledgeMode:'auto'});
  await page.locator('[data-cfo-role-choice=cfo]').click();await page.locator('[data-cfo-session]').click();
  await page.locator('.cfo-message-knowledge > summary').click();await expect(page.locator('.system-reference-citation')).toContainText('历史引用');
  expect(api.calls.filter(row=>row.path.includes('/grants/'))).toHaveLength(0);
  await page.locator('.system-reference-citation button').focus();await page.keyboard.press('Enter');await expect(page.locator('[data-reference-excerpt]')).toContainText('合成预算参考');
  await expect(page.locator('.system-reference-citation a')).toHaveCount(0);await expect(page.locator('.cfo-message-knowledge a')).toHaveAttribute('href',/^#knowledge\?/);
  await readable(page,'.system-reference-citation,.cfo-library-status');
  const history=api.calls.find(row=>row.path.endsWith(`/cfo-sessions/${sessionId}`))!;expect(history.headers['x-shensi-reference-protocol']).toBe('system-v1');
  expect(api.calls.some(row=>row.path.startsWith('/api/v1/knowledge'))).toBe(false);
  await page.screenshot({path:info.outputPath(`history-${theme}-${width}.png`),fullPage:true});

  await page.goto(`/reference-approval.html?requestId=${connectionBeginFixture.requestId}&displayCode=${connectionBeginFixture.displayCode}`);
  await expect(page.getByRole('button',{name:'批准连接',exact:true})).toBeDisabled();await readable(page,'.reference-approval-page');
  await page.getByRole('checkbox').focus();await page.keyboard.press('Space');await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'批准连接',exact:true})).toBeFocused();
  expect(await page.getByRole('button',{name:'批准连接',exact:true}).evaluate(node=>parseFloat(getComputedStyle(node).outlineWidth))).toBeGreaterThanOrEqual(2);
  await readable(page,'.reference-approval-page');
  await page.keyboard.press('Enter');await expect(page.getByRole('status')).toContainText('已批准');await readable(page,'.reference-approval-page');
  await page.screenshot({path:info.outputPath(`approval-${theme}-${width}.png`),fullPage:true});

  await page.goto('/admin.html');await expect(page.locator('html')).toHaveAttribute('data-theme',theme);await page.getByRole('button',{name:'默认参考库',exact:true}).click();
  const heading=page.getByRole('heading',{name:'默认参考库',exact:true});
  expect(await heading.evaluate(node=>node.getBoundingClientRect().height<=parseFloat(getComputedStyle(node).lineHeight)+1)).toBe(true);
  await readable(page,'.reference-admin-panel');await page.getByLabel('候选版本编号').fill(releaseId);await page.getByRole('button',{name:'读取候选',exact:true}).click();
  await expect(page.locator('.reference-admin-panel')).toContainText('source_incomplete');await expect(page.locator('[data-reference-publish]')).toBeDisabled();
  await readable(page,'.reference-admin-panel');await page.getByLabel('操作原因',{exact:true}).fill('合成缺页标记已核对');await page.locator('[name=confirm]').check();
  await page.locator('[data-reference-publish]').click();await expect(page.locator('.reference-admin-panel [role=status]')).toContainText('已发布');await readable(page,'.reference-admin-panel');
  await page.screenshot({path:info.outputPath(`owner-${theme}-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:'企业客户',exact:true}).click();await page.getByRole('button',{name:'默认参考库',exact:true}).click();
  await page.getByLabel('候选版本编号').fill(releaseId);await page.getByRole('button',{name:'读取候选',exact:true}).click();
  await page.getByLabel('操作原因',{exact:true}).fill('合成撤回验收');await page.locator('[name=confirm]').check();await page.locator('[data-reference-revoke]').click();
  await expect(page.locator('.reference-admin-panel [role=status]')).toContainText('已撤回');
  const publications=api.calls.filter(row=>row.path.endsWith('/publish')||row.path.endsWith('/revoke'));expect(publications).toHaveLength(2);expect(publications[0].headers['if-match']).toBe('"2"');expect(publications[1].headers['if-match']).toBe('"3"');
  expect(api.unexpected).toEqual([]);expect(errors).toEqual([]);
});
test('normal owner entry restores its saved theme and exposes exact-candidate maintenance',async({page})=>{
  const api=await boundary(page);await page.context().addCookies([{name:'shensi_theme',value:'dark',url:origin}]);
  await page.goto('/admin.html');await page.getByRole('button',{name:'默认参考库',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(page.getByLabel('候选版本编号')).toBeVisible();expect(api.calls.filter(call=>call.path.includes('/system-reference/'))).toHaveLength(0);
  await page.getByLabel('候选版本编号').fill(releaseId);await page.getByRole('button',{name:'读取候选',exact:true}).click();
  await expect(page.locator('.reference-admin-panel')).toContainText('source_incomplete');expect(api.unexpected).toEqual([]);
});

for(const theme of ['light','dark'])for(const width of [1440,1024,390])test(`default-reference errors and operator boundaries ${theme} ${width}`,async({page},info)=>{
  const options={citationFailure:true,connectionFailure:true,approvalFailure:true,adminFailure:true,operator:false};
  const api=await boundary(page,options);await page.setViewportSize({width,height:900});await page.context().addCookies([{name:'shensi_theme',value:theme,url:origin}]);
  await page.goto('/tests/system-reference.html');await page.locator('[data-cfo-session]').click();await page.locator('.cfo-message-knowledge > summary').click();
  await page.locator('.system-reference-citation button').click();await expect(page.locator('.system-reference-citation')).toContainText('此引用暂不可用');
  await expect(page.locator('.system-reference-citation')).toContainText('历史引用');await expect(page.locator('[data-reference-excerpt]')).toBeEmpty();
  await expect(page.locator('.system-reference-citation button')).toBeDisabled();await readable(page,'.system-reference-citation');
  expect(api.calls.filter(call=>call.path.includes('/grants/'))).toHaveLength(1);expect(api.calls.some(call=>call.path.startsWith('/api/v1/knowledge'))).toBe(false);
  await page.locator('[data-cfo-reference-connection] > summary').click();await page.getByRole('button',{name:'连接默认参考库',exact:true}).click();
  await expect(page.locator('.reference-connection [role=status]')).toContainText('未确认');await readable(page,'.reference-connection');
  expect(api.calls.filter(call=>call.path.endsWith('/begin'))).toHaveLength(1);
  await page.screenshot({path:info.outputPath(`errors-${theme}-${width}.png`),fullPage:true});
  await page.goto(`/reference-approval.html?requestId=${connectionBeginFixture.requestId}&displayCode=${connectionBeginFixture.displayCode}`);
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'批准连接',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('未确认');await readable(page,'.reference-approval-page');
  expect(api.calls.filter(call=>call.path.endsWith('/approve'))).toHaveLength(1);
  await page.goto('/admin.html');await page.getByRole('button',{name:'默认参考库',exact:true}).click();
  await expect(page.locator('.reference-admin-panel [role=status]')).toHaveCount(1);
  await page.getByLabel('候选版本编号').fill('invalid');await page.getByRole('button',{name:'读取候选',exact:true}).click();
  await expect(page.getByLabel('候选版本编号')).toHaveAttribute('aria-invalid','true');
  await expect(page.locator('.reference-admin-panel [role=status]')).toContainText('有效');
  await page.getByLabel('候选版本编号').fill(releaseId);await page.getByRole('button',{name:'读取候选',exact:true}).click();
  await expect(page.locator('.reference-admin-panel [role=status]')).toContainText('候选读取失败');await expect(page.locator('[name=confirm]')).toHaveCount(0);await readable(page,'.reference-admin-panel');
  const reads=api.calls.filter(call=>call.path.includes('/system-reference/releases/')).length;
  options.operator=true;await page.reload();await page.getByRole('button',{name:'默认参考库',exact:true}).click();
  await expect(page.locator('.reference-admin-panel')).toContainText('没有维护权限');await expect(page.locator('[name=releaseId]')).toHaveCount(0);await readable(page,'.reference-admin-panel');
  expect(api.calls.filter(call=>call.path.includes('/system-reference/releases/'))).toHaveLength(reads);expect(api.unexpected).toEqual([]);
});
