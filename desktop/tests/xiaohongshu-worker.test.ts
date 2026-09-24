import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('private worker correlates requests and fails pending work on process exit', async () => {
  const modulePath = '../src/main/xiaohongshu-worker.ts';
  const { createXhsWorker } = await import(modulePath);
  const root = await mkdtemp(path.join(tmpdir(), 'xhs-worker-test-'));
  try {
    const script = path.join(root,'worker.cjs');
    await writeFile(script, `process.stdout.write('{"event":"ready"}\\n');
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const request=JSON.parse(line);
        if(request.operation==='close')process.exit(1);
        process.stdout.write(JSON.stringify({id:request.id,result:{accountId:request.accountId,state:'login_open'}})+'\\n');
      });`);
    const worker = createXhsWorker({ executable:process.execPath, args:[script], cwd:root });
    try {
      await worker.ready;
      assert.deepEqual(await worker.request({operation:'open',accountId:'00000000-0000-4000-8000-000000000002'}),
        {accountId:'00000000-0000-4000-8000-000000000002',state:'login_open'});
      await assert.rejects(worker.request({operation:'close',accountId:'00000000-0000-4000-8000-000000000002'}), /xhs_worker_disconnected/);
    } finally { await worker.close(); }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('worker rejects malformed output and does not expose stderr secrets', async()=>{
  const modulePath='../src/main/xiaohongshu-worker.ts';
  const {createXhsWorker}=await import(modulePath);
  const worker=createXhsWorker({executable:process.execPath,args:['-e',`console.error('secret-cookie');console.log('not-json')`],cwd:tmpdir()});
  try {await assert.rejects(worker.ready,/xhs_worker_protocol_failed/);}
  finally {await worker.close();}
});
