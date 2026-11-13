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
saved.turns[1].knowledge={status:'used',detailedText:'合成参考详细解读需要结合实际经营情况分析。'.repeat(350),warnings:['table_unverified'],sources:[{sourceId:'K1',documentId:'11111111-1111-4111-8111-111111111111',versionId:'22222222-2222-4222-8222-222222222222',chunkId:'44444444-4444-4444-8444-444444444444',sourceHash:'a'.repeat(64),sourceLabel:'合成预算参考章节'.repeat(20),locator:{page:17,chapter:'预算编制'},excerpt:'合成预算原文须核对适用条件。'.repeat(35),warnings:['table_unverified']}]};
const http={request:async(path,options)=>{
 if(path.endsWith('/cfo-sessions'))return {body:[{...saved,turnCount:2}]};
 if(path.endsWith('/cfo-sessions/'+saved.sessionId))return {body:saved};
 if(path.endsWith('/public-research'))return {body:{connections:[]}};
 return {body:null};
}};
mountCfoConversation({host:document.querySelector('#demoModuleMain>div>div'),http,scope:()=> 'fixture:user'});
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
  await page.setContent(`<html data-theme="${theme}" style="height:100%"><head><base href="http://127.0.0.1:45679/"><style>${css}</style></head><body class="is-authenticated" data-session-workspace-id="fixture" data-session-user-id="user" style="height:100%;margin:0"><div class="replica-shell is-agents-route"><aside class="replica-sidebar"></aside><header class="replica-header"><div class="replica-title"><h1>智能体中心</h1></div></header><main id="demoModuleMain" class="replica-demo-main"><div><div></div></div></main><aside class="replica-demo-inspector"></aside></div></body></html>`);
  await page.addScriptTag({ content: 'window.__name=(fn)=>fn;' });
  await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
  await page.locator('.cfo-composer').waitFor();
  for (const role of ['cfo','finance','profit','cost','cashflow','tax']) {
   await page.locator(`[data-cfo-role-choice="${role}"]`).click();
   const network=page.locator('[data-cfo-web-search]');
   assert.equal(await network.getAttribute('aria-pressed'),'false',`${role}: new role defaults offline`);
   await network.focus();await page.keyboard.press('Space');
   assert.equal(await network.getAttribute('aria-pressed'),'true');
   assert.equal(await network.textContent(),'联网搜索 · 开');
   const networkContrast=await network.evaluate(el=>{
    const rgb=(s:string)=>s.match(/[\d.]+/g)!.slice(0,3).map(Number);
    const lum=(c:number[])=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
    const style=getComputedStyle(el);let bg=style.backgroundColor;let parent=el.parentElement;
    while((bg==='rgba(0, 0, 0, 0)'||bg==='transparent')&&parent){bg=getComputedStyle(parent).backgroundColor;parent=parent.parentElement;}
    const a=lum(rgb(style.color)),b=lum(rgb(bg));return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
   });
   assert.ok(networkContrast>=4.5,`${theme}/${width}/${role}: enabled network text contrast ${networkContrast}`);
   await network.press('Space');
   assert.equal(await network.getAttribute('aria-pressed'),'false');
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
  // Message list is the scroll owner; the page/main pane stays fixed while chatting.
  const turns = page.locator('[data-cfo-turns]');
  await turns.scrollIntoViewIfNeeded();
  await turns.evaluate(el => { el.scrollTop = 0; });
  const replyBox = await turns.boundingBox();
  assert.ok(replyBox);
  // Ensure the list is tall enough to scroll under the chat-app layout.
  await turns.evaluate(el => {
    if (el.scrollHeight <= el.clientHeight + 40) {
      const filler = document.createElement('article');
      filler.dataset.role = 'assistant';
      filler.innerHTML = '<div class="cfo-chat-bubble"><p>' + '布局滚动填充。'.repeat(120) + '</p></div>';
      el.append(filler);
    }
  });
  const scrollStart = await turns.evaluate(el => el.scrollTop);
  const wheelBox = await turns.boundingBox();
  await page.mouse.move(wheelBox!.x + 30, Math.max(180, Math.min(500, wheelBox!.y + 80)));
  await page.mouse.wheel(0, 240);
  try {
    await page.waitForFunction(({previous}) => document.querySelector('[data-cfo-turns]')!.scrollTop > previous + 40, {previous:scrollStart}, {timeout:2000});
  } catch (error) {
    console.error('scroll diag', await page.evaluate(() => {
      const t=document.querySelector('[data-cfo-turns]') as HTMLElement;
      const c=document.querySelector('.cfo-conversation') as HTMLElement;
      const m=document.querySelector('#demoModuleMain') as HTMLElement;
      const cs=(el:Element)=> {const s=getComputedStyle(el);return {h: (el as HTMLElement).clientHeight, sh:(el as HTMLElement).scrollHeight, overflow:s.overflowY, maxH:s.maxHeight};};
      return {turns:cs(t), workspace:cs(document.querySelector('.cfo-chat-workspace')!), layout:cs(document.querySelector('.cfo-session-layout')!), conversation:cs(c), main:cs(m)};
    }));
    throw error;
  }
  const afterDown = await turns.evaluate(el => el.scrollTop);
  await page.mouse.wheel(0, -120);
  await page.waitForFunction(({previous}) => document.querySelector('[data-cfo-turns]')!.scrollTop < previous - 20, {previous:afterDown}, {timeout:2000});
  await page.mouse.click(wheelBox!.x + 30, Math.max(180, Math.min(500, wheelBox!.y + 80)));
  const beforeKey = await turns.evaluate(el => el.scrollTop);
  await page.keyboard.press('PageDown');
  await page.waitForFunction(({previous}) => document.querySelector('[data-cfo-turns]')!.scrollTop > previous + 20, {previous:beforeKey}, {timeout:2000});
  if (width >= 1000) {
    const pageScroll = await page.evaluate(() => ({
      main: document.querySelector('#demoModuleMain')!.scrollTop,
      doc: document.documentElement.scrollTop + document.body.scrollTop,
    }));
    assert.equal(pageScroll.main, 0, `${theme}/${width}: main pane should not scroll while chatting`);
  }
  // Include the actual sibling inspector omitted by the original component fixture.
  if (width >= 901) {
    await page.evaluate(() => {
      let inspector = document.querySelector<HTMLElement>('.replica-demo-inspector');
      if (!inspector) {
        inspector = document.createElement('aside');
        inspector.className = 'replica-demo-inspector';
        document.querySelector('.replica-shell')!.append(inspector);
      }
      inspector.textContent = '本次对话与财务委员会准备';
      inspector.hidden = false;
    });
    const area = await page.locator('#demoModuleMain').boundingBox();
    const aside = await page.locator('.replica-demo-inspector').boundingBox();
    assert.ok(area && aside && (width >= 1000 ? area.x + area.width <= aside.x + 1 : aside.y >= area.y + area.height - 1), `${theme}/${width}: inspector crowds the chat`);
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
  const privateSummary=page.locator('.cfo-message-knowledge summary');
  await privateSummary.focus();await page.keyboard.press('Enter');
  assert.equal(await privateSummary.evaluate(el=>(el.parentElement as HTMLDetailsElement).open),true);
  assert.ok((await page.locator('.cfo-message-knowledge a').getAttribute('href'))?.startsWith('#knowledge?document=11111111'));
  await page.locator('.cfo-message-knowledge a').scrollIntoViewIfNeeded();
  const knowledgeContrast=await page.locator('.cfo-message-knowledge a').evaluate(el=>{
    const rgb=(s:string)=>s.match(/[\d.]+/g)!.slice(0,3).map(Number);
    const light=(v:number[])=>v.map(n=>{const c=n/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((s,c,i)=>s+c*[.2126,.7152,.0722][i],0);
    let parent:Element|null=el,background='rgb(255,255,255)';while(parent){const value=getComputedStyle(parent).backgroundColor;if(!['transparent','rgba(0, 0, 0, 0)'].includes(value)){background=value;break;}parent=parent.parentElement;}
    const a=light(rgb(getComputedStyle(el).color)),b=light(rgb(background));return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
  assert.ok(knowledgeContrast>=4.5,`${theme}/${width}: private citation contrast ${knowledgeContrast}`);
  await page.screenshot({path:`${output}/${theme}-${width}-knowledge.png`});
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
