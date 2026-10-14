// Isolated browser regression: synthetic files and in-memory API, no model traffic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { parseHTML } from 'linkedom';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const index = parseHTML(await readFile(`${root}index.html`, 'utf8')).document;
const css = (await Promise.all([
 ...[...index.querySelectorAll('link[rel=stylesheet]')].map(link => `${root}${link.getAttribute('href')!.replace(/^\//, '')}`),
 `${root}src/enterprise-query/view.css`, `${root}src/enterprise-query/preview.css`
].map(path => readFile(path, 'utf8')))).join('\n');
const bundle = await build({ stdin: { resolveDir: root, contents: `
import {mountEnterpriseAnalysis} from './src/growth/finance/enterprise-analysis';
import {mountHome} from './src/home/view';
import {mountEnterpriseQuery} from './src/enterprise-query/view';
let surface;window.modelCalls=0;
const http={request:async(path,options)=>{
 const b=options.body;if(b.readWithModel)window.modelCalls++;
 const files=[{fileName:b.fileName},...(b.additionalFiles??[])].map((f,i)=>({...f,prefix:'file:'+(i+1)+':',fileHash:'sha256:'+'a'.repeat(64)}));
 return {body:{documentId:'fixture',fileName:files.map(f=>f.fileName).join('、'),fileHash:'sha256:'+'a'.repeat(64),expiresAt:'2026-12-01T00:00:00Z',classification:'unknown',regions:[],missingStatements:[],uncertain:[],files,
 cells:files.map(f=>({sourceRef:f.prefix+'cell:1:1:1',sheetName:'合成资料',row:1,column:1,text:'合成收入100'})),
 observations:b.readWithModel?[{text:'综合两份合成资料，收入与成本需按相同期间核对。',sourceRefs:files.map(f=>f.prefix+'cell:1:1:1')}]:[],modelStatus:b.readWithModel?'completed':'not_requested',selectedForConversation:false}};
}};
window.openFinance=()=>{surface=mountEnterpriseAnalysis({host:document.querySelector('main'),http,purpose:'finance',canAnalyze:true});};
window.leaveFinance=()=>{surface.dispose();document.querySelector('main').replaceChildren();};
window.openHome=()=>mountHome(document.querySelector('main'),undefined,()=>true);
window.searchCalls=0;
window.shensiEnterpriseBrowser={readPreview:async()=>{throw Error('not used');},searchLocal:async()=>{window.searchCalls++;return {version:1,sourceUrl:'https://aiqicha.baidu.com/s',capturedAt:new Date().toISOString(),items:[]};}};
window.openEnterprise=()=>mountEnterpriseQuery(document.querySelector('main'));
window.openFinance();
` }, bundle: true, format: 'esm', write: false, define: { 'import.meta.env': '{}' } });
const browser = await chromium.launch({ headless: true });
const output = '/tmp/shensi-enterprise-session-qa'; await mkdir(output, { recursive: true });
try {
 for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 950 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
   const url = new URL(route.request().url());
   if (url.pathname.startsWith('/assets/home/') && !url.pathname.includes('..')) {
    await route.fulfill({ contentType: 'image/png', body: await readFile(`${root}public${url.pathname}`) }); return;
   }
   if(url.pathname==='/') {await route.fulfill({contentType:'text/html',body:'<html></html>'});return;}
   await route.abort();
  });
  await page.goto('http://fixture.test/');
  await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head><body class="is-authenticated" data-session-workspace-id="fixture" data-session-user-id="user"><div class="replica-shell" style="display:block;padding:12px"><main></main></div></body></html>`);
  await page.addScriptTag({content:'window.__name=(fn)=>fn;'});
  await page.addScriptTag({type:'module',content:bundle.outputFiles[0].text});
  const picker=page.locator('[data-enterprise-file]');
  await picker.setInputFiles({name:'收入.csv',mimeType:'text/csv',buffer:Buffer.from('收入,100')});
  await page.getByText('已识别1份，失败0份。', {exact:false}).waitFor();
  await picker.setInputFiles({name:'成本.csv',mimeType:'text/csv',buffer:Buffer.from('成本,50')});
  await page.getByText('已识别2份，失败0份。', {exact:false}).waitFor();
  await page.locator('[data-enterprise-analyze]').click();
  await page.getByText('分析报告已生成，可以下载或向智能体追问。', {exact:true}).waitFor();
  await page.evaluate(()=>{(window as any).leaveFinance();(window as any).openFinance();});
  assert.equal(await page.locator('[data-enterprise-select]').count(),2);
  assert.equal(await page.locator('[data-enterprise-html]').isDisabled(),false);
  assert.equal(await page.evaluate(()=>(window as any).modelCalls),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:output+'/finance-'+theme+'-'+width+'.png',fullPage:true});
  await page.evaluate(()=>{(window as any).leaveFinance();document.body.dataset.sessionWorkspaceId='other';});
  await page.waitForTimeout(0);
  await page.evaluate(()=>{document.body.dataset.sessionWorkspaceId='fixture';(window as any).openFinance();});
  assert.equal(await page.locator('[data-enterprise-select]').count(),0);
  await page.evaluate(()=>{(window as any).leaveFinance();(window as any).openHome();});
  await page.waitForFunction(()=>[...document.querySelectorAll('.home-entry-art img')].every(i=>(i as HTMLImageElement).naturalWidth>0));
  await page.evaluate(async()=>{await Promise.all([...document.querySelectorAll<HTMLImageElement>('.home-entry-art img')].map(img=>img.decode()));});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:output+'/home-'+theme+'-'+width+'.png',fullPage:true});
  await page.evaluate(()=>(window as any).openEnterprise());
  await page.locator('[name=keyword]').fill('合成企业');
  const chipContrast=await page.locator('[data-condition-clear=keyword]').evaluate(el=>{
    const style=getComputedStyle(el);const luminance=(value:string)=>{
      const rgb=value.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
      return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
    };const a=luminance(style.color),b=luminance(style.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
  assert.ok(chipContrast>=4.5,`${theme}: selected filter text needs readable contrast, got ${chipContrast}`);
  await page.getByLabel('选择地区', {exact:true}).click();
  await page.locator('[data-region-province]').selectOption({label:'河南省'});
  await page.locator('[data-region-done]').click();
  await page.locator('[data-online-search]').click();
  assert.equal(await page.evaluate(()=>(window as any).searchCalls),0,'ordinary search must not silently omit region');
  assert.match(await page.locator('#enterprise-online-scope').innerText(),/地区/);
  await page.screenshot({path:output+'/enterprise-'+theme+'-'+width+'.png',fullPage:true});
  await page.locator('[data-condition-clear=region]').click();
  await page.evaluate(()=>{(document.querySelector('[name=industry]') as HTMLInputElement).value='C';});
  await page.locator('[data-online-search]').click();
  assert.equal(await page.evaluate(()=>(window as any).searchCalls),0,'ordinary search must not silently omit industry');
  await page.evaluate(()=>{(document.querySelector('[name=industry]') as HTMLInputElement).value='';});
  await page.locator('[name=size]').selectOption({label:'1–49人'});
  await page.locator('[data-online-search]').click();
  assert.equal(await page.evaluate(()=>(window as any).searchCalls),0,'ordinary search must not silently omit size');
  await page.locator('[name=size]').selectOption('');
  await page.locator('[data-online-search]').click();
  await page.waitForFunction(()=>(window as any).searchCalls===1);
  assert.deepEqual(errors,[]); await page.close(); console.log('PASS',theme,width);
 }
} finally {await browser.close();}
