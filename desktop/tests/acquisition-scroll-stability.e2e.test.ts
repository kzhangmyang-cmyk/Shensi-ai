import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "../..");

// Real current view/controller subscription + fake observations; no API, secrets or platform request.
const fixture = `
import { mountDouyinAutomationView } from './frontend/src/acquisition/douyin-automation-view.ts';
let status = {state:'idle',diagnostic:null,currentActionKind:null,updatedAt:null,pendingReconciliationCount:0,ownership:'this_device'};
const eventListeners = new Set();
let subscriptions = 0;
const runtime = {
  bridge: {}, accountId:()=> 'workspace-fixture',
  outreachStatus:()=>status, enrollmentError:()=>null,
  bindingStatus:()=>({accountId:'account-fixture',executorMode:'desktop',bindingGeneration:1,
    leaseExpiresAt:'2099-01-01T00:00:00.000Z',ownedByInstallation:true,hasUnresolvedActions:false}),
  bindingError:()=>null,bindingPending:()=>false,
  subscribeOutreach(listener){ subscriptions++; eventListeners.add(listener); return ()=>eventListeners.delete(listener); },
  bindDesktopAccount:async()=>{}, synchronizeWorkspace:async()=>{},
  connectorStatus:()=>({state:'ready',protocolVersion:1,diagnostic:null})
};
let state = {
  phase:'ready',planId:'plan-fixture',planName:'桌面交互回归计划',planStatus:'approved',
  account:{id:'account-fixture',workspaceId:'workspace-fixture',platform:'douyin',displayName:'隔离测试账号',
    state:'active',loginStateVersion:1,revision:1,etag:'account:1',lastValidatedAt:null,
    createdAt:'2026-09-05T00:00:00.000Z',updatedAt:'2026-09-05T00:00:00.000Z'},
  loginSession:null,policy:null,draftPolicy:{keywords:['工业除尘'],
    schedule:{enabled:false,localTime:'09:30',timeZone:'Asia/Shanghai'},dailyCandidateLimit:50,
    collectCreators:true,collectDemandComments:true,
    limits:{maxVideos:30,maxCommentsPerVideo:50,maxPagesPerVideo:3,maxDurationSeconds:3600}},
  runIntent:null,activeRunId:null,crawlerStatus:null,
  candidates:Array.from({length:8},(_,i)=>({id:'candidate-'+i,status:'comment_candidate',
    displayName:'测试候选人 '+(i+1),evidence:{sourceUrl:'https://www.douyin.com/video/fixture-'+i,excerpt:'仅供隔离交互回归的公开证据摘要'}})),
  selectedCandidateIds:[],error:null,suggestionError:null,closed:false,
  connectorStatus:{state:'ready',protocolVersion:1,diagnostic:null}
};
const listeners = new Set();
const emit = ()=>listeners.forEach(listener=>listener(state));
const controller = {getState:()=>state,subscribe(listener){listeners.add(listener);listener(state);return ()=>listeners.delete(listener);},
  toggleCandidate(id){state={...state,selectedCandidateIds:state.selectedCandidateIds.includes(id)?[]:[id]};emit();},
  restartConnector:async()=>{},connect:async()=>{},close(){} };
const host = document.getElementById('automation');
const dispose = mountDouyinAutomationView(host,controller,()=>{}, {desktopRuntime:runtime});
const first = host.firstElementChild;
window.fixture = {
  tick(index){
    const states=['claiming','claimed','executing','reconciling','offline','risk_paused','idle'];
    status={...status,state:states[index%states.length],diagnostic:index%7===4?'central_unreachable':null,
      currentActionKind:index%2?'comment':'direct_message',updatedAt:new Date(1788566400000+index*1000).toISOString(),
      pendingReconciliationCount:index%7===3?1:0};
    eventListeners.forEach(listener=>listener());
    state={...state,account:{...state.account,lastValidatedAt:new Date(1788566400000+index*1000).toISOString()}};
    emit();
  },
  snapshot(){return {subscriptions,activeSubscriptions:eventListeners.size,hostPreserved:first===host.firstElementChild,
    selected:[...state.selectedCandidateIds]};},
  dispose(){dispose();return {activeSubscriptions:eventListeners.size,controllerSubscriptions:listeners.size};}
};
`;

test("current acquisition view preserves candidate, focus and one-pixel scroll during desktop status updates", { timeout: 45_000 }, async (t) => {
  const bundled = await build({ stdin: { contents: fixture, resolveDir: root, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", logLevel: "silent" });
  const css = await readFile(path.join(root, "frontend/src/replica-dashboard.css"), "utf8");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Shensi · 隔离桌面回归</title>
    <style>${css}</style><style>body{display:block!important;height:auto!important;overflow:auto!important;background:#080d0a;color:#eef5ef;margin:0;padding:24px}
    main{max-width:1200px;margin:auto}footer{height:900px}.douyin-candidate-table{max-height:none!important}</style></head>
    <body><main id="automation"></main><footer></footer><script type="module" src="/fixture.js"></script></body></html>`;
  const server = createServer((request, response) => {
    if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundled.outputFiles[0].text); }
    else if (request.url === "/") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); }
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/#acquisition`;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/*", (route) => new URL(route.request().url()).origin === new URL(url).origin
    ? route.continue() : route.abort());
  await page.goto(url);
  assert.equal(page.url(), url); assert.match(await page.title(), /Shensi/u);
  await page.getByRole("heading", { name: "候选人与证据" }).waitFor();
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  const checkbox = page.locator("[data-douyin-candidate]").nth(3);
  await checkbox.check();
  await checkbox.focus();
  await page.evaluate(() => {
    const target = document.activeElement!;
    window.scrollBy(0, target.getBoundingClientRect().top - 320);
    (window as any).pinnedControl = target;
    (window as any).initialScroll = window.scrollY;
  });
  const initial = await page.evaluate(() => (window as any).initialScroll as number);
  assert.ok(initial > 200, `expected a deep-scroll anchor, got ${initial}`);
  for (let index = 0; index < 28; index += 1) {
    const observed = await page.evaluate((i) => {
      (window as any).fixture.tick(i);
      return { ...((window as any).fixture.snapshot()), scroll: window.scrollY,
        focused: document.activeElement === (window as any).pinnedControl,
        checked: ((window as any).pinnedControl as HTMLInputElement).checked };
    }, index);
    assert.equal(observed.subscriptions, 1); assert.equal(observed.activeSubscriptions, 1);
    assert.equal(observed.hostPreserved, true); assert.equal(observed.focused, true);
    assert.equal(observed.checked, true); assert.deepEqual(observed.selected, ["candidate-3"]);
    assert.ok(Math.abs(observed.scroll - initial) <= 1, `status ${index} moved scroll ${initial} -> ${observed.scroll}`);
  }
  const output = process.env.SHENSI_DESKTOP_UI_SCREENSHOT_DIR;
  if (output) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "acquisition-selected.png") });
    await page.evaluate(() => { window.scrollTo(0, 0); (window as any).fixture.tick(2); });
    await page.screenshot({ path: path.join(output, "acquisition-executing.png") });
    t.diagnostic(`Browser plugin not available; Playwright evidence: ${output}`);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.dispose()),
    { activeSubscriptions: 0, controllerSubscriptions: 0 });
});
