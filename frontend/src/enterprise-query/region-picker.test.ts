import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {mountRegionPicker} from './region-picker';
test('national picker cascades, searches, marks direct counties and clears old city',()=>{
  const {document,window}=parseHTML('<main></main>');
  const host=document.querySelector('main')!;
  const picker=mountRegionPicker(host as unknown as HTMLElement,()=>{});
  const choose=(selector:string,value:string)=>{
    const el=host.querySelector(selector)!;
    el.querySelectorAll('option').forEach(o=>o.removeAttribute('selected'));
    el.querySelector(`option[value="${value}"]`)!.setAttribute('selected','');
    el.dispatchEvent(new window.Event('change',{bubbles:true}));
  };
  assert.equal(host.querySelectorAll('[data-region-province] option').length,35);
  choose('[data-region-province]','41'); choose('[data-region-city]','4101');
  assert.equal(host.querySelector<HTMLInputElement>('[name=region]')!.value,'4101');
  assert.match(host.querySelector('[data-region-path]')!.textContent!,/河南省.*郑州市/);
  assert.match(host.querySelector('option[value="419001"]')!.textContent!,/省直辖县级/);
  choose('[data-region-province]','11');
  assert.equal(host.querySelector<HTMLInputElement>('[name=region]')!.value,'11');
  assert.equal(host.querySelector('[data-region-city]')!.hasAttribute('disabled'),true);
  const search=host.querySelector<HTMLInputElement>('[data-region-search]')!;
  search.value='仙桃'; search.dispatchEvent(new window.Event('input',{bubbles:true}));
  host.querySelector('[data-region-code="429004"]')!.dispatchEvent(new window.Event('click',{bubbles:true}));
  assert.equal(host.querySelector<HTMLInputElement>('[name=region]')!.value,'429004');
  picker.reset();
  assert.equal(host.querySelector<HTMLInputElement>('[name=region]')!.value,'');
});
