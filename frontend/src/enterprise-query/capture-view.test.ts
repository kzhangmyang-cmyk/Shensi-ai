import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {renderEnterpriseCapture} from './capture-view';
test('capture pagination reports actual ranges and empty captures have no phantom page',()=>{
  const {document,window}=parseHTML('<main></main>');const host=document.querySelector('main')!;
  const capture={version:1 as const,sourceUrl:'https://aiqicha.baidu.com/s',capturedAt:new Date().toISOString(),items:Array.from({length:12},(_,i)=>({company:`企业${i}`,sourceUrl:'https://aiqicha.baidu.com/s'}))};
  renderEnterpriseCapture(host as unknown as HTMLElement,capture);
  assert.equal(host.querySelector('[data-capture-range]')!.textContent,'显示 1–10 / 12 家');
  host.querySelector('[data-capture-page="1"]')!.dispatchEvent(new window.Event('click',{bubbles:true}));
  assert.equal(host.querySelector('[data-capture-range]')!.textContent,'显示 11–12 / 12 家');
  assert.ok(host.querySelector('[data-capture-page="1"]')!.hasAttribute('disabled'));
  renderEnterpriseCapture(host as unknown as HTMLElement,{...capture,items:[]});
  assert.equal(host.querySelector('[data-capture-range]')!.textContent,'显示 0–0 / 0 家');
  assert.match(host.textContent!,/当前页没有企业资料/);
  assert.doesNotMatch(host.querySelector('footer')!.textContent!,/1 \/ 0/);
});
test('switching company resets detail scroll, append preserves it, and close/Escape restore row focus',()=>{
  const {document,window}=parseHTML('<main></main>');const host=document.querySelector('main')!;
  const capture={version:1 as const,sourceUrl:'https://aiqicha.baidu.com/s',capturedAt:new Date().toISOString(),items:[{company:'企业甲',sourceUrl:'https://aiqicha.baidu.com/s'},{company:'企业乙',sourceUrl:'https://aiqicha.baidu.com/s'}]};
  const view=renderEnterpriseCapture(host as unknown as HTMLElement,capture);
  const detail=host.querySelector('aside')!;
  const click=(selector:string)=>host.querySelector(selector)!.dispatchEvent(new window.Event('click',{bubbles:true}));
  click('[data-capture-company="0"]');detail.scrollTop=180;
  view.update(capture);assert.equal(detail.scrollTop,180);
  click('[data-capture-company="1"]');assert.equal(detail.scrollTop,0);
  let focused=false;host.querySelector<HTMLElement>('[data-capture-company="1"]')!.focus=()=>{focused=true;};
  click('[data-capture-close]');assert.equal(focused,true);assert.match(detail.textContent!,/选择一家企业/);
  click('[data-capture-company="1"]');focused=false;
  const escape=new window.Event('keydown',{bubbles:true});Object.defineProperty(escape,'key',{value:'Escape'});host.dispatchEvent(escape);
  assert.equal(focused,true);assert.equal(host.querySelector('[aria-pressed="true"]'),null);
});
test('detail provides explicit copy feedback without changing selected company',async()=>{
  const {document,window}=parseHTML('<main></main>');const host=document.querySelector('main')!;
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  let copied='';Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async(value:string)=>{copied=value;}}}});
  try{
  renderEnterpriseCapture(host as unknown as HTMLElement,{version:1,sourceUrl:'https://aiqicha.baidu.com/s',capturedAt:new Date().toISOString(),items:[{company:'企业甲',sourceUrl:'https://aiqicha.baidu.com/s',contactInfo:'010-12345678'}]});
  host.querySelector('[data-capture-company="0"]')!.dispatchEvent(new window.Event('click',{bubbles:true}));
  const copy=host.querySelector('[data-copy-value="010-12345678"]');assert.ok(copy);
  copy.dispatchEvent(new window.Event('click',{bubbles:true}));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(copied,'010-12345678');assert.match(host.querySelector('[data-copy-status]')!.textContent!,/已复制/);
  assert.equal(host.querySelector('[data-capture-company="0"]')!.getAttribute('aria-pressed'),'true');
  }finally{if(previous)Object.defineProperty(globalThis,'navigator',previous);else Reflect.deleteProperty(globalThis,'navigator');}
});
test('visible captures become selectable list and detail without CRM conversion or invented fields',()=>{
  const {document,window}=parseHTML('<main></main>');const host=document.querySelector('main')!;
  renderEnterpriseCapture(host as unknown as HTMLElement,{version:1,sourceUrl:'https://aiqicha.baidu.com/s',capturedAt:new Date().toISOString(),items:[{company:'企业甲',sourceUrl:'https://aiqicha.baidu.com/company_detail_123',legalPerson:'张三',businessScope:'塑料生产',insuredEmployees:'15人'},{company:'<img src=x>',sourceUrl:'https://aiqicha.baidu.com/s'}]});
  assert.equal(host.querySelectorAll('[data-capture-company]').length,2);
  host.querySelector('[data-capture-company="0"]')!.dispatchEvent(new window.Event('click',{bubbles:true}));
  assert.match(host.querySelector('aside')!.textContent!,/张三/);assert.match(host.querySelector('aside')!.textContent!,/15人/);
  assert.match(host.querySelector('aside')!.textContent!,/参保人数（非员工总数）/);
  assert.equal(host.querySelector('[data-join]'),null);assert.equal(host.querySelector('img'),null);
  host.querySelector('[data-capture-company="1"]')!.dispatchEvent(new window.Event('click',{bubbles:true}));
  assert.equal(host.querySelector('[data-capture-company="1"]')!.getAttribute('aria-pressed'),'true');
  assert.doesNotMatch(host.querySelector('aside')!.textContent!,/张三/);
});
