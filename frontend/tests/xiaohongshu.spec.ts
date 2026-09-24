import {test,expect} from '@playwright/test';
for(const theme of ['dark','light'])for(const width of [1440,390])test(`${theme} ${width}: create, edit, approve and unknown receipt`,async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')errors.push(m.text());});
  await page.setViewportSize({width,height:900});
  const account={accountId:'00000000-0000-4000-8000-000000000002',platformUserId:'user',displayName:'测试账号',generation:'00000000-0000-4000-8000-000000000003',state:'ready',revision:1,deviceId:'device',updatedAt:1};
  let drafts:any[]=[];let sent=0;
  await page.exposeFunction('syntheticSend',()=>{sent++;drafts[0].status='unknown';return drafts[0];});
  await page.addInitScript(({theme})=>{document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.theme=theme);
    (window as any).shensiXiaohongshu={open:async()=>({state:'login_open'}),connect:async()=>({state:'ready'}),close:async()=>{},send:async()=> (window as any).syntheticSend()};}, {theme});
  await page.context().addCookies([{name:'gj_csrf',value:'synthetic',url:'http://127.0.0.1:5397'}]);
  await page.route('**/api/v1/acquisition/xiaohongshu/**',async route=>{
    const req=route.request(),url=new URL(req.url()),body=req.postDataJSON();
    if(req.method()==='POST'&&url.pathname.endsWith('/drafts'))drafts=[{...body,revision:1,status:'draft',updatedAt:1}];
    if(req.method()==='PATCH'){drafts[0]={...drafts[0],...body,revision:drafts[0].revision+1,status:'draft'};}
    if(url.pathname.endsWith('/approve')){expect(body.revision).toBe(drafts[0].revision);drafts[0].status='approved';drafts[0].revision++;}
    await route.fulfill({json:req.method()==='GET'?{items:url.pathname.endsWith('/accounts')?[account]:drafts}:drafts[0]});
  });
  await page.goto('/tests/xiaohongshu-visual.html');await expect(page.getByRole('heading',{name:'小红书私信',exact:true})).toBeVisible();
  await page.locator('[name="xhs-account"]').selectOption(account.accountId);
  await page.locator('[name="xhs-recipient"]').fill('recipient');await page.locator('[name="xhs-body"]').fill('这是一条合成测试消息');
  await page.getByRole('button',{name:'保存待审批草稿'}).click();await expect(page.locator('[data-xhs-approve]')).toBeVisible();
  await page.locator('[data-xhs-edit-body]').fill('修改后的合成测试消息');
  await page.locator('[data-xhs-approve]').click();await expect(page.getByRole('alert')).toContainText('请先保存修改');
  await expect(page.locator('[data-xhs-edit-body]')).toHaveValue('修改后的合成测试消息');
  await page.locator('[data-xhs-edit]').click();
  await page.locator('[data-xhs-approve]').click();await expect(page.locator('[data-xhs-send]')).toBeVisible();
  await page.screenshot({path:`/tmp/shensi-xhs-${theme}-${width}.png`,fullPage:true});
  page.on('dialog',dialog=>dialog.accept());await page.locator('[data-xhs-send]').click();
  await expect(page.getByText('结果未知 · 不自动重发',{exact:true})).toBeVisible();await expect(page.locator('[data-xhs-send]')).toHaveCount(0);
  expect(sent).toBe(1);expect(errors).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const contrast=await page.locator('.xhs-workspace').evaluate(element=>{
    const style=getComputedStyle(element);
    const luminance=(name:string)=>{
      const raw=style.getPropertyValue(name).trim().slice(1);
      const hex=raw.length===3?[...raw].map(c=>c+c).join(''):raw;
      const rgb=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
      return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
    };
    const pairs=[['--xhs-text','--xhs-bg'],['--xhs-muted','--xhs-panel'],['--xhs-accent','--xhs-panel']];
    return pairs.map(([front,back])=>{const a=luminance(front),b=luminance(back);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);});
  });
  expect(Math.min(...contrast)).toBeGreaterThanOrEqual(4.5);
});
