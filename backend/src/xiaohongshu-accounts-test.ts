import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { MemoryXhsMessagingRepository, XiaohongshuMessagingService } from './xiaohongshu-messaging.js';
import { capabilitiesForHumanRole } from './growth-capabilities.js';
const context={workspaceId:'workspace',actorId:'actor',teamId:'team',kind:'personal' as const,role:'admin' as const,
  capabilities:capabilitiesForHumanRole('admin'),capabilityRegistryVersion:'growth-capabilities.v1'};
const account={accountId:'00000000-0000-4000-8000-000000000001',platformUserId:'platform-user',displayName:'Synthetic account',generation:'00000000-0000-4000-8000-000000000002',state:'ready' as const,revision:0};
async function setup() {
  assert.ok(existsSync(new URL('./xiaohongshu-accounts.ts',import.meta.url)),'scoped account binding service exists');
  const {XhsAccountService}=await import('./xiaohongshu-accounts.js');
  const repository=new MemoryXhsMessagingRepository();
  const accounts=new XhsAccountService(repository);
  const messaging=new XiaohongshuMessagingService(repository,{enabled:true,account:(scope,id,device)=>accounts.resolve(scope,id,device)});
  return {accounts,messaging};
}
test('XHS only current owner device and ready account resolve for approval',async()=>{
  const {accounts}=await setup();
  await accounts.bind(context,'device',account);
  assert.deepEqual(await accounts.resolve(context,account.accountId,'device'),{accountId:account.accountId,deviceId:'device',generation:account.generation,active:true});
  assert.equal(await accounts.resolve({...context,actorId:'other'},account.accountId,'device'),null);
  assert.equal(await accounts.resolve(context,account.accountId,'other'),null);
  await accounts.bind(context,'device',{...account,revision:1,state:'expired'});
  assert.equal(await accounts.resolve(context,account.accountId,'device'),null);
});
test('XHS account binding rejects stale revision and duplicate platform alias',async()=>{
  const {accounts}=await setup();
  await accounts.bind(context,'device',account);
  await assert.rejects(accounts.bind(context,'device',{...account,state:'expired'}),/revision_conflict/);
  await assert.rejects(accounts.bind(context,'device',{...account,accountId:'00000000-0000-4000-8000-000000000003'}),/account_exists/);
  assert.equal((await accounts.list(context)).length,1);
});
test('XHS rebound account invalidates approved generation before issuing command',async()=>{
  const {accounts,messaging}=await setup();
  await accounts.bind(context,'device',account);
  const draft={id:'00000000-0000-4000-8000-000000000003',accountId:account.accountId,deviceId:'device',recipientId:'recipient',body:'synthetic'};
  await messaging.create(context,draft);
  await messaging.approve(context,draft.id,1);
  await accounts.bind(context,'device',{...account,revision:1,generation:'00000000-0000-4000-8000-000000000004'});
  await assert.rejects(messaging.claim(context,'device',draft.id,2),/account_changed/);
});
test('XHS account cannot silently change platform identity under an existing ID',async()=>{
  const {accounts}=await setup();
  await accounts.bind(context,'device',account);
  await assert.rejects(accounts.bind(context,'device',{...account,revision:1,platformUserId:'other'}),/account_identity_changed/);
});
