import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
test('connection store creates only additive table, locks actor state and destroys uncertain commit without retry',async()=>{
  const mod=await import('./mysql-connections.js').catch(()=>null);assert.ok(mod,'durable connection adapter required');
  let payload=JSON.stringify({backendInstanceId:'installation',actorId:'actor',generation:0,connections:[],tombstones:[]});
  let fail=false;const calls:string[]=[];
  const driver={beginTransaction:async()=>{calls.push('begin');},execute:async(sql:string,values?:unknown[])=>{
    calls.push(sql);if(sql.startsWith('UPDATE'))payload=String(values?.[0]);return [sql.startsWith('SELECT')?[{payload}]:{affectedRows:1},[]];},
    commit:async()=>{calls.push('commit');if(fail)throw Error('private');},rollback:async()=>{calls.push('rollback');},release:()=>calls.push('release'),destroy:()=>calls.push('destroy')};
  const pool={getConnection:async()=>driver,execute:driver.execute} as unknown as Pool;
  await mod.initializeReferenceConnections(pool);assert.match(calls[0]!,/^CREATE TABLE IF NOT EXISTS system_reference_connections/u);
  calls.length=0;const store=new mod.MysqlConnectionStore(pool);
  assert.equal(await store.transaction('installation','actor',async(row)=>{row.generation++;return row.generation;}),1);
  assert.ok(calls.some(sql=>sql.endsWith('FOR UPDATE')));assert.equal(JSON.parse(payload).generation,1);
  assert.deepEqual(calls.slice(-2),['commit','release']);calls.length=0;fail=true;
  await assert.rejects(store.transaction('installation','actor',async row=>{row.generation++;}),/reference_persistence_unconfirmed/u);
  assert.equal(calls.filter(x=>x==='commit').length,1);assert.equal(calls.at(-1),'destroy');
});
