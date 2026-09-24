import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { MemoryXhsMessagingRepository, XiaohongshuMessagingService } from './xiaohongshu-messaging.js';
import { capabilitiesForHumanRole } from './growth-capabilities.js';
import { desktopInstallationIdHash } from './acquisition-desktop-installation.js';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

test('XHS HTTP uses authenticated user scope plus registered device before issuing one exact command',async()=>{
  assert.ok(existsSync(new URL('./xiaohongshu-messaging-router.ts',import.meta.url)), 'independent HTTP boundary exists');
  const { createXhsMessagingRouter }=await import('./xiaohongshu-messaging-router.js');
  const installationId='i'.repeat(43), token='t'.repeat(43), deviceId=desktopInstallationIdHash(installationId);
  const contract=YAML.parse(readFileSync(new URL('../../contracts/openapi/xiaohongshu-messaging.v1.yaml',import.meta.url),'utf8'));
  const ajv=new Ajv2020({strict:false}); addFormats(ajv);
  const conforms=(schema:string,value:unknown)=>{
    const validate=ajv.compile({components:contract.components,$ref:`#/components/schemas/${schema}`});
    assert.equal(validate(value),true,JSON.stringify(validate.errors));
  };
  let wrongDeviceScope=false;
  const context={workspaceId:'workspace',actorId:'actor',teamId:'team',kind:'personal' as const,role:'admin' as const,
    capabilities:capabilitiesForHumanRole('admin'),capabilityRegistryVersion:'growth-capabilities.v1'};
  const service=new XiaohongshuMessagingService(new MemoryXhsMessagingRepository(),{enabled:true,account:async()=>({accountId:'account',deviceId,generation:'generation',active:true})});
  const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{
    if(req.header('X-Test-User')==='yes') {req.user={id:'actor',teamId:'team'} as never;req.activeWorkspace=context;}
    next();
  });
  app.use('/api/v1/acquisition/xiaohongshu',createXhsMessagingRouter({service,installationService:{authenticateDevice:async input=>
    input.installationId===installationId && input.deviceToken===token
      ? {workspaceId:wrongDeviceScope?'other':'workspace',userId:'actor',teamId:'team',deviceIdHash:deviceId,protocolVersion:1} : null}}));
  const server=app.listen(0,'127.0.0.1'); await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/acquisition/xiaohongshu`;
  const headers={'Content-Type':'application/json','X-Test-User':'yes'};
  const send=(path:string,body:unknown,extra:Record<string,string>={})=>fetch(base+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  try {
    assert.equal((await fetch(base+'/drafts')).status,401);
    const draft={id:'00000000-0000-4000-8000-000000000001',accountId:'account',deviceId,recipientId:'recipient',body:'synthetic text'};
    assert.equal((await send('/drafts',{...draft,actorId:'forged'})).status,422);
    const create=await send('/drafts',draft); assert.equal(create.status,201); assert.equal(create.headers.get('cache-control'),'no-store');
    conforms('XhsDraft',await create.json());
    const approve=await send(`/drafts/${draft.id}/approve`,{revision:1});assert.equal(approve.status,200);
    const path=`/drafts/${draft.id}/claim`;
    assert.equal((await send(path,{revision:2})).status,401);
    const device={'X-Shensi-Desktop-Installation-Id':installationId,'X-Shensi-Desktop-Device-Token':token};
    wrongDeviceScope=true;
    assert.equal((await send(path,{revision:2},device)).status,403);
    wrongDeviceScope=false;
    assert.equal((await send(path,{revision:2},{...device,'X-Shensi-Desktop-Device-Token':token+','+token})).status,401);
    assert.equal((await send(path,{revision:2,body:'replacement'},device)).status,422);
    const result=await send(path,{revision:2},device);assert.equal(result.status,200);
    const command=await result.json();assert.equal(command.body,'synthetic text');assert.equal(command.deviceId,deviceId);
    conforms('XhsCommand',command);
    assert.equal(JSON.stringify(command).includes(token),false);
    assert.equal((await send(path,{revision:2},device)).status,409);
    const done=await send(`/drafts/${draft.id}/receipt`,{clientMessageId:command.clientMessageId,generation:'generation',receipt:{status:'confirmed',serverMessageId:'server'}},device);
    assert.equal(done.status,200);
    conforms('XhsDraft',await done.json());
    const list=await fetch(base+'/drafts',{headers});const items=await list.json();assert.equal(items.items[0].status,'confirmed');
    conforms('XhsDraftList',items);
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
