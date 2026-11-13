import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
const failure=code=>new Error(`KNOWLEDGE_RUNTIME_${code}`);
async function trustedFile(path,privateFile=false){
  if(typeof path!=='string'||!isAbsolute(path))throw failure('PATH');const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||![0,process.getuid?.()].includes(info.uid)
    ||(privateFile?(info.mode&0o777)!==0o600:!!(info.mode&0o022)))throw failure('PRIVATE');
  return realpath(path);
}
async function validate(repo,value){
  if(!value||value.version!==1||Object.keys(value).some(x=>!['version','python','manifest'].includes(x)))throw failure('CONFIG');
  const python=await trustedFile(value.python),script=await trustedFile(resolve(repo,'services/knowledge-reader/shensi_knowledge_reader.py'));
  const manifest=value.manifest===undefined?undefined:await trustedFile(value.manifest,true);
  return {python,script,...(manifest?{manifest}:{})};
}
export async function readKnowledgeReaderRuntime(repo){
  const path=join(repo,'.runtime/desktop-local/knowledge-reader.json');
  try{await trustedFile(path,true);}catch(error){if(error.code==='ENOENT')return undefined;throw error;}
  return validate(repo,JSON.parse(await readFile(path,'utf8')));
}
/** Explicit local configuration; never consumes arbitrary inherited env paths. */
export async function configureKnowledgeReaderRuntime(repo,input){
  const value={version:1,...input};await validate(repo,value);
  const root=join(repo,'.runtime/desktop-local');await mkdir(root,{recursive:true,mode:0o700});
  const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o700)throw failure('PRIVATE');
  const path=join(root,'knowledge-reader.json');
  try{await trustedFile(path,true);}catch(error){if(error.code!=='ENOENT')throw error;}
  await writeFile(path,JSON.stringify(value)+'\n',{mode:0o600});
  return readKnowledgeReaderRuntime(repo);
}
