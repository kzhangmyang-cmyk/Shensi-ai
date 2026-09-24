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
const css = (await Promise.all([...index.querySelectorAll('link[rel=stylesheet]')].map(link => readFile(`${root}${link.getAttribute('href')!.replace(/^\//, '')}`, 'utf8')))).join('\n');
const bundle = await build({ stdin: { resolveDir: root, contents: `
import {mountCfoConversation} from './src/growth/agents/cfo-conversation';
let view;window.calls=[];window.expired=false;
const http={request:async(path,options)=>{
 window.calls.push({path,body:options?.body});
 if(path.endsWith('/cfo-sessions'))return {body:[]};
 if(path.endsWith('/inspect'))return {body:{documentId:crypto.randomUUID(),fileName:options.body.fileName,expiresAt:new Date(Date.now()+(window.expired?-1000:3600000)).toISOString(),fileHash:'sha256:'+'a'.repeat(64),selectedForConversation:true,modelStatus:'not_requested',classification:'unknown',cells:[],regions:[],uncertain:[],observations:[],missingStatements:[]}};
 if(path.endsWith('/cfo-conversation'))return {body:{answer:'合成附件回答',model:'fixture',material:null}};
 return {body:null};
}};
window.openChat=()=>{view=mountCfoConversation({host:document.querySelector('main'),http,scope:()=>document.body.dataset.sessionWorkspaceId+':user'});};
window.leaveChat=()=>{view.dispose();document.querySelector('main').replaceChildren();};window.openChat();
` }, bundle: true, format: 'esm', write: false, define: { 'import.meta.env': '{}' } });
const browser = await chromium.launch({ headless: true });
const output = '/tmp/shensi-chat-attachments-qa'; await mkdir(output, { recursive: true });
try {
  for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url() === 'http://127.0.0.1:45679/' ? route.fulfill({ contentType: 'text/html', body: '<html></html>' }) : route.abort());
    await page.goto('http://127.0.0.1:45679/');
    await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head><body class="is-authenticated" data-session-workspace-id="fixture" data-session-user-id="user"><main style="max-width:1100px;margin:auto"></main></body></html>`);
    await page.addScriptTag({ content: 'window.__name=(fn)=>fn;' });
    await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
    const picker = page.locator('[data-chat-files]');
    await picker.setInputFiles({ name: '合成资料.csv', mimeType: 'text/csv', buffer: Buffer.from('项目,金额\n材料,100') });
    await page.getByText('附件已解析；发送问题时使用这些资料，尚未调用模型。', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.path.endsWith('/cfo-conversation')).length), 0);
    await page.evaluate(() => { (window as any).leaveChat(); (window as any).openChat(); });
    await page.getByText('合成资料.csv · 1 KB', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.path.endsWith('/inspect')).length), 1);
    await page.locator('#cfoQuestion').fill('请解读资料');
    await page.locator('[data-cfo-question-form] [type=submit]').click();
    await page.getByText('合成附件回答', { exact: true }).waitFor();
    await page.evaluate(() => { (window as any).expired = true; });
    await page.locator('[data-chat-file-retry]').click();
    await page.getByText('附件已过期，请重新解析后再发送。', { exact: true }).waitFor();
    await page.locator('#cfoQuestion').fill('过期后不能发送');
    await page.locator('[data-cfo-question-form] [type=submit]').click();
    assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.path.endsWith('/cfo-conversation')).length), 1);
    await page.locator('.cfo-composer').screenshot({ path: `${output}/${theme}-${width}.png` });
    assert.deepEqual(errors, []);
    const overflow = await page.locator('.cfo-chat-attachments').evaluate(el => el.scrollWidth > el.clientWidth + 1);
    assert.equal(overflow, false);
    await page.close(); console.log(`PASS ${theme} ${width}`);
  }
} finally { await browser.close(); }
