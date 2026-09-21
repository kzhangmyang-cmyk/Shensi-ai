import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { mountDecisionSimulation } from './view';
import {operatingExample,type SimulationRecord} from './samples';

function recordFixture():SimulationRecord {
  const shock={demand:1,procurement:1,delivery:1,collectionDelay:0};
  const months=[1,2].map(month=>({month,cashMinor:10000,orders:10,delivered:10,backlogUnits:0,revenueMinor:1000,receiptsMinor:1000,paymentsMinor:500,profitMinor:500,receivablesMinor:0,shock}));
  return {runId:'12345678-1234-1234-1234-123456789012',createdAt:'2026-09-15T00:00:00Z',recordVersion:'decision-simulation.v1',input:operatingExample('normal'),paths:[[shock,shock],[shock,shock]],report:{modelVersion:'test',plans:[],replays:[{planId:'baseline',modelVersion:'test',samples:[0,1].map(()=>({months,minimumCashMinor:10000,totalProfitMinor:1000,fundingGapMinor:0}))}],sensitivity:[],threshold:{unitsForMonthlyOperatingBreakEven:1,withinBaselineCapacity:true,conditions:'test'}}};
}

function dom(t:test.TestContext){
  const value=parseHTML('<html><body><main></main></body></html>');
  const event=globalThis.Event;globalThis.Event=value.window.Event;
  t.after(()=>{globalThis.Event=event;});
  const prototype=value.window.HTMLSelectElement.prototype;
  const descriptor=Object.getOwnPropertyDescriptor(prototype,'value');
  Object.defineProperty(prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){this.querySelectorAll('option').forEach((option:HTMLOptionElement)=>option.selected=option.value===value);}});
  t.after(()=>{if(descriptor)Object.defineProperty(prototype,'value',descriptor);});
  return value;
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('step revisits preserve saved replay selection and edited inputs without writes or history reload',async t=>{
  const {document,window}=dom(t);const record=recordFixture();let reads=0;let writes=0;
  mountDecisionSimulation(document.querySelector('main')!,{list:async()=>[{runId:record.runId,title:record.input.title,dataKind:'synthetic',createdAt:record.createdAt}],get:async()=>{reads++;return record;},create:async()=>{writes++;return record;}});
  await flush();document.querySelector<HTMLButtonElement>('[data-run]')!.click();await flush();
  const replay=document.querySelector('.decision-replay');
  document.querySelector<HTMLButtonElement>('[data-world="1"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-step=source]')!.click();
  const title=document.querySelector<HTMLInputElement>('[name=title]')!;title.value='未保存草稿';title.dispatchEvent(new window.Event('input',{bubbles:true}));
  for(const step of ['facts','agents','worlds','report','source'])document.querySelector<HTMLButtonElement>(`[data-step=${step}]`)!.click();
  assert.equal(title.value,'未保存草稿');assert.equal(document.querySelector('.decision-replay'),replay);
  assert.equal(document.querySelector('[data-world="1"]')!.getAttribute('aria-pressed'),'true');
  assert.match(document.querySelector('[data-step-status]')!.textContent!,/输入已修改/);
  assert.equal(document.querySelector('[data-step=source]')!.getAttribute('aria-current'),'step');
  assert.equal(reads,1);assert.equal(writes,0);
});

test('navigation during a save keeps the selected step while the same task finishes',async t=>{
  const {document,window}=dom(t);const record=recordFixture();let writes=0;
  let finish!:(value:SimulationRecord)=>void;
  mountDecisionSimulation(document.querySelector('main')!,{list:async()=>[],get:async()=>record,create:()=>{writes++;return new Promise(resolve=>{finish=resolve;});}});
  document.querySelector('form')!.dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();
  document.querySelector<HTMLButtonElement>('[data-step=facts]')!.click();
  assert.equal(document.querySelector<HTMLInputElement>('[name=monthlyOrders]')!.disabled,true,'in-flight inputs cannot invalidate the submitted snapshot');
  finish(record);await flush();
  assert.equal(document.querySelector('.decision-simulation')!.getAttribute('data-view'),'input');
  assert.equal(document.querySelector('[data-step=facts]')!.getAttribute('aria-current'),'step');
  assert.equal(document.querySelector<HTMLInputElement>('[name=monthlyOrders]')!.disabled,false);
  document.querySelector<HTMLButtonElement>('[data-step=report]')!.click();
  assert.match(document.querySelector('.decision-report-header')!.textContent!,/正常经营/);
  assert.equal(writes,1);
});
test('decision entry exposes explicit examples without auto-generating or writing records', async (t) => {
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  // Linkedom lacks the native select.value setter; emulate only that DOM operation.
  const descriptor=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){this.querySelectorAll('option').forEach((option:HTMLOptionElement)=>option.selected=option.value===value);}});
  t.after(()=>{if(descriptor)Object.defineProperty(window.HTMLSelectElement.prototype,'value',descriptor);});
  let writes=0;
  mountDecisionSimulation(document.querySelector('main')!,{list:async()=>[],create:async()=>{writes++;throw new Error('not called');},get:async()=>{throw new Error('not called');}});
  assert.match(document.body.textContent!,/正常经营/);
  assert.match(document.body.textContent!,/回款延迟/);
  assert.match(document.body.textContent!,/产能受限/);
  assert.equal(writes,0);
  assert.equal(document.querySelector('.decision-hero h2')!.textContent,'星盘决策模拟');
  assert.ok(document.querySelector('input[type=file][multiple]'),'the primary workflow accepts actual enterprise files');
  assert.ok(document.querySelector('[data-source-inspect]'),'source reading is an explicit action');
  assert.ok(document.querySelector('[data-model-consent]'),'model use requires confirming selected sources');
  assert.ok(document.querySelector('button[type=submit]'));
  assert.equal(document.querySelectorAll('.decision-workflow button').length,5);
  document.querySelector<HTMLButtonElement>('[data-step=agents]')!.click();
  assert.match(document.querySelector('[data-step-status]')!.textContent!,/尚未|未就绪/);
  assert.equal(writes,0);
});
