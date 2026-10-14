import assert from 'node:assert/strict';
import test from 'node:test';
import type {Pool} from 'mysql2/promise';
import {randomUUID} from 'node:crypto';
import {createReferenceCrypto} from './crypto.js';
import {activeReferenceSchema} from './repository.js';
import {ReferenceAccessError} from './authority.js';
test('publication transaction holds corpus lock, rechecks authority before commit, and never replays unknown commit',async()=>{
  const m=await import('./mysql-repository.js').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.ok(m,'publication MySQL repository required');
  const calls:string[]=[],crypto=createReferenceCrypto('synthetic-reference-storage-key-'.repeat(2)),corpus=randomUUID();
  const payload=crypto.seal({corpusId:corpus,kind:'release',key:['active']},{id:null,revision:0});let uncertain=false;
  const driver={beginTransaction:async()=>{calls.push('begin');},execute:async(sql:string)=>{calls.push(sql);return [sql.startsWith('SELECT')?[{payload}]:{affectedRows:1},[]];},
    commit:async()=>{calls.push('commit');if(uncertain)throw Error('synthetic uncertain');},rollback:async()=>{calls.push('rollback');},release:()=>calls.push('release'),destroy:()=>calls.push('destroy')};
  const pool={getConnection:async()=>driver,execute:driver.execute} as unknown as Pool;
  await m.initializeReferenceSchema(pool);assert.equal(calls.filter(x=>x.startsWith('CREATE TABLE')).length,7);calls.length=0;
  const repo=new m.MysqlReferenceRepository(pool,crypto),authorize=async()=>{calls.push('authorize');};
  const value=await repo.transaction(corpus,authorize,tx=>tx.get('release',['active'],activeReferenceSchema));assert.deepEqual(value,{id:null,revision:0});
  assert.ok(calls.findIndex(x=>x==='authorize')<calls.findIndex(x=>x.includes('FOR UPDATE')));assert.deepEqual(calls.slice(-3),['authorize','commit','release']);
  calls.length=0;uncertain=true;await assert.rejects(repo.transaction(corpus,authorize,async()=>1),/reference_persistence_unconfirmed/);
  assert.equal(calls.filter(x=>x==='commit').length,1);assert.equal(calls.at(-1),'destroy');
});
test('an unconfirmed rollback is reported as persistence unknown, destroys the connection and never retries',async()=>{
  const {MysqlReferenceRepository}=await import('./mysql-repository.js');const calls:string[]=[];
  const driver={beginTransaction:async()=>{calls.push('begin');},rollback:async()=>{calls.push('rollback');throw Error('lost transport');},
    release:()=>calls.push('release'),destroy:()=>calls.push('destroy')};
  const repo=new MysqlReferenceRepository({getConnection:async()=>driver} as unknown as Pool,createReferenceCrypto('synthetic-reference-storage-key-'.repeat(2)));
  await assert.rejects(repo.transaction(randomUUID(),async()=>{throw new ReferenceAccessError(403,'reference_owner_required');},async()=>1),
    (error:unknown)=>error instanceof ReferenceAccessError&&error.status===503&&error.code==='reference_persistence_unconfirmed');
  assert.deepEqual(calls,['begin','rollback','destroy']);
});
