import assert from 'node:assert/strict';
import test from 'node:test';
import {parseHTML} from 'linkedom';
import {mountDecisionAnalysis} from './analysis-view';
import type {components} from '../generated/decision-simulation';

test('galaxy statuses and retry follow actual preparation, never elapsed decorative time',()=>{
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  let retries=0;
  const control=mountDecisionAnalysis(document.querySelector('main')!,()=>{retries++;});
  assert.ok(document.querySelector('.decision-galaxy > canvas.decision-galaxy-dust'));
  assert.equal(document.querySelector('.decision-galaxy-atmosphere')?.getAttribute('src'),document.querySelector('.decision-galaxy-base')?.getAttribute('src'));
  assert.equal(document.querySelector('.decision-galaxy-atmosphere')?.getAttribute('aria-hidden'),'true');
  const value:components['schemas']['Preparation']={id:'test',expiresAt:'2026-09-15T00:00:00Z',dataKind:'synthetic',state:'analyzing',files:[],sources:[],facts:[],uncertain:[],runId:null,errorCode:null,agents:[{role:'founder',state:'completed',observations:[],provider:'fixture',model:'actual-fixture',errorCode:null},{role:'market',state:'running',observations:[],provider:null,model:null,errorCode:null}]};
  control.update(value);
  assert.equal(document.querySelector('[data-analysis-progress]')?.textContent,'已完成 1 / 5');
  assert.equal(document.querySelector('[data-analysis-node="market"]')?.getAttribute('data-state'),'running');
  assert.equal(document.querySelector('[data-analysis-node="judge"]')?.getAttribute('data-state'),'queued');
  const retry=document.querySelector<HTMLButtonElement>('[data-analysis-retry]')!;assert.equal(retry.hidden,true);
  document.querySelector<HTMLButtonElement>('[data-reduce-motion]')!.click();
  assert.equal(document.querySelector('.decision-analysis')?.getAttribute('data-motion'),'paused');
  control.update({...value,state:'failed',errorCode:'decision_model_unavailable'});assert.equal(retry.hidden,false);retry.click();assert.equal(retries,1);
  control.update({...value,state:'completed',agents:(['founder','market','operations','finance','judge'] as const).map(role=>({role,state:'completed',observations:[],provider:'fixture',model:'actual-fixture',errorCode:null}))});
  assert.equal(retry.hidden,true);assert.equal(document.querySelector('[data-analysis-progress]')?.textContent,'已完成 5 / 5');
  Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(document.querySelector('.decision-analysis')?.getAttribute('data-motion'),'paused');control.dispose();
});

test('history galaxy exposes saved role content without showing running progress or retry',()=>{
  const {document}=parseHTML('<html><body><main></main></body></html>');
  const view=mountDecisionAnalysis(document.querySelector('main')!,()=>{throw new Error('must not retry history');});
  view.update({id:'saved',expiresAt:'',dataKind:'synthetic',state:'completed',files:[],sources:[{sourceRef:'calc:1',text:'已保存计算'}],facts:[],uncertain:[],runId:'saved',errorCode:null,agents:[{role:'finance',state:'completed',observations:[{text:'保存的现金说明',sourceRefs:['calc:1']}],provider:'saved-provider',model:'saved-model',errorCode:null}]},'history');
  document.querySelector<HTMLElement>('[data-analysis-node=finance]')!.click();
  assert.match(document.querySelector('[data-analysis-headline]')!.textContent!,/历史/);
  assert.match(document.querySelector('[data-analysis-evidence]')!.textContent!,/保存的现金说明/);
  assert.match(document.querySelector('[data-analysis-evidence]')!.textContent!,/已保存计算/);
  assert.equal(document.querySelector<HTMLButtonElement>('[data-analysis-retry]')!.hidden,true);
  view.setActive(false);
  view.update({id:'pending',expiresAt:'',dataKind:'synthetic',state:'analyzing',files:[],sources:[],facts:[],uncertain:[],runId:null,errorCode:null,agents:[]});
  assert.equal(document.querySelector('.decision-analysis')!.getAttribute('data-motion'),'paused','polling must not reactivate a hidden step');
  view.dispose();
});

test('empty analysis exposes five pending duties without starting a task',()=>{
  const {document}=parseHTML('<html><body><main></main></body></html>');
  let calls=0;const view=mountDecisionAnalysis(document.querySelector('main')!,()=>{calls++;});
  view.update({id:'preview',expiresAt:'',dataKind:'synthetic',state:'completed',files:[],sources:[],facts:[],uncertain:[],runId:null,errorCode:null,agents:[]},'empty');
  const nodes=document.querySelectorAll<HTMLElement>('[data-analysis-node]');assert.equal(nodes.length,5);
  for(const node of nodes){assert.equal(node.querySelector('[data-node-state]')?.textContent,'待开始');node.click();assert.match(document.querySelector('[data-analysis-evidence]')!.textContent!,/职责/);assert.equal(node.getAttribute('aria-pressed'),'true');}
  assert.equal(document.querySelector<HTMLElement>('.decision-analysis-progress-header')!.hidden,true);
  assert.equal(document.querySelector<HTMLElement>('.decision-analysis-findings')!.hidden,true);
  assert.equal(calls,0);view.dispose();
});

test('cosmos progress and result strip use saved observations and references, never concept numbers',()=>{
  const {document}=parseHTML('<html><body><main></main></body></html>');
  const view=mountDecisionAnalysis(document.querySelector('main')!,()=>{});
  const value:components['schemas']['Preparation']={id:'partial',expiresAt:'',dataKind:'user_defined',state:'analyzing',files:[],sources:[{sourceRef:'file:1:A1',text:'已确认来源'}],facts:[],uncertain:[],runId:null,errorCode:null,agents:[{role:'finance',state:'completed',observations:[{text:'现金观察',sourceRefs:['file:1:A1']},{text:'成本观察',sourceRefs:['file:1:A1']}],provider:'fixture',model:'fixture',errorCode:null}]};
  view.update(value);
  assert.equal(document.querySelector('progress')?.getAttribute('value'),'1');
  assert.equal(document.querySelector('progress')?.getAttribute('max'),'5');
  assert.equal(document.querySelector('[data-findings-count]')?.textContent,'2');
  assert.equal(document.querySelector('[data-evidence-count]')?.textContent,'1');
  document.querySelector<HTMLButtonElement>('[data-analysis-open-results]')!.click();
  assert.match(document.querySelector('[data-analysis-evidence]')!.textContent!,/现金观察/);
  view.update({...value,agents:[]},'empty');
  assert.equal(document.querySelector('progress')?.hasAttribute('hidden'),true);
  assert.equal(document.querySelector('[data-analysis-percent]')?.textContent,'预览');
  assert.equal(document.querySelector('[data-findings-count]')?.textContent,'0');
  assert.equal(document.querySelector<HTMLButtonElement>('[data-analysis-open-results]')!.disabled,true);
  assert.match(document.querySelector('[data-findings-heading]')!.textContent!,/尚无/);
  view.dispose();
});
