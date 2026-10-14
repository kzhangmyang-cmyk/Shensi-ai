import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountEnterpriseFilters } from './filters';

test('condition chips clear only the chosen condition and keep picker labels in sync',()=>{
  const {document,window}=parseHTML('<form><input name="keyword"><div data-enterprise-filters></div><select name="size"><option value="">全部规模</option></select></form>');
  const form=document.querySelector('form')!;let changed=0;
  mountEnterpriseFilters(form as unknown as HTMLFormElement,()=>changed++);
  const keyword=form.querySelector<HTMLInputElement>('[name=keyword]')!;keyword.value='塑料';keyword.dispatchEvent(new window.Event('input',{bubbles:true}));
  const search=form.querySelector<HTMLInputElement>('[data-industry-search]')!;search.value='2921';search.dispatchEvent(new window.Event('input'));
  form.querySelector('[data-industry-code="2921"]')!.dispatchEvent(new window.Event('click',{bubbles:true}));
  assert.ok(form.querySelector('[data-condition-clear="industry"]'));
  form.querySelector('[data-condition-clear="industry"]')!.dispatchEvent(new window.Event('click',{bubbles:true}));
  assert.equal(form.querySelector<HTMLInputElement>('[name=industry]')!.value,'');
  assert.equal(form.querySelector('[data-industry-label]')!.textContent,'全部行业');
  assert.equal(keyword.value,'塑料');assert.ok(changed>0);
  const keywordChip=form.querySelector('[data-condition-clear="keyword"]')!;
  keyword.dispatchEvent(new window.Event('change',{bubbles:true}));
  // A blur-triggered change must not detach the button between pointer down and click.
  assert.equal(keywordChip.isConnected,true);
  keywordChip.dispatchEvent(new window.Event('click',{bubbles:true}));
  assert.equal(keyword.value,'');assert.equal(form.querySelector('[data-condition-chips]')!.hasAttribute('hidden'),true);
});

test('region options and four-level selection clear descendants, search and reset', () => {
  const { document, window } = parseHTML('<form><div data-enterprise-filters></div></form>');
  let changes = 0;
  const form = document.querySelector('form')!;
  const filters = mountEnterpriseFilters(form as unknown as HTMLFormElement, () => changes++);
  const choose = (selector: string, value: string) => {
    const control = form.querySelector(selector)!;
    if (control.tagName === 'SELECT') {
      control.querySelectorAll('option').forEach(o => o.removeAttribute('selected'));
      control.querySelector(`option[value="${value}"]`)!.setAttribute('selected','');
    }
    else (control as HTMLInputElement).value = value;
    control.dispatchEvent(new window.Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles:true }));
  };
  const value = () => form.querySelector<HTMLInputElement>('[name=industry]')!.value;
  assert.equal(form.querySelectorAll('[data-region-province] option').length,35);
  choose('[data-industry-level="0"]','C'); choose('[data-industry-level="1"]','29'); choose('[data-industry-level="2"]','292'); choose('[data-industry-level="3"]','2921');
  assert.equal(value(),'2921');
  assert.match(form.querySelector('[data-industry-path]')!.textContent!,/制造业.*橡胶和塑料制品业.*塑料制品业.*塑料薄膜制造/);
  choose('[data-industry-level="0"]','A');
  assert.equal(value(),'A');
  assert.equal(form.querySelector('[data-industry-level="3"]')!.hasAttribute('disabled'),true);
  choose('[data-industry-search]','2921');
  form.querySelector('[data-industry-code="2921"]')!.dispatchEvent(new window.Event('click',{bubbles:true}));
  assert.equal(value(),'2921');
  filters.reset(); assert.equal(value(),'');
  filters.setRemote(true); assert.equal(form.querySelector('[data-enterprise-filters]')!.hasAttribute('hidden'),true);
  filters.setRemote(false); assert.equal(form.querySelector('[data-enterprise-filters]')!.hasAttribute('hidden'),false);
  assert.ok(changes >= 6);
});
