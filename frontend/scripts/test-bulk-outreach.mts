// Isolated UI fixture: all API calls are in-memory; no real accounts or sends.
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
const css = (await Promise.all([...index.querySelectorAll('link[rel=stylesheet]')].map(async link =>
  readFile(`${root}${link.getAttribute('href')!.replace(/^\//, '')}`, 'utf8')))).join('\n');
const bundle = await build({ stdin: { resolveDir: root, contents: `
import {createConversationCaptureFixture} from './src/conversations/real-capture-fixture';
import {createRealConversationsController} from './src/conversations/real-controller';
import {createDouyinAutomationController} from './src/acquisition/douyin-automation-controller';
import {mountDouyinAutomationView} from './src/acquisition/douyin-automation-view';
import {isDouyinCommentOutreachCandidate} from './src/acquisition/douyin-automation-api';
const fixture=createConversationCaptureFixture();
const base=fixture.snapshot.interactions[0];
fixture.snapshot.interactions=[1,2,3].map(n=>({...base,key:'run-1:candidate-'+n,candidateId:'candidate-'+n,displayName:'隔离测试收件人 '+n,outreachEligible:n!==3}));
let batch=null;let actions=[];window.fixtureWrites=[];
const api={load:async()=>fixture.snapshot};
const outreachApi={listBatches:async()=>({items:[],nextCursor:null}),getBatch:async()=>batch,
createBatch:async(run,ids)=>{window.fixtureWrites.push('prepare');batch={...fixture.outreach.batch,candidates:ids.map(id=>({...fixture.outreach.batch.candidates[0],candidateId:id,publicProfileUrl:'https://www.douyin.com/user/'+id}))};return batch;},
listActions:async()=>({items:actions}),approveBatch:async()=>{throw Error('comment approval forbidden');},
approveDirectMessages:async(id,command)=>{window.fixtureWrites.push(command);actions=command.candidates.map((c,n)=>({id:'action-'+n,batchId:batch.id,batchRevision:batch.revision,candidateId:c.candidateId,accountId:batch.accountId,accountLoginStateVersion:1,kind:'direct_message',sequence:2,status:'queued',authorizationVersion:3,executionTarget:'desktop',attemptCount:0,platformReceiptReference:null,failureCode:null,targetPublicUrl:'https://www.douyin.com/user/'+c.candidateId,updatedAt:'2026-09-24T00:00:00.000Z'}));return batch;},
updateBatch:async()=>batch,pauseBatch:async()=>({...batch,state:'paused'}),resumeBatch:async()=>batch,rejectBatch:async()=>({...batch,state:'rejected'})};
const controller=createRealConversationsController({api,outreachApi,main:document.querySelector('main'),inspector:document.querySelector('aside'),outreachPollDelayMs:100000,batchSelection:{read:()=>null,remember:()=>{},clear:()=>{},subscribe:()=>()=>{}}});
window.fixtureController=controller;controller.open();
window.fixtureSuccess=()=>{actions=actions.map(a=>({...a,status:'succeeded',platformReceiptReference:'isolated-receipt',attemptCount:1}));};
window.showCandidates=async()=>{
controller.destroy();
const candidates=[1,2,3].map(n=>({id:'candidate-'+n,status:'comment_candidate',displayName:'隔离候选 '+n,evidence:{sourceUrl:n===3?'https://www.douyin.com/user/profile':'https://www.douyin.com/video/'+n,excerpt:'可复核的公开需求证据'}}));
window.candidateReads=[];
const ports={listAccounts:async()=>({items:[]}),getAutomation:async()=>({id:null,source:'default',keywords:[],dailyCandidateLimit:50,collectCreators:true,collectDemandComments:true,schedule:{enabled:false,localTime:'09:30',timeZone:'Asia/Shanghai'},limits:{maxVideos:30,maxCommentsPerVideo:50,maxPagesPerVideo:3,maxDurationSeconds:3600}}),getCrawlerStatus:async(runId)=>({runId,state:'succeeded',candidateProjectionState:'ready',candidateBudgetUsed:3,candidateBudgetLimit:50,recordCount:3,lastErrorCode:null}),listRunCandidates:async(runId,signal,query)=>{window.candidateReads.push(query?.cursor??null);return query?.cursor?{items:candidates.slice(1),nextCursor:null}:{items:candidates.slice(0,2),nextCursor:'next'};}};
const c=createDouyinAutomationController({api:new Proxy(ports,{get:(target,key)=>key in target?target[key]:()=>{throw Error('candidate test must not write: '+String(key));}})});
await c.load('fixture-plan','隔离计划','fixture-run');
window.candidateController=c;
mountDouyinAutomationView(document.querySelector('main'),c,()=>{throw Error('must not create approval');});
};
` }, bundle: true, format: 'esm', write: false, define: { 'import.meta.env': '{}' } });
const browser = await chromium.launch({ headless: true });
const output = '/tmp/shensi-bulk-outreach-qa';
await mkdir(output, { recursive: true });
try {
  for (const theme of ['dark', 'light']) for (const width of [1440, 1024, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 950 } });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.abort());
    await page.setContent(`<html data-theme="${theme}"><head><title>批量私信隔离验收</title><style>${css}</style></head><body class="is-authenticated"><div class="replica-shell" style="display:block;padding:12px;min-height:100vh"><main></main><aside></aside></div></body></html>`);
    await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
    await page.locator('[data-real-conversations-action=select-recipients]').click();
    assert.match(await page.locator('.real-conversation-bulk-controls').innerText(), /已选 2 人/);
    assert.equal(await page.locator('[data-real-conversations-recipient="run-1:candidate-3"]').isDisabled(), true);
    await page.locator('[data-real-conversations-action=prepare-recipients]').click();
    await page.locator('[data-outreach-field=directMessage]').first().waitFor();
    assert.equal(await page.locator('[data-outreach-field=directMessage]').count(), 2);
    await page.locator('.outreach-direct-message-preview summary').click();
    assert.equal(await page.locator('[data-outreach-action=approve-direct-messages]').isDisabled(), true);
    await page.locator('[data-outreach-direct-message-confirm]').check();
    await page.locator('[data-outreach-field=directMessage]').first().fill('修改后的隔离正文');
    assert.equal(await page.locator('[data-outreach-direct-message-confirm]').isChecked(), false);
    await page.locator('[data-outreach-direct-message-confirm]').check();
    await page.locator('[data-outreach-action=approve-direct-messages]').click();
    await page.waitForFunction(() => (window as any).fixtureWrites.length === 2);
    const writes = await page.evaluate(() => (window as any).fixtureWrites);
    assert.deepEqual(writes[1].candidates.map((c: any) => c.candidateId), ['candidate-1', 'candidate-2']);
    assert.equal(writes[1].candidates[0].directMessage, '修改后的隔离正文');
    await page.locator('[data-outreach-receipts] summary').click();
    await page.waitForFunction(() => document.querySelectorAll('.outreach-action.is-queued').length === 2);
    await page.evaluate(() => (window as any).fixtureSuccess());
    await page.locator('[data-outreach-action=refresh]').click();
    await page.waitForFunction(() => document.querySelectorAll('.outreach-action.is-succeeded').length === 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${theme}/${width}: horizontal overflow`);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true });
    await page.evaluate(() => (window as any).showCandidates());
    assert.deepEqual(await page.evaluate(() => (window as any).candidateReads), [null, 'next']);
    await page.locator('[data-douyin-action=select-all-candidates]').click();
    assert.match(await page.locator('.douyin-candidate-selection').innerText(), /已选 2 人/);
    assert.equal(await page.locator('[data-douyin-action=select-all-candidates]').isDisabled(), true);
    await page.evaluate(() => (window as any).candidateController.selectAllCandidates(true));
    assert.equal(await page.locator('.douyin-candidate-selection strong').nth(1).innerText(), '2');
    assert.deepEqual(await page.locator('.douyin-candidate-number').allTextContents(), ['1', '2', '3']);
    await page.locator('[data-douyin-action=clear-candidates]').click();
    assert.match(await page.locator('.douyin-candidate-selection').innerText(), /已选 0 人/);
    assert.equal(await page.locator('.douyin-candidates-panel').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await page.locator('.douyin-candidates-panel').screenshot({ path: `${output}/candidates-${theme}-${width}.png` });
    await page.evaluate(() => (window as any).candidateController.close());
    await page.close();
    console.log(`PASS ${theme} ${width}: select, prepare, edit invalidation, exact approval, no overflow`);
  }
} finally { await browser.close(); }
