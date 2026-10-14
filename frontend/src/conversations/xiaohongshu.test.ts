import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {xhsErrorMessage} from './xiaohongshu';
test('native IPC failures explain disabled sending and missing login without disguising another error',()=>{
  for(const prefix of ['',"Error invoking remote method 'shensi:xiaohongshu': Error: "]){
    assert.match(xhsErrorMessage(new Error(prefix+'xhs_sending_disabled')),/尚未启用小红书发送/);
    assert.match(xhsErrorMessage(new Error(prefix+'xhs_login_not_open')),/先打开登录浏览器/);
  }
  assert.equal(xhsErrorMessage(new Error('请先保存修改，再批准新内容。')),'请先保存修改，再批准新内容。');
  assert.equal(xhsErrorMessage(new Error('xhs_scope_changed')),'xhs_scope_changed');
});
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
