// Explicit, synthetic-only acceptance. Run through the root package script.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {promisify} from 'node:util';
import {openSync,closeSync,readFileSync,readdirSync} from 'node:fs';
import {access,mkdir,mkdtemp,realpath,lstat,rm,writeFile,copyFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalMysqlRuntime} from '../desktop/src/main/local-mysql-runtime.ts';
import {verifyCrossInstall} from '../backend/src/system-reference/runtime-cross-install-test.ts';

process.umask(0o077);
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
assert.deepEqual(args.filter((_,i)=>i%2===0),['--mysql-runtime','--evidence-dir'],'explicit test runtime and fresh evidence directory required');
assert.equal(args.length,4);assert.equal(process.cwd(),repo);
const runtimeDirectory=args[1],evidenceDir=args[3];
assert(isAbsolute(runtimeDirectory)&&isAbsolute(evidenceDir));
await access(join(runtimeDirectory,'bin/mysqld'));
// Evidence must be ignored, with an already-existing parent. Never overwrite a run.
await promisify(execFile)('git',['check-ignore','--quiet',evidenceDir],{cwd:repo});
assert.equal(await realpath(dirname(evidenceDir)),dirname(evidenceDir));
await mkdir(evidenceDir,{mode:0o700});
await writeFile(join(evidenceDir,'attempt-started'),new Date().toISOString(),{flag:'wx',mode:0o600});

const walk=(directory)=>readdirSync(join(repo,directory),{withFileTypes:true}).flatMap(entry=>{
  const path=join(directory,entry.name);
  return entry.isDirectory()?walk(path):entry.isFile()&&/\.(?:ts|tsx|mjs|mts|json|css|html|ya?ml|md)$/u.test(entry.name)?[path]:[];
});
const watched=[...new Set(['package.json','backend/package.json','frontend/package.json','desktop/package.json',
  'backend/tsconfig.system-reference-tests.json','README.md',...['backend/src','frontend/src','desktop/src','desktop/tests','contracts/openapi','contracts/json-schema','contracts/releases','scripts','docs'].flatMap(walk)])];
const hash=file=>createHash('sha256').update(readFileSync(join(repo,file))).digest('hex');
const before=new Map(watched.map(file=>[file,hash(file)]));
const safeEnv={};
for(const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL','SHELL','USER','LOGNAME','PNPM_HOME'])if(process.env[key]!==undefined)safeEnv[key]=process.env[key];
Object.assign(safeEnv,{NODE_ENV:'test',SHENSI_SKIP_LOCAL_ENV:'true',pnpm_config_verify_deps_before_run:'false',CI:'1'});
const lifetime=new AbortController(),abort=()=>lifetime.abort();
process.once('SIGINT',abort);process.once('SIGTERM',abort);
const deadline=setTimeout(abort,20*60_000),outcomes=[],startedAt=new Date().toISOString();
let stage='preflight',failed=false,directory,mysql,mysqlStopped=false,removed=false,restarted=false,crossInstall;
async function run(name,command,commandArgs,env=safeEnv){
  lifetime.signal.throwIfAborted();stage=name;process.stdout.write(`REFERENCE_GATE_START ${name}\n`);
  const log=openSync(join(evidenceDir,`${name}.log`),'wx',0o600);
  try{
    const child=spawn(command,commandArgs,{cwd:repo,env,detached:true,stdio:['ignore',log,log]});
    const result=await new Promise(done=>{
      let spawnFailed=false,timedOut=false,terminating=false,groupDone=false,exit;
      const signalGroup=signal=>{if(child.pid)try{process.kill(-child.pid,signal);}catch{}};
      const finish=()=>{if(exit&&(!terminating||groupDone))done({name,...exit,spawnFailed,timedOut});};
      const terminate=()=>{if(exit||terminating)return;terminating=true;timedOut=true;signalGroup('SIGTERM');
        setTimeout(()=>{signalGroup('SIGKILL');groupDone=true;finish();},5000);};
      const timer=setTimeout(terminate,name.startsWith('root-')?10*60_000:3*60_000);
      lifetime.signal.addEventListener('abort',terminate,{once:true});
      child.once('error',()=>{spawnFailed=true;});
      child.once('close',(code,signal)=>{exit={code,signal};clearTimeout(timer);lifetime.signal.removeEventListener('abort',terminate);finish();});
      if(lifetime.signal.aborted)terminate();
    });
    outcomes.push(result);const passed=result.code===0&&!result.signal&&!result.spawnFailed&&!result.timedOut;
    process.stdout.write(`REFERENCE_GATE_END ${name} ${passed?'passed':'failed'}\n`);assert(passed,'synthetic_gate_failed');
  }finally{closeSync(log);}
}
const pnpm=(name,argv,env)=>run(name,'pnpm',argv,env);
try{
  await pnpm('reference-types',['--dir','backend','test:system-reference-types']);
  await pnpm('cli-types',['--dir','backend','test:system-reference-cli-types']);
  await pnpm('root-test',['test']);
  await pnpm('root-build',['build']);
  await pnpm('growth-contracts',['check:growth-contracts']);
  await pnpm('security',['--dir','backend','test:security']);
  await pnpm('frontend-contract',['--dir','frontend','contract:check']);
  await pnpm('frontend-types',['--dir','frontend','test:types']);
  await pnpm('reference-browser',['--dir','frontend','test:e2e:system-reference']);
  await pnpm('knowledge-browser',['--dir','frontend','test:e2e:knowledge']);
  await pnpm('chat-layout',['--dir','frontend','exec','tsx','scripts/test-agent-chat-layout.mts']);
  await pnpm('theme',['--dir','frontend','test:theme']);
  await run('source-manifest','node',['--test','scripts/source-content-manifest.test.mjs']);
  await pnpm('desktop-test',['--dir','desktop','exec','tsx','--test','scripts/prepare-dev-build-identity.test.mjs','tests/renderer-server.test.ts']);
  await pnpm('desktop-types',['--dir','desktop','typecheck']);
  stage='owned-mysql-start';directory=await mkdtemp(join(await realpath(tmpdir()),'shensi-reference-verify-'));
  const rootPassword=randomBytes(32).toString('hex');
  mysql=new LocalMysqlRuntime({directory:join(directory,'mysql'),runtimeDirectory,rootPassword,appPassword:randomBytes(32).toString('hex')});
  await mysql.start(lifetime.signal);
  const adminUrl=()=>{const url=new URL(mysql.databaseUrl);url.username='root';url.password=rootPassword;url.pathname='/';return url.href;};
  await pnpm('reference-mysql',['--dir','backend','test:system-reference:mysql'],{...safeEnv,MYSQL_TEST_ADMIN_URL:adminUrl()});
  const certificate=join(directory,'tls.crt'),tlsKey=join(directory,'tls.key'),tlsConfig=join(directory,'tls.cnf');
  await writeFile(tlsConfig,'[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Shensi synthetic loopback\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n',{flag:'wx',mode:0o600});
  await promisify(execFile)('openssl',['req','-new','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',tlsConfig,'-keyout',tlsKey,'-out',certificate],
    {env:safeEnv,timeout:30000,maxBuffer:65536,signal:lifetime.signal});
  await chmod(tlsKey,0o600);await chmod(certificate,0o600);
  stage='cross-install';
  crossInstall=await verifyCrossInstall({adminUrl:adminUrl(),directory,certificate,tlsKey,signal:lifetime.signal,restart:async()=>{
    await mysql.stop();mysqlStopped=true;await mysql.start(lifetime.signal);mysqlStopped=false;restarted=true;return adminUrl();
  }});
  await mysql.stop();mysqlStopped=true;
  await run('context','./scripts/context-check',[]);
  await run('diff','git',['diff','--check']);stage='complete';
}catch{failed=true;}finally{
  if(mysql&&!mysqlStopped)try{await mysql.stop();mysqlStopped=true;}catch{failed=true;}
  if(directory){
    try{for(const file of readdirSync(directory))if(/^child-d9-install-\d-\d+\.log$/u.test(file)){
      const target=join(evidenceDir,file);await copyFile(join(directory,file),target);await chmod(target,0o600);
    }}catch{failed=true;}
    if(mysqlStopped)try{
      const info=await lstat(directory),parent=await realpath(tmpdir());
      assert.equal(dirname(directory),parent);assert(/^shensi-reference-verify-[A-Za-z0-9]+$/u.test(basename(directory)));
      assert(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid?.());
      await rm(directory,{recursive:true});removed=true;
    }catch{failed=true;}
  }
}
clearTimeout(deadline);process.off('SIGINT',abort);process.off('SIGTERM',abort);
const sourceUnchanged=watched.every(file=>hash(file)===before.get(file));
const passed=!failed&&!lifetime.signal.aborted&&stage==='complete'&&sourceUnchanged&&mysqlStopped&&removed&&restarted;
await writeFile(join(evidenceDir,'result.json'),JSON.stringify({passed,stage,startedAt,completedAt:new Date().toISOString(),outcomes,
  sourceUnchanged,watchedSourceCount:watched.length,crossInstall,mysqlStopped,temporaryRemoved:removed,restarted,
  retainedOwnedDirectory:removed?null:directory??null,booksPublished:false,liveModelCalls:false,currentApplicationRestarted:false,
  scope:'synthetic_only_three_processes_mysql_tls_and_full_regression'},null,2)+'\n',{flag:'wx',mode:0o600});
process.stdout.write(passed?'SYSTEM_REFERENCE_D9_FULL_OK\n':'SYSTEM_REFERENCE_D9_FULL_FAILED\n');process.exitCode=passed?0:1;
