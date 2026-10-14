import type { components } from '../generated/xiaohongshu-messaging.js';
import type { createXhsWorker } from './xiaohongshu-worker.ts';

type Schema = components['schemas'];
export interface XhsScope { workspaceId:string; actorId:string; deviceId:string }
export interface XhsAuthority {
  authorize(workspaceId:string):Promise<XhsScope>;
  accounts(scope:XhsScope):Promise<Schema['XhsAccount'][]>;
  bind(scope:XhsScope,value:Schema['XhsAccountBinding']):Promise<unknown>;
  claim(scope:XhsScope,id:string,revision:number):Promise<Schema['XhsCommand']>;
  receipt(scope:XhsScope,id:string,value:Schema['XhsReceiptReport']):Promise<unknown>;
}
const same = (a:XhsScope,b:XhsScope) => a.workspaceId===b.workspaceId && a.actorId===b.actorId && a.deviceId===b.deviceId;
export class XhsDesktopService {
  private current?:{scope:XhsScope;worker:ReturnType<typeof createXhsWorker>};
  constructor(private authority:XhsAuthority, private factory:(scope:XhsScope)=>ReturnType<typeof createXhsWorker>,private enabled=false) {}
  private async worker(scope:XhsScope) {
    if(this.current && !same(this.current.scope,scope)) await this.dispose();
    if(!this.current) this.current={scope,worker:this.factory(scope)};
    try {await this.current.worker.ready;} catch(error) {await this.dispose();throw error;}
    return this.current.worker;
  }
  private async recheck(scope:XhsScope) {
    if(!same(scope,await this.authority.authorize(scope.workspaceId))) {
      await this.dispose();throw new Error('xhs_scope_changed');
    }
  }
  async open(workspaceId:string,accountId:string) {
    const scope=await this.authority.authorize(workspaceId);
    const worker=await this.worker(scope);
    await this.recheck(scope);
    await worker.request({operation:'open',accountId});
    return {accountId,state:'login_open' as const};
  }
  async connect(workspaceId:string,accountId:string,displayName:string) {
    const scope=await this.authority.authorize(workspaceId);
    const worker=await this.worker(scope);
    const result=await worker.request({operation:'connect',accountId});
    const value=result as Record<string,unknown> | null;
    if(!value || value.accountId!==accountId || value.state!=='ready'
      || typeof value.platformUserId!=='string' || !/^[A-Za-z0-9_-]{1,160}$/u.test(value.platformUserId)
      || typeof value.generation!=='string' || !/^[a-f0-9-]{36}$/u.test(value.generation)) throw new Error('xhs_worker_protocol_failed');
    try {
      await this.recheck(scope);
      const previous=(await this.authority.accounts(scope)).find(account=>account.accountId===accountId);
      return await this.authority.bind(scope,{accountId,platformUserId:value.platformUserId,displayName,
        generation:value.generation,state:'ready',revision:previous?.revision ?? 0});
    } catch(error) {await worker.request({operation:'close',accountId}).catch(()=>undefined);throw error;}
  }
  async close(workspaceId:string,accountId:string) {
    const scope=await this.authority.authorize(workspaceId);
    if(this.current && same(this.current.scope,scope)) await this.current.worker.request({operation:'close',accountId});
    const previous=(await this.authority.accounts(scope)).find(account=>account.accountId===accountId);
    if(previous) return this.authority.bind(scope,{accountId,platformUserId:previous.platformUserId,
      displayName:previous.displayName,generation:previous.generation,state:'expired',revision:previous.revision});
  }
  async send(workspaceId:string,id:string,revision:number) {
    if(!this.enabled) throw new Error('xhs_sending_disabled');
    const scope=await this.authority.authorize(workspaceId);
    const worker=await this.worker(scope);
    const command=await this.authority.claim(scope,id,revision);
    await this.recheck(scope);
    if(!same(scope,command) || command.commandId!==id) throw new Error('xhs_scope_changed');
    let receipt:Schema['XhsReceipt']={status:'unknown'};
    try {
      const raw=await worker.request({operation:'execute',command});
      const value=raw as Record<string,unknown> | null;
      if(value?.status==='confirmed' && typeof value.serverMessageId==='string' && /^[A-Za-z0-9_-]{1,160}$/u.test(value.serverMessageId))
        receipt={status:'confirmed',serverMessageId:value.serverMessageId};
      else if(value?.status==='rejected' && typeof value.platformCode==='number' && Number.isInteger(value.platformCode) && value.platformCode>0 && value.platformCode<=0xffffffff)
        receipt={status:'rejected',platformCode:value.platformCode};
    } catch { /* A lost response cannot authorize another send. */ }
    await this.recheck(scope);
    return this.authority.receipt(scope,id,{clientMessageId:command.clientMessageId,generation:command.generation,receipt});
  }
  async dispose() {const current=this.current;this.current=undefined;await current?.worker.close();}
  async checkSession() {
    const current=this.current;if(!current)return;
    try {await this.recheck(current.scope);} catch {if(this.current===current)await this.dispose();}
  }
}
