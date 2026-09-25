import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { parseHTML } from 'linkedom';

// Real component + production styles: every role has a clean empty workspace
// and a reachable composer, while real history and citations remain intact.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const index = parseHTML(await readFile(`${root}index.html`, 'utf8')).document;
const css = (await Promise.all([...index.querySelectorAll('link[rel=stylesheet]')].map(link => readFile(`${root}${link.getAttribute('href')!.replace(/^\//, '')}`, 'utf8')))).join('\n');
const bundle = await build({ stdin: { resolveDir: root, contents: `
import {mountCfoConversation} from './src/growth/agents/cfo-conversation';
const saved={sessionId:'12345678-1234-4234-8234-123456789012',revision:1,title:'需要逐项核对的合成经营问题'.repeat(8),documentId:null,createdAt:'2026-09-24T00:00:00Z',updatedAt:'2026-09-24T00:00:00Z',turns:[{role:'user',text:'请核对合成记录'},{role:'assistant',text:'这是一段仅供布局验收的合成回答。'.repeat(80),model:'fixture',sourceLabel:'合成来源'}]};
saved.turns[1].research={status:'completed',query:'公开政策',searchProvider:'fixture',retrievedAt:'2026-09-25T00:00:00.000Z',evidenceKind:'search_index_snippets',citationIds:['S1'],sources:[{id:'S1',title:'公开政策与适用范围核对'.repeat(20),url:'https://example.org/policy',snippet:'这是公开搜索摘要，不能据此认定企业符合条件。'.repeat(10),fetchedAt:'2026-09-25T00:00:00.000Z'}]};
const http={request:async(path,options)=>{
 if(path.endsWith('/cfo-sessions'))return {body:[{...saved,turnCount:2}]};
 if(path.endsWith('/cfo-sessions/'+saved.sessionId))return {body:saved};
 if(path.endsWith('/public-research'))return {body:{connections:[]}};
 return {body:null};
}};
mountCfoConversation({host:document.querySelector('#demoModuleMain>div'),http,scope:()=> 'fixture:user'});
` }, bundle: true, format: 'esm', write: false, define: { 'import.meta.env': '{}' } });
const browser = await chromium.launch({ headless: true });
const output = '/tmp/shensi-agent-layout-qa'; await mkdir(output, { recursive: true });
try {
 for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 980, 873, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 768 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
   const path = new URL(route.request().url()).pathname;
   if(path==='/')return route.fulfill({body:'<html></html>',contentType:'text/html'});
   if (path.startsWith('/assets/business-advisor-agents/')) return route.fulfill({body:await readFile(`${root}public${path}`),contentType:'image/jpeg'});
   return route.abort();
  });
  await page.goto('http://127.0.0.1:45679/');
  await page.setContent(`<html data-theme="${theme}"><head><base href="http://127.0.0.1:45679/"><style>${css}</style></head><body class="is-authenticated" data-session-workspace-id="fixture" data-session-user-id="user"><div class="replica-shell is-agents-route"><aside class="replica-sidebar"></aside><main id="demoModuleMain" class="replica-demo-main"><div></div></main></div></body></html>`);
  await page.addScriptTag({ content: 'window.__name=(fn)=>fn;' });
  await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
  await page.locator('.cfo-composer').waitFor();
  for (const role of ['cfo','finance','profit','cost','cashflow','tax']) {
   await page.locator(`[data-cfo-role-choice="${role}"]`).click();
   const geometry = await page.evaluate(() => {
    const rect=(s:string)=>{const r=document.querySelector(s)!.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};};
    return {placeholderCount:document.querySelectorAll('[data-cfo-empty],.cfo-chat-empty-avatar').length,composer:rect('.cfo-composer'),title:rect('.cfo-composer-heading'),overflow:document.documentElement.scrollWidth>innerWidth+1};
   });
   await page.screenshot({path:`${output}/${theme}-${width}-${role}.png`});
   assert.equal(geometry.placeholderCount,0,`${theme}/${width}/${role}: obsolete empty-state remains`);
   await page.locator('.cfo-composer textarea').scrollIntoViewIfNeeded();
   assert.equal(await page.locator('.cfo-composer textarea').isVisible(),true);
   assert.equal(geometry.overflow,false, `${theme}/${width}/${role}: horizontal overflow ${JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('*')].filter(el=>el.getBoundingClientRect().width>innerWidth).map(el=>({tag:el.tagName,cls:el.className,w:el.getBoundingClientRect().width})).slice(0,12)))}`);
  }
  await page.locator('[data-cfo-role-choice=cfo]').click();
  const draft=page.locator('[data-cfo-question-form] textarea');
  await draft.fill('切换历史后仍需保留的未发送问题');
  await page.locator('[data-cfo-session]').click();
  await page.locator('[data-cfo-turns] article').nth(1).waitFor();
  assert.equal(await page.locator('[data-cfo-turns] article').count(),2);
  // Real wheel input must bubble from an unbounded reply to the main scroll owner.
  const main = page.locator(width >= 1000 ? '#demoModuleMain' : '[data-cfo-turns]');
  if (width < 1000) await main.scrollIntoViewIfNeeded();
  await main.evaluate(el => { el.scrollTop = 0; });
  const replyBox = await page.locator('[data-cfo-turns]').boundingBox();
  assert.ok(replyBox);
  if (width >= 1000) await main.evaluate(el => { el.scrollTop = 350; });
  const scrollStart = await main.evaluate(el => el.scrollTop);
  const wheelBox = await page.locator('[data-cfo-turns]').boundingBox();
  await page.mouse.move(wheelBox!.x + 30, Math.max(180, Math.min(500, wheelBox!.y + 80)));
  await page.mouse.wheel(0, 240);
  await page.waitForFunction(({selector,previous}) => document.querySelector(selector)!.scrollTop > previous + 80, {selector:width >= 1000 ? '#demoModuleMain' : '[data-cfo-turns]',previous:scrollStart}, {timeout:2000});
  const afterDown = await main.evaluate(el => el.scrollTop);
  await page.mouse.wheel(0, -120);
  await page.waitForFunction(({selector,previous}) => document.querySelector(selector)!.scrollTop < previous - 40, {selector:width >= 1000 ? '#demoModuleMain' : '[data-cfo-turns]',previous:afterDown}, {timeout:2000});
  await page.mouse.click(wheelBox!.x + 30, Math.max(180, Math.min(500, wheelBox!.y + 80)));
  const beforeKey = await main.evaluate(el => el.scrollTop);
  await page.keyboard.press('PageDown');
  await page.waitForFunction(({selector,previous}) => document.querySelector(selector)!.scrollTop > previous + 40, {selector:width >= 1000 ? '#demoModuleMain' : '[data-cfo-turns]',previous:beforeKey}, {timeout:2000});
  // Include the actual sibling inspector omitted by the original component fixture.
  if (width >= 901) {
    await page.evaluate(() => {
      const inspector = document.createElement('aside');
      inspector.className = 'replica-demo-inspector';
      inspector.textContent = '本次对话与财务委员会准备';
      document.querySelector('.replica-shell')!.append(inspector);
    });
    const area = await main.boundingBox();
    const aside = await page.locator('.replica-demo-inspector').boundingBox();
    assert.ok(area && aside && (width >= 1000 ? area.x + area.width <= aside.x : aside.y >= area.y + area.height), `${theme}/${width}: inspector crowds the chat`);
  }
  const citation=page.locator('.cfo-message-research summary');
  await citation.focus();await page.keyboard.press('Enter');
  assert.equal(await citation.evaluate(el=>(el.parentElement as HTMLDetailsElement).open),true);
  assert.equal(await page.locator('.cfo-message-research a').getAttribute('href'),'https://example.org/policy');
  await page.locator('.cfo-message-research a').scrollIntoViewIfNeeded();
  const contrast=await page.locator('.cfo-message-research a').evaluate(el=>{
    const rgb=(s:string)=>s.match(/[\d.]+/g)!.slice(0,3).map(Number);
    const luminance=(v:number[])=>v.map(n=>{const c=n/255;return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4);}).reduce((sum,c,i)=>sum+c*[0.2126,0.7152,0.0722][i],0);
    let parent:Element|null=el;let background='rgb(255,255,255)';
    while(parent){const value=getComputedStyle(parent).backgroundColor;if(value!=='rgba(0, 0, 0, 0)'&&value!=='transparent'){background=value;break;}parent=parent.parentElement;}
    const a=luminance(rgb(getComputedStyle(el).color)),b=luminance(rgb(background));return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
  });
  assert.ok(contrast>=4.5,`${theme}/${width}: citation contrast ${contrast}`);
  await page.screenshot({path:`${output}/${theme}-${width}-research.png`});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${theme}/${width}: long history or answer overflows`);
  assert.equal(await draft.inputValue(),'切换历史后仍需保留的未发送问题');
  await page.locator('[data-cfo-new-session]').click();
  assert.equal(await page.locator('[data-cfo-turns] article').count(),0);
  assert.equal(await draft.inputValue(),'切换历史后仍需保留的未发送问题');
  await draft.scrollIntoViewIfNeeded();
  const draftBox=await draft.boundingBox();
  assert.ok(draftBox&&draftBox.height>0&&draftBox.y>=0&&draftBox.y<768,`${theme}/${width}: composer cannot be reached after new conversation`);
  for(const summary of ['[data-agent-operating-workbench] > summary']) {
   await page.locator(summary).click();
   assert.equal(await page.locator(summary).evaluate(el=>(el.parentElement as HTMLDetailsElement).open),true);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${theme}/${width}: expanded panel overflows`);
   await draft.scrollIntoViewIfNeeded();
   const box=await draft.boundingBox();
   assert.ok(box&&box.height>0&&box.y>=0&&box.y<768,`${theme}/${width}: expanded panel traps composer`);
   assert.equal(await draft.inputValue(),'切换历史后仍需保留的未发送问题');
   await page.locator(summary).click();
  }
  assert.deepEqual(errors,[]);
  await page.close(); console.log(`PASS ${theme} ${width}`);
 }
} finally { await browser.close(); }
