import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { parseHTML } from 'linkedom';

// Real component + production styles: a short desktop must never shrink the
// empty-state avatar into the composer when attachments take vertical space.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const index = parseHTML(await readFile(`${root}index.html`, 'utf8')).document;
const css = (await Promise.all([...index.querySelectorAll('link[rel=stylesheet]')].map(link => readFile(`${root}${link.getAttribute('href')!.replace(/^\//, '')}`, 'utf8')))).join('\n');
const bundle = await build({ stdin: { resolveDir: root, contents: `
import {mountCfoConversation} from './src/growth/agents/cfo-conversation';
const http={request:async(path,options)=>{
 if(path.endsWith('/cfo-sessions'))return {body:[]};
 if(path.endsWith('/public-research'))return {body:{connections:[]}};
 return {body:null};
}};
mountCfoConversation({host:document.querySelector('#demoModuleMain>div'),http,scope:()=> 'fixture:user'});
` }, bundle: true, format: 'esm', write: false, define: { 'import.meta.env': '{}' } });
const browser = await chromium.launch({ headless: true });
const output = '/tmp/shensi-agent-layout-qa'; await mkdir(output, { recursive: true });
try {
 for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 390]) {
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
  await page.locator('.cfo-chat-empty-avatar').waitFor();
  for (const role of ['cfo','finance','profit','cost','cashflow','tax']) {
   await page.locator(`[data-cfo-role-choice="${role}"]`).click();
   const geometry = await page.evaluate(() => {
    const rect=(s:string)=>{const r=document.querySelector(s)!.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};};
    return {avatar:rect('.cfo-chat-empty-avatar'),empty:rect('.cfo-chat-empty'),composer:rect('.cfo-composer'),title:rect('.cfo-composer-heading'),overflow:document.documentElement.scrollWidth>innerWidth+1};
   });
   await page.screenshot({path:`${output}/${theme}-${width}-${role}.png`});
   assert.ok(geometry.avatar.top >= geometry.empty.top-1, `${theme}/${width}/${role}: avatar clipped above empty-state ${JSON.stringify(geometry)}`);
   assert.ok(geometry.avatar.bottom <= geometry.composer.top+1, `${theme}/${width}/${role}: avatar overlaps composer ${JSON.stringify(geometry)}`);
   assert.equal(geometry.overflow,false, `${theme}/${width}/${role}: horizontal overflow ${JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('*')].filter(el=>el.getBoundingClientRect().width>innerWidth).map(el=>({tag:el.tagName,cls:el.className,w:el.getBoundingClientRect().width})).slice(0,12)))}`);
  }
  assert.deepEqual(errors,[]);
  await page.close(); console.log(`PASS ${theme} ${width}`);
 }
} finally { await browser.close(); }
