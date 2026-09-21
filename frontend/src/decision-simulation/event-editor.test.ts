import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { mountEventEditor } from './event-editor';
import { operatingExample } from './samples';
test('events are opt-in, an explicit applicable template updates options and conflicting months are not accepted',()=>{
  const {document}=parseHTML('<main></main>');let options=operatingExample('normal').options;
  const read=()=>options;
  mountEventEditor(document.querySelector('main')!,()=>options,value=>{options=value;});
  document.querySelector('option')!.setAttribute('selected','');
  assert.equal(read().events,undefined);
  document.querySelector<HTMLButtonElement>('[data-event-add]')!.click();
  assert.equal(read().events?.length,1);
  assert.equal(read().events?.[0].template,'staffing_shortage');
  assert.match(document.querySelector('[data-event-list]')!.textContent!,/人员/);
  document.querySelector<HTMLButtonElement>('[data-event-add]')!.click();
  assert.equal(read().events?.length,1);
  assert.match(document.querySelector('[data-event-status]')!.textContent!,/重复|冲突/);
  document.querySelector<HTMLButtonElement>('[data-event-remove]')!.click();
  assert.equal(read().events?.length??0,0);
});
test('initial empty options does not leave a stale parse error after the existing form populates',()=>{
  const {document}=parseHTML('<main></main>');let ready=false;
  const editor=mountEventEditor(document.querySelector('main')!,()=>{if(!ready)throw new Error('empty');return operatingExample('normal').options;},()=>{});
  ready=true;editor.sync();
  assert.equal(document.querySelector('[data-event-status]')!.textContent,'');
});
