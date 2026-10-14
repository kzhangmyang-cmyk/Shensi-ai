import assert from 'node:assert/strict';
import test from 'node:test';

test('desktop send claims immutable backend command, never renderer body; disabled mode does not claim', async()=>{
  const modulePath='../src/main/xiaohongshu-service.ts';
  const {XhsDesktopService}=await import(modulePath);
  const writes:unknown[]=[];let claims=0;
  const scope={workspaceId:'workspace',actorId:'actor',deviceId:'device'};
  const command={commandId:'00000000-0000-4000-8000-000000000001',accountId:'00000000-0000-4000-8000-000000000002',
    ...scope,recipientId:'recipient',body:'approved text',revision:2,clientMessageId:'00000000-0000-4000-8000-000000000003',
    generation:'00000000-0000-4000-8000-000000000004',expiresAt:Date.now()+60000};
  const authority={authorize:async()=>scope,accounts:async()=>[],bind:async()=>{},
    claim:async()=>{claims++;return command;},receipt:async(_scope:unknown,_id:unknown,value:unknown)=>{writes.push(value);return value;}};
  const sent:unknown[]=[];
  const factory=()=>({ready:Promise.resolve(),request:async(value:unknown)=>{sent.push(value);return {status:'confirmed',serverMessageId:'server'};},close:async()=>{}});
  const disabled=new XhsDesktopService(authority,factory);
  await assert.rejects(disabled.send('workspace',command.commandId,1),/xhs_sending_disabled/);
  assert.equal(claims,0);
  const service=new XhsDesktopService(authority,factory,true);
  await service.send('workspace',command.commandId,1);
  assert.deepEqual(sent,[{operation:'execute',command}]);
  assert.deepEqual(writes,[{clientMessageId:command.clientMessageId,generation:command.generation,receipt:{status:'confirmed',serverMessageId:'server'}}]);
  await service.dispose();
});

test('changed user after claim cancels before transmission and records unknown only for original scope',async()=>{
  const modulePath='../src/main/xiaohongshu-service.ts';const {XhsDesktopService}=await import(modulePath);
  let actor='first';let writes=0;let sends=0;
  const authority={authorize:async()=>({workspaceId:'workspace',actorId:actor,deviceId:'device'}),accounts:async()=>[],bind:async()=>{},
    claim:async()=>{actor='second';return {commandId:'id',workspaceId:'workspace',actorId:'first',deviceId:'device'};},
    receipt:async()=>{writes++;}};
  const service=new XhsDesktopService(authority,()=>({ready:Promise.resolve(),request:async()=>{sends++;},close:async()=>{}}),true);
  await assert.rejects(service.send('workspace','00000000-0000-4000-8000-000000000001',1),/xhs_scope_changed/);
  assert.equal(sends,0);assert.equal(writes,0);
  await service.dispose();
});
