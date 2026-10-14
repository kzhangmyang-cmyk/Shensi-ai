import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {enterpriseQueryPage} from '../../../desktop/src/main/enterprise-query-page';

// Hand-built DOM follows the site's public advanced-search controls, not its private application state.
test('applies only selected city and industry checkbox, verifies them before submitting', async()=>{
  const {document,window}=parseHTML(`<html><body>
    <button data-log-an="advancesearch-reset">重置</button><div class="search-key"><input></div>
    <div class="province-trigger">请选择省份地区</div><span class="province-trigger-tag-text"></span>
    <div class="province-modal-dialog" hidden><div class="col"><div class="col-item"><span class="col-item-text">河南省</span></div></div><div class="col"><div class="col-item"><span class="col-item-text">郑州市</span></div></div><span class="footer-tag"></span><div class="reset-btn">重置</div><div class="confirm-btn">确定</div></div>
    <div class="select-trigger-wrapper">请选择所属行业</div><div class="select-multi" hidden><ul><li><div class="tree-select-wrap"><input type="checkbox"><div class="title">制造业</div></div></li></ul><ul><li><div class="tree-select-wrap"><input type="checkbox"><div class="title">橡胶和塑料制品业</div></div></li><li><div class="tree-select-wrap"><input type="checkbox"><div class="title">食品制造业</div></div></li></ul><button data-log-an="advancesearch-industryCode1-reset">重置选项</button><button data-log-an="advancesearch-industryCode1-submit">确定</button></div>
    <button data-log-an="advancesearch-show-list">查看结果</button>
  </body></html>`);
  const previous={document:globalThis.document,window:globalThis.window,location:globalThis.location,getComputedStyle:globalThis.getComputedStyle,Event:globalThis.Event};
  Object.assign(globalThis,{document,window,location:{origin:'https://aiqicha.baidu.com',pathname:'/advancesearch'},getComputedStyle:()=>({visibility:'visible'}),Event:window.Event});
  window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}] as any;};
  const region=document.querySelector('.province-modal-dialog')!; const industry=document.querySelector('.select-multi')!;
  document.querySelector('.province-trigger')!.addEventListener('click',()=>region.removeAttribute('hidden'));
  region.querySelectorAll('.col-item')[0].addEventListener('click',()=>{region.querySelector('.footer-tag')!.textContent='河南省';});
  region.querySelector('.reset-btn')!.addEventListener('click',()=>{region.querySelector('.footer-tag')!.textContent='';});
  region.querySelectorAll('.col-item')[1].addEventListener('click',()=>{region.querySelector('.footer-tag')!.textContent=region.querySelector('.footer-tag')!.textContent?'河南省-开封市':'河南省-郑州市';});
  region.querySelector('.confirm-btn')!.addEventListener('click',()=>{document.querySelector('.province-trigger-tag-text')!.textContent=region.querySelector('.footer-tag')!.textContent;region.setAttribute('hidden','');});
  document.querySelector('.select-trigger-wrapper')!.addEventListener('click',()=>industry.removeAttribute('hidden'));
  for(const checkbox of industry.querySelectorAll('input')) checkbox.addEventListener('click',()=>{checkbox.checked=!checkbox.checked;});
  industry.querySelector('[data-log-an$="-reset"]')!.addEventListener('click',()=>{for(const c of industry.querySelectorAll('input')) c.checked=false;});
  industry.querySelector('[data-log-an$="-submit"]')!.addEventListener('click',()=>industry.setAttribute('hidden',''));
  let submitted=0; document.querySelector('[data-log-an="advancesearch-show-list"]')!.addEventListener('click',()=>submitted++);
  try {
    const query={keyword:'',region:['河南省','郑州市'],industry:['制造业','橡胶和塑料制品业']};
    const result=await enterpriseQueryPage(query,'prepare');
    assert.equal(result.status,'ready'); assert.equal(submitted,0);
    assert.equal(document.querySelector('.province-trigger-tag-text')!.textContent,'河南省-郑州市');
    assert.equal(industry.querySelectorAll('input')[1].checked,true); assert.equal(!!industry.querySelectorAll('input')[2].checked,false);
    await enterpriseQueryPage(query,'submit'); assert.equal(submitted,1);
    document.body.insertAdjacentHTML('beforeend','<section>开通超级会员 解锁高级搜索</section><article class="items"><h3>旧结果不能充成功</h3></article>');
    assert.equal((await enterpriseQueryPage(query,'result')).status,'blocked');
  } finally {Object.assign(globalThis,previous);}
});
