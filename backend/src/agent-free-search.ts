import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GrowthHttpError } from './growth-command-context.js';
import type { AgentWebSource } from './agent-web-research.js';

const resultSchema=z.array(z.object({title:z.string().trim().min(1).max(300),href:z.string().url().max(4000),
  body:z.string().trim().min(1).max(10000)})).max(10);

export function decodeFreeSearch(raw:string):AgentWebSource[] {
  let parsed:unknown;
  try { parsed=JSON.parse(raw); } catch { throw new GrowthHttpError(502,'agent_web_search_unavailable'); }
  const result=resultSchema.safeParse(parsed);
  if(!result.success)throw new GrowthHttpError(502,'agent_web_search_unavailable');
  const fetchedAt=new Date().toISOString();
  return result.data.map(row=>({title:row.title,url:row.href,snippet:row.body.slice(0,3000),fetchedAt}));
}

/** Only the public planner query crosses stdin. No shell, platform session or model credentials. */
export async function searchPublicWeb(query:string, signal?:AbortSignal):Promise<AgentWebSource[]> {
  signal?.throwIfAborted();
  if(query.trim().length<2 || query.length>500)throw new GrowthHttpError(422,'agent_web_input_invalid');
  const root=new URL('../../services/web-search/',import.meta.url);
  const python=process.env.SHENSI_SEARCH_PYTHON || fileURLToPath(new URL('.venv/bin/python',root));
  const script=fileURLToPath(new URL('search.py',root));
  const raw=await new Promise<string>((resolve,reject)=>{
    const child=execFile(python,[script],{signal,timeout:20000,killSignal:'SIGKILL',maxBuffer:128*1024,
      env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',PYTHONIOENCODING:'utf-8'}},(error,stdout)=>{
      if(signal?.aborted){reject(signal.reason);return;}
      if(error){reject(new GrowthHttpError(502,'agent_web_search_unavailable'));return;}
      resolve(stdout);
    });
    child.stdin?.on('error',()=>{});
    child.stdin?.end(JSON.stringify({query}));
  });
  signal?.throwIfAborted();
  return decodeFreeSearch(raw);
}
