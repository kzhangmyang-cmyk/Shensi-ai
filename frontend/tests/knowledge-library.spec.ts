import {test,expect,type Page} from '@playwright/test';
const id='11111111-1111-4111-8111-111111111111',vid='22222222-2222-4222-8222-222222222222';
function contrast(a:string,b:string){
  const luminance=(color:string)=>{const channels=color.match(/[\d.]+/gu)!.slice(0,3).map(Number).map(value=>{const channel=value/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4;});return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];};
  const levels=[luminance(a),luminance(b)].sort((x,y)=>y-x);return(levels[0]+.05)/(levels[1]+.05);
}
async function boundary(page:Page,options:{longPreview?:boolean}={}){
  let enabled=true,ready=false,failed=false,removed=false,uploaded=false,title='全面预算参考';let revision=1,latestId=vid;let activeId:string|null=null,roles=['cfo','finance'];
  const oldVersions=new Map<string,ReturnType<typeof version>>();
  const writes:{method:string;path:string;body:string|null}[]=[];let reads=0;
  const document=()=>({id,revision,title,sourceKind:'book',roles,enabled,activeVersionId:activeId,latestVersionId:latestId,updatedAt:'2026-10-06T00:00:00Z'});
  const version=()=>({id:latestId,documentId:id,revision:uploaded?2:1,jobId:'33333333-3333-4333-8333-333333333333',filename:'budget.txt',format:'txt',bytes:6,sourceHash:uploaded?'a'.repeat(64):null,uploadComplete:uploaded,status:failed?'failed':ready?'ready':uploaded?'indexing':'queued',coverage:ready?{totalPages:2,extractedPages:1,missingPages:[2]}:null,warnings:ready?['ocr_unverified','table_unverified']:[],failureCode:failed?'reader_unavailable':null});
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
    if(!path.startsWith('/api/v1/knowledge/')){expect(method).toBe('GET');return route.fulfill({status:503,json:{code:'isolated_unavailable'}});}
    expect(request.headers()['x-workspace-id']).toBe('personal-fixture');
    if(method!=='GET'){expect(request.headers()['x-csrf-token']).toBe('fixture-csrf');writes.push({method,path,body:request.postData()});}
    if(path.endsWith('/availability'))return route.fulfill({json:{available:true,reason:null}});
    if(path.endsWith('/documents')&&method==='GET'){reads++;return route.fulfill({json:{items:removed?[]:[document()],nextCursor:null}});}
    if(path.endsWith('/documents')&&method==='POST')return route.fulfill({status:201,json:{document:document(),version:version()}});
    if(path.endsWith(`/documents/${id}/versions`)&&method==='POST'){
      expect(request.headers()['if-match']).toBe(`"${revision}"`);oldVersions.set(latestId,version());latestId='55555555-5555-4555-8555-555555555555';ready=false;failed=false;uploaded=false;revision++;
      return route.fulfill({status:201,json:version()});
    }
    if(method==='PUT'&&path.endsWith('/content')){expect(request.headers()['content-type']).toBe('application/octet-stream');uploaded=true;return route.fulfill({json:version()});}
    if(path.endsWith('/chunks'))return route.fulfill({json:{items:[{id:'44444444-4444-4444-8444-444444444444',versionId:vid,order:0,text:'预算差异需要结合实际经营情况判断，不构成企业已核实财务事实。'.repeat(options.longPreview?75:1),locator:{page:1,chapter:'预算编制'},warnings:['ocr_unverified']}],nextCursor:null}});
    const exactVersion=/\/versions\/([a-f0-9-]+)$/u.exec(path);if(exactVersion)return route.fulfill({json:oldVersions.get(exactVersion[1])??version()});
    if(path.endsWith('/retry')){failed=false;return route.fulfill({json:version()});}
    if(path.endsWith(`/documents/${id}`)){
      if(method==='PATCH'){const body=request.postDataJSON();if(body.enabled!==undefined)enabled=body.enabled;if(body.title)title=body.title;if(body.roles)roles=body.roles;revision++;}
      if(method==='DELETE'){removed=true;return route.fulfill({status:204});}
      return route.fulfill({json:document()});
    }
    throw new Error(`Unexpected knowledge operation: ${method} ${path}`);
  });
  return {writes,get reads(){return reads;},publish(){uploaded=true;ready=true;failed=false;activeId=latestId;},fail(){uploaded=true;failed=true;}};
}
test('upload, indexing, cited preview and current-version management use the real page',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));const api=await boundary(page,{longPreview:true});
  await page.goto('/tests/knowledge-library.html');await expect(page.getByRole('heading',{name:'知识库',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'查看 全面预算参考'}).click();await expect(page.locator('[data-version-state]')).toContainText('等待解析');
  await page.getByText('上传资料',{exact:true}).click();await page.locator('[data-knowledge-files]').setInputFiles({name:'budget.txt',mimeType:'text/plain',buffer:Buffer.from('budget')});
  await expect(page.locator('[data-upload-list]')).toContainText('已上传');await expect(page.locator('[data-version-state]')).toContainText('正在建立索引');
  const title=page.getByLabel('资料标题');await title.fill('我的预算笔记');await title.focus();
  api.publish();await expect(page.locator('[data-knowledge-state="ready"]')).toHaveCount(1);await expect(title).toHaveValue('我的预算笔记');await expect(title).toBeFocused();
  await expect(page.locator('[data-preview]')).toContainText('物理页 1 · 预算编制');await expect(page.locator('[data-coverage]')).toContainText('缺失物理页：2');
  await expect(page.locator('[data-preview]')).toContainText('预算差异需要结合实际经营情况判断');
  const preview=page.locator('[data-preview]');await preview.evaluate(node=>{node.scrollTop=91;});
  const position=await preview.evaluate(node=>node.scrollTop);expect(position).toBeGreaterThan(0);const readCount=api.reads;
  await expect.poll(()=>api.reads).toBeGreaterThan(readCount);await expect.poll(()=>preview.evaluate(node=>node.scrollTop)).toBe(position);
  await page.getByRole('button',{name:'停用资料'}).click();await expect(page.getByRole('button',{name:'启用资料'})).toBeVisible();
  page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除资料'}).click();await expect(page.getByText('还没有资料',{exact:true})).toBeVisible();
  expect(api.writes.filter(write=>write.method==='PUT')).toHaveLength(1);expect(errors).toEqual([]);
});
test('failed version can be retried, and identity change removes private details immediately',async({page})=>{
  const api=await boundary(page);api.fail();await page.goto('/tests/knowledge-library.html');await page.getByRole('button',{name:'查看 全面预算参考'}).click();
  await page.getByRole('button',{name:'重试解析'}).click();await expect(page.locator('[data-version-state]')).toContainText('正在建立索引');
  await page.evaluate(()=>{document.body.dataset.sessionUserId='different-user';});await expect(page.locator('.knowledge-library')).toHaveCount(0);
  expect(api.writes.filter(write=>write.path.endsWith('/retry'))).toHaveLength(1);
});
test('both themes at 1440, 1024 and 390 retain readable selected, disabled, failure and ready states',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
  const api=await boundary(page);api.publish();await page.goto('/tests/knowledge-library.html');await page.getByRole('button',{name:'查看 全面预算参考'}).click();
  for(const width of [1440,1024,390])for(const theme of ['dark','light']){
    await page.setViewportSize({width,height:900});await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
    await expect(page.locator('[data-version-state]')).toContainText('可检索');
    const dimensions=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,detail:document.querySelector('[data-knowledge-detail]')!.getBoundingClientRect().width,
      theme:getComputedStyle(document.querySelector('.knowledge-library')!).color}));expect(dimensions.overflow).toBe(false);expect(dimensions.detail).toBeGreaterThan(200);
    const colors=await page.evaluate(()=>{const style=(selector:string)=>getComputedStyle(document.querySelector(selector)!);return[
      [style('.knowledge-document-title').color,style('.knowledge-document[aria-pressed=true]').backgroundColor],
      [style('[data-warnings]').color,style('[data-knowledge-detail]').backgroundColor],
      [style('button[type=submit]').color,style('button[type=submit]').backgroundColor]
    ];});for(const [foreground,background] of colors)expect(contrast(foreground,background)).toBeGreaterThanOrEqual(4.5);
    await expect(page.getByRole('button',{name:'重试解析'})).toBeDisabled();
    await page.screenshot({path:`/tmp/shensi-knowledge-${theme}-${width}.png`,fullPage:true});
    api.fail();await expect(page.locator('[data-version-state]')).toContainText('处理失败');await expect(page.getByRole('button',{name:'重试解析'})).toBeEnabled();
    await page.screenshot({path:`/tmp/shensi-knowledge-${theme}-${width}-failed.png`,fullPage:true});api.publish();await expect(page.locator('[data-version-state]')).toContainText('可检索');
  }
  expect(await page.title()).toBe('知识库 · 隔离交互验收');expect(page.url()).toContain('/tests/knowledge-library.html');expect(errors).toEqual([]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});
test('latest application shell keeps the same-route instance and disposes on leaving or logout',async({page})=>{
  await boundary(page);await page.goto('/tests/knowledge-shell.html#knowledge');await expect(page.locator('.knowledge-library').getByRole('heading',{name:'知识库',exact:true})).toBeVisible();
  await expect(page.locator('#demoModuleInspector')).toBeHidden();await expect(page.locator('#demoModuleInspector')).toBeEmpty();
  await page.getByLabel('搜索知识资料').fill('保持输入');
  await page.evaluate(()=>window.dispatchEvent(new HashChangeEvent('hashchange')));await expect(page.getByLabel('搜索知识资料')).toHaveValue('保持输入');
  await page.locator('#replicaNewTaskButton').click();await expect(page.locator('[data-upload]')).toHaveAttribute('open','');
  await page.evaluate(()=>{location.hash='#enterprise-query';});await expect(page.locator('.knowledge-library')).toHaveCount(0);
  await page.evaluate(()=>{location.hash='#knowledge';});await expect(page.locator('.knowledge-library')).toHaveCount(1);
  await page.evaluate(()=>document.dispatchEvent(new CustomEvent('goodjob:auth-state-changed',{detail:{authenticated:false}})));await expect(page.locator('.knowledge-library')).toHaveCount(0);
});
test('role edits and replacement keep the prior effective version until the new file is ready',async({page})=>{
  const api=await boundary(page);api.publish();await page.goto('/tests/knowledge-library.html');await page.getByRole('button',{name:'查看 全面预算参考'}).click();
  await expect(page.locator('input[name="edit-role"][value="cfo"]').locator('..')).toContainText('AI 经营总管');
  await expect(page.locator('input[name="edit-role"][value="profit"]').locator('..')).toContainText('利润分析');
  await expect(page.locator('input[name="edit-role"][value="tax"]').locator('..')).toContainText('税务健康');
  await page.locator('input[name="edit-role"][value="finance"]').uncheck();await page.getByRole('button',{name:'保存资料信息'}).click();
  await expect.poll(()=>api.writes.filter(write=>write.method==='PATCH').length).toBe(1);
  expect(JSON.parse(api.writes.find(write=>write.method==='PATCH')!.body!).roles).toEqual(['cfo']);
  await page.locator('[data-replacement]').setInputFiles({name:'budget-v2.txt',mimeType:'text/plain',buffer:Buffer.from('budget')});
  await expect(page.locator('[data-version-state]')).toContainText('正在建立索引');await expect(page.locator('[data-active-note]')).toContainText('上一有效版本仍可参考');
  await expect(page.getByLabel('查看资料版本').locator('option')).toHaveCount(2);await expect(page.locator('[data-version-id]')).toContainText('55555555-5555-4555-8555-555555555555');
  await page.getByLabel('查看资料版本').selectOption(vid);await expect(page.locator('[data-version-state]')).toContainText('可检索');
  expect(api.writes.filter(write=>write.method==='PUT')).toHaveLength(1);
});
