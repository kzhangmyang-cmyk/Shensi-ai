import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
test('XHS view escapes recipients and never offers resend for unknown or confirmed records',async()=>{
  const path='./xiaohongshu';const {renderXhs}=await import(path);
  const state={accounts:[],drafts:[{id:'one',accountId:'account',recipientId:'<script>bad</script>',body:'<img onerror="bad">',
    revision:2,status:'unknown',deviceId:'device',updatedAt:1}],busy:false,error:null,loginAccountId:null};
  const {document}=parseHTML(renderXhs(state));
  assert.equal(document.querySelector('script'),null);
  assert.equal(document.querySelector('img'),null);
  assert.match(document.querySelector('.xhs-workspace')?.textContent||'',/结果未知/);
  assert.equal(document.querySelector('[data-xhs-send]'),null);
  state.drafts[0].status='approved';
  const approved=parseHTML(renderXhs(state)).document;
  assert.ok(approved.querySelector('[data-xhs-send]'));
  assert.ok(approved.querySelector('[data-xhs-edit]'));
});
