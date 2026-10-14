import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {enterprisePaginationPage} from '../../../desktop/src/main/enterprise-pagination-page';
import {mergeEnterpriseCards} from '../../../desktop/src/shared/enterprise-browser';

test('next page clicks the visible pager once and refuses a changed page',()=>{
  const {window,document}=parseHTML('<body><input value="塑料"><div class="items"><h3>企业甲</h3></div><ul><li class="page-active">1</li><li title="下一页">›</li></ul></body>');
  const previous={document:globalThis.document,location:globalThis.location,getComputedStyle:globalThis.getComputedStyle};
  Object.assign(globalThis,{document,location:{origin:'https://aiqicha.baidu.com',pathname:'/s',search:'?q=塑料'},getComputedStyle:()=>({visibility:'visible'})});
  Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{}]});Object.defineProperty(window.HTMLElement.prototype,'innerText',{get(){return this.textContent;},configurable:true});
  let clicks=0;document.querySelector('[title="下一页"]')!.addEventListener('click',()=>clicks++);
  try{
    const state=enterprisePaginationPage('inspect');assert.equal(state.page,1);assert.equal(state.hasNext,true);
    assert.equal(enterprisePaginationPage('next',1).status,'clicked');assert.equal(clicks,1);
    document.querySelector('.page-active')!.textContent='2';
    assert.equal(enterprisePaginationPage('next',1).status,'changed');assert.equal(clicks,1);
  }finally{Object.assign(globalThis,previous);}
});
test('append deduplicates stable IDs or fallback names without collapsing shared search URLs',()=>{
  const items=mergeEnterpriseCards([{company:'企业甲',sourceUrl:'https://aiqicha.baidu.com/s'}],[{company:'企业甲',sourceUrl:'https://aiqicha.baidu.com/s'},{company:'企业乙',sourceUrl:'https://aiqicha.baidu.com/s'}]);
  assert.deepEqual(items.map(x=>x.company),['企业甲','企业乙']);
  assert.equal(mergeEnterpriseCards([{company:'旧名',sourceUrl:'https://aiqicha.baidu.com/company_detail_123'}],[{company:'新名',sourceUrl:'https://aiqicha.baidu.com/company_detail_123'}]).length,1);
});
