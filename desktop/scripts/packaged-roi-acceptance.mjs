import { createRequire } from 'node:module';
import { mkdtemp, realpath, access, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const app=path.resolve(process.argv[2]??'');
if(!app.endsWith('/Shensi.app'))throw new Error('exact_app_path_required');
const resources=path.join(app,'Contents/Resources');
const backend=path.join(resources,'backend');
const require=createRequire(path.join(repo,'desktop/package.json'));
const esbuild=require(require.resolve('esbuild',{paths:[path.dirname(require.resolve('tsx'))]}));
const mysql=createRequire(path.join(backend,'package.json'))('mysql2/promise');
const {LocalMysqlRuntime}=await import(path.join(repo,'desktop/dist/main/local-mysql-runtime.js'));
const directory=await realpath(await mkdtemp(path.join(tmpdir(),'shensi-packaged-roi-')));
const mapped=new Set();
const testFiles=['growth-roi-closure-mysql-test','growth-roi-module-mysql-test'];
for(const file of testFiles){
 await esbuild.build({entryPoints:[path.join(repo,'backend/src',file+'.ts')],outfile:path.join(directory,file+'.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',
  plugins:[{name:'packaged-production-only',setup(build){
   build.onResolve({filter:/^\./},async args=>{
    const source=path.resolve(args.resolveDir,args.path);
    if(!source.startsWith(path.join(repo,'backend/src')+path.sep))throw new Error('unexpected_relative_test_import');
    if(/(?:-test|-fixtures|-test-support)\.js$/u.test(source))return {path:source.slice(0,-3)+'.ts'};
    const installed=path.join(backend,'dist',path.relative(path.join(repo,'backend/src'),source));
    await access(installed);mapped.add(installed);return {path:installed,external:true};
   });
   build.onResolve({filter:/^[^./]/},args=>{
    if(args.path.startsWith('node:'))return {path:args.path,external:true};
    return {path:createRequire(path.join(backend,'package.json')).resolve(args.path),external:true};
   });
  }}]});
}
assert.ok(mapped.has(path.join(backend,'dist/growth-roi-module.js')));
const manifest=await Promise.all([...mapped].sort().map(async file=>({file,sha256:createHash('sha256').update(await readFile(file)).digest('hex')})));
await writeFile(path.join(directory,'production-modules.json'),JSON.stringify(manifest,null,2));
const rootPassword=randomBytes(32).toString('hex'),appPassword=randomBytes(32).toString('hex');
const runtime=new LocalMysqlRuntime({directory:path.join(directory,'database'),runtimeDirectory:path.join(resources,'mysql'),rootPassword,appPassword});
const url=()=>{const result=new URL(`mysql://root:${rootPassword}@localhost/mysql`);result.searchParams.set('socketPath',new URL(runtime.databaseUrl).searchParams.get('socketPath'));return result;};
async function snapshot(){
 const connection=await mysql.createConnection({socketPath:url().searchParams.get('socketPath'),user:'root',password:rootPassword,dateStrings:true,timezone:'Z'});
 try{
  const [dbs]=await connection.query('SHOW DATABASES');const rows=[];
  for(const row of dbs){const name=row.Database;if(!/^goodjob_growth_finance_\d+_[a-f0-9]{12}$/u.test(name))continue;
   const [snapshots]=await connection.query(`SELECT closure_version_id,computed_metrics_json,commercial_ratios_json FROM \`${name}\`.roi_snapshots ORDER BY closure_version_id`);
   rows.push({database:name,snapshots});
  }
  return rows.sort((a,b)=>a.database.localeCompare(b.database));
 }finally{await connection.end();}
}
try{
 await runtime.start(new AbortController().signal);
 const child=spawn(path.join(resources,'backend-runtime/node'),['--test',...testFiles.map(f=>path.join(directory,f+'.mjs'))],{cwd:backend,
  env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',MYSQL_TEST_ADMIN_URL:url().toString(),SHENSI_PACKAGED_ROI_RESTART:'1'},stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>process.stdout.write(chunk.toString().split(rootPassword).join('[redacted]')));
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>resolve(code??1));});
 assert.equal(code,0,'packaged_backend_tests_failed');
 const before=await snapshot();
 assert.ok(before.some(db=>db.snapshots.some(row=>{const value=typeof row.computed_metrics_json==='string'?JSON.parse(row.computed_metrics_json):row.computed_metrics_json;return value.roiBps===25000;})));
 await runtime.stop();await runtime.start(new AbortController().signal);
 const after=await snapshot();assert.deepEqual(after,before);
 console.log(JSON.stringify({packagedBackend:true,productionModuleCount:manifest.length,packagedNode:true,packagedMysql:true,
  syntheticAuthorityFixture:true,databaseFullRestart:true,persistedSnapshotsUnchanged:true,fullElectronBusinessAcceptance:false,artifacts:directory}));
}finally{await runtime.stop();}
