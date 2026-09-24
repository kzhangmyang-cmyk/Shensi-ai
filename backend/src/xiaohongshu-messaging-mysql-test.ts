import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type mysql from 'mysql2/promise';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';
import { capabilitiesForHumanRole } from './growth-capabilities.js';
const context:ActiveWorkspaceContext = {workspaceId:'workspace',actorId:'actor',teamId:'team',kind:'personal',role:'admin',capabilities:capabilitiesForHumanRole('admin'),capabilityRegistryVersion:'growth-capabilities.v1'};
const state = {revision:1,drafts:[{id:'00000000-0000-4000-8000-000000000001',accountId:'account',deviceId:'device',recipientId:'recipient',body:'synthetic private text',revision:1,status:'draft' as const,updatedAt:100}]};
async function module() {
  assert.ok(existsSync(new URL('./xiaohongshu-messaging-mysql.ts',import.meta.url)), 'persistent scoped messaging repository exists');
  return import('./xiaohongshu-messaging-mysql.js');
}
test('XHS MySQL stores encrypted content and binds every query to owner scope',async()=>{
  const { MysqlXhsMessagingRepository } = await module();
  const calls:Array<{sql:string;values:unknown[]}> = [];
  let encrypted='';
  const pool = {async execute(sql:string,values:unknown[]) {
    calls.push({sql,values});
    if (sql.startsWith('INSERT')) { encrypted=String(values[3]); return [{affectedRows:1},[]]; }
    return [[{revision:1,payload_encrypted:encrypted}],[]];
  }} as unknown as Pick<mysql.Pool,'execute'>;
  const repository=new MysqlXhsMessagingRepository(pool);
  await repository.save(context,state,0);
  assert.ok(encrypted.startsWith('v1.'));
  assert.equal(encrypted.includes('synthetic'),false);
  assert.deepEqual(await repository.read(context),state);
  assert.deepEqual(calls[0]?.values.slice(0,3),['workspace','actor',1]);
  assert.deepEqual(calls[1]?.values,['workspace','actor']);
  await assert.rejects(repository.read({...context,actorId:'other'})); // Same ciphertext cannot decrypt under a new owner.
});
test('XHS MySQL stale compare-and-swap refuses overwrite',async()=>{
  const { MysqlXhsMessagingRepository } = await module();
  let values:unknown[]=[];
  const pool = {async execute(_sql:string,input:unknown[]) {values=input;return [{affectedRows:0},[]];}} as unknown as Pick<mysql.Pool,'execute'>;
  await assert.rejects(new MysqlXhsMessagingRepository(pool).save(context,{...state,revision:2},1),/revision_conflict/);
  assert.deepEqual(values.slice(2),['workspace','actor',1]);
});
test('XHS MySQL concurrent first insert reports conflict and empty owner reads start at zero',async()=>{
  const { MysqlXhsMessagingRepository } = await module();
  const pool = {async execute(sql:string) {
    if(sql.startsWith('INSERT')) throw Object.assign(new Error('duplicate'),{code:'ER_DUP_ENTRY'});
    return [[],[]];
  }} as unknown as Pick<mysql.Pool,'execute'>;
  const repository=new MysqlXhsMessagingRepository(pool);
  assert.deepEqual(await repository.read(context),{revision:0,drafts:[]});
  await assert.rejects(repository.save(context,state,0),/revision_conflict/);
});
