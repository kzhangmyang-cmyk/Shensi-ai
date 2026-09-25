import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import { createXhsApplication } from '../src/xiaohongshu-application.js';
import { MysqlXhsMessagingRepository } from '../src/xiaohongshu-messaging-mysql.js';
import { XiaohongshuMessagingService } from '../src/xiaohongshu-messaging.js';
import { XhsAccountService } from '../src/xiaohongshu-accounts.js';
import { capabilitiesForHumanRole } from '../src/growth-capabilities.js';
import type { ActiveWorkspaceContext } from '../src/growth-workspace-context.js';

// No connection URL argument: the only database reachable by this runner is its
// newly created loopback-only container. Nothing mounts a business database.
const exec=promisify(execFile);
const nonce=randomBytes(8).toString('hex');
const name=`shensi-xhs-acceptance-${nonce}`, volume=`${name}-data`;
const label=`shensi.acceptance=${nonce}`;
const image='sha256:ea68e51ffe9b96fef6076f1218af11301aeaf13c6201e0ec9aaef5791d5ddc5d';
// Colima shares the user's home, not macOS /private/var/folders temporary paths.
const directory=await realpath(await mkdtemp(join(homedir(),'.shensi-xhs-mysql-')));
const password=randomBytes(32).toString('hex');
const oldKey=process.env.AGENT_JOB_ENCRYPTION_KEY;
process.env.AGENT_JOB_ENCRYPTION_KEY=randomBytes(48).toString('base64url');
let phase='prepare', containerCreated=false, volumeCreated=false, pool:mysql.Pool|undefined;
const docker=async(args:string[],timeout=30000)=>(await exec('docker',args,{timeout,maxBuffer:4*1024*1024})).stdout.trim();
const passed=(value:string)=>console.log(`PASS ${value}`);
try {
  await writeFile(join(directory,'password'),password,{mode:0o600});
  await writeFile(join(directory,'client.cnf'),`[client]\nuser=root\npassword=${password}\n`,{mode:0o600});
  phase='cached-image';
  await docker(['image','inspect',image]); // cached official image only; never pull
  phase='create-volume';
  await docker(['volume','create','--label',label,volume]); volumeCreated=true;
  phase='create-container';
  await docker(['run','--detach','--pull=never','--name',name,'--label',label,
    '--publish','127.0.0.1::3306','--mount',`type=volume,source=${volume},target=/var/lib/mysql`,
    '--mount',`type=bind,source=${directory},target=/run/shensi-test-secrets,readonly`,
    '--env','MYSQL_ROOT_PASSWORD_FILE=/run/shensi-test-secrets/password','--env','MYSQL_DATABASE=shensi_synthetic',image]);
  containerCreated=true;
  const endpoint=await docker(['port',name,'3306/tcp']);
  assert.match(endpoint,/^127\.0\.0\.1:\d+$/);
  let port=Number(endpoint.split(':')[1]);
  const connect=()=>mysql.createPool({host:'127.0.0.1',port,user:'root',password,database:'shensi_synthetic',connectionLimit:4,connectTimeout:2000});
  async function ready() {
    const currentEndpoint=await docker(['port',name,'3306/tcp']);
    assert.match(currentEndpoint,/^127\.0\.0\.1:\d+$/);
    const currentPort=Number(currentEndpoint.split(':')[1]);
    if(currentPort!==port)console.log('INFO isolated Docker dynamic port changed on restart');
    port=currentPort;
    pool=connect(); const deadline=Date.now()+90000;
    let lastCode='unknown';
    while(Date.now()<deadline) {try{await pool.query('SELECT 1');return;}catch(error){
      lastCode=typeof error==='object' && error && 'code' in error ? String(error.code).replace(/[^A-Z0-9_-]/gi,'').slice(0,60) : 'unknown';
      await delay(500);
    }}
    console.error(`isolated_mysql_ready_timeout code=${lastCode}`);
    throw Error('isolated_mysql_start_timeout');
  }
  phase='startup'; await ready();
  await pool!.query('CREATE TABLE synthetic_legacy_marker (id INT PRIMARY KEY, value VARCHAR(80))');
  await pool!.execute('INSERT INTO synthetic_legacy_marker VALUES (1, ?)', ['preserve-synthetic-record']);
  const installationService={authenticateDevice:async()=>{throw Error('no real device in storage acceptance');}};
  phase='schema';
  await createXhsApplication({pool:pool!,installationService,moduleEnabled:false});
  const [disabled]=await pool!.query<mysql.RowDataPacket[]>("SHOW TABLES LIKE 'xiaohongshu_messaging'");
  assert.equal(disabled.length,0);
  await createXhsApplication({pool:pool!,installationService,moduleEnabled:true});
  await createXhsApplication({pool:pool!,installationService,moduleEnabled:true});
  passed('module-off-no-DDL / real schema idempotency');
  const context:ActiveWorkspaceContext={workspaceId:'synthetic-workspace',actorId:'synthetic-owner',teamId:'synthetic-team',kind:'personal',role:'admin',
    capabilities:capabilitiesForHumanRole('admin'),capabilityRegistryVersion:'growth-capabilities.v1'};
  let repository=new MysqlXhsMessagingRepository(pool!);
  const accounts=new XhsAccountService(repository);
  const accountId=randomUUID(), generation=randomUUID(), id=randomUUID();
  phase='business-storage';
  await accounts.bind(context,'synthetic-device',{accountId,platformUserId:'synthetic-platform-user',displayName:'Synthetic',generation,state:'ready',revision:0});
  const service=new XiaohongshuMessagingService(repository,{enabled:true,dailyLimit:20,account:(scope,account,device)=>accounts.resolve(scope,account,device)});
  await service.create(context,{id,accountId,deviceId:'synthetic-device',recipientId:'synthetic-recipient',body:'synthetic-private-message'});
  await service.approve(context,id,1);
  const command=await service.claim(context,'synthetic-device',id,2);
  await service.receipt(context,'synthetic-device',id,command.clientMessageId,generation,{status:'unknown'});
  assert.equal((await service.list(context))[0].status,'unknown');
  await assert.rejects(service.approve(context,id,4),/not_editable/);
  const expected=await repository.read(context);
  const [rows]=await pool!.query<mysql.RowDataPacket[]>('SELECT payload_encrypted FROM xiaohongshu_messaging');
  assert.equal(rows.length,1); assert.match(rows[0].payload_encrypted,/^v1\./);
  for(const fragment of ['synthetic-private-message','synthetic-recipient','synthetic-platform-user'])assert.equal(rows[0].payload_encrypted.includes(fragment),false);
  assert.equal((await repository.read({...context,actorId:'other'})).drafts.length,0);
  await pool!.execute('INSERT INTO xiaohongshu_messaging VALUES (?,?,?,?)',[context.workspaceId,'copied-owner',expected.revision,rows[0].payload_encrypted]);
  await assert.rejects(repository.read({...context,actorId:'copied-owner'}));
  passed('real service / encrypted roundtrip / tenant AAD / unknown cannot resend');
  phase='concurrent-CAS';
  const race={...context,actorId:'race-owner'};
  const initial={revision:1,drafts:[]};
  for(const [revision,state] of [[0,initial],[1,{revision:2,drafts:[]}]] as const){
    const outcomes=await Promise.allSettled([repository.save(race,structuredClone(state),revision),repository.save(race,structuredClone(state),revision)]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    const failed=outcomes.find(x=>x.status==='rejected');assert.ok(failed?.status==='rejected');assert.match(failed.reason.message,/revision_conflict/);
  }
  passed('concurrent INSERT and UPDATE have exactly one winner');
  phase='restart'; await pool!.end();pool=undefined;
  await docker(['restart',name]); await ready(); repository=new MysqlXhsMessagingRepository(pool!);
  assert.deepEqual(await repository.read(context),expected);
  passed('container restart retains encrypted state and unknown receipt');
  phase='backup-restore';
  const dump=await docker(['exec',name,'mysqldump','--defaults-extra-file=/run/shensi-test-secrets/client.cnf','--single-transaction','--no-tablespaces','shensi_synthetic']);
  await writeFile(join(directory,'synthetic-backup.sql'),dump,{mode:0o600});
  await pool!.query('DROP TABLE xiaohongshu_messaging'); // exclusively this newly owned synthetic database
  await new Promise<void>((resolve,reject)=>{
    const child=spawn('docker',['exec','-i',name,'mysql','--defaults-extra-file=/run/shensi-test-secrets/client.cnf','shensi_synthetic'],{stdio:['pipe','ignore','ignore']});
    const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('restore_timeout'));},30000);
    child.once('error',reject);child.once('close',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('restore_failed'));});
    child.stdin.on('error',()=>{});child.stdin.end(dump);
  });
  assert.deepEqual(await repository.read(context),expected);
  const [marker]=await pool!.query<mysql.RowDataPacket[]>('SELECT value FROM synthetic_legacy_marker WHERE id=1');
  assert.equal(marker[0].value,'preserve-synthetic-record');
  passed('backup restore and unrelated synthetic table preservation');
} catch(error) {
  const code=typeof error==='object' && error && 'code' in error ? String(error.code).replace(/[^A-Z0-9_-]/gi,'').slice(0,60) : 'unknown';
  console.error(`FAIL phase=${phase} kind=${error instanceof assert.AssertionError?'assertion':'operation'} code=${code}`);
  if(['cached-image','create-volume','create-container'].includes(phase) && typeof error==='object' && error && 'stderr' in error) {
    console.error(String(error.stderr).replaceAll(directory,'<temporary-directory>').slice(0,1500));
  }
  process.exitCode=1;
} finally {
  await pool?.end();
  if(oldKey===undefined)delete process.env.AGENT_JOB_ENCRYPTION_KEY;else process.env.AGENT_JOB_ENCRYPTION_KEY=oldKey;
  if(containerCreated){
    assert.equal(await docker(['inspect','--format','{{index .Config.Labels "shensi.acceptance"}}',name]),nonce);
    await docker(['rm','--force',name]);
  }
  if(volumeCreated){
    assert.equal(await docker(['volume','inspect','--format','{{index .Labels "shensi.acceptance"}}',volume]),nonce);
    await docker(['volume','rm',volume]);
  }
  await rm(directory,{recursive:true,force:true});
  passed('removed only this run container, volume and temporary synthetic backup');
}
