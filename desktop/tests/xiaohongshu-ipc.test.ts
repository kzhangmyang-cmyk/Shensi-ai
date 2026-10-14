import assert from 'node:assert/strict';
import test from 'node:test';

test('XHS IPC rejects subframes and renderer-supplied commands before service access',async()=>{
  const modulePath='../src/main/xiaohongshu-ipc.ts';
  const {registerXhsIpc}=await import(modulePath);
  let handler:Function=()=>{};let calls=0;
  const sender={mainFrame:{url:'http://127.0.0.1:1234/#conversations'},isDestroyed:()=>false};
  const service={open:async()=>{calls++;return {state:'login_open'};},connect:async()=>{},close:async()=>{},send:async()=>{},dispose:async()=>{}};
  const ipc=registerXhsIpc({localOrigin:'http://127.0.0.1:1234',authorizedSender:()=>sender,service,
    ipcMain:{handle:(_name:string,callback:Function)=>{handler=callback;},removeHandler:()=>{}}});
  const value={action:'open',workspaceId:'workspace',accountId:'00000000-0000-4000-8000-000000000001'};
  const event={sender,senderFrame:sender.mainFrame};
  await assert.rejects(handler({...event,senderFrame:{url:sender.mainFrame.url}},value),/xhs_sender_invalid/);
  await assert.rejects(handler(event,{...value,command:{body:'injected'}}),/xhs_input_invalid/);
  await handler(event,value);assert.equal(calls,1);
  await ipc.dispose();
});
