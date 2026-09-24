import { z } from 'zod';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';
import { GrowthHttpError } from './growth-command-context.js';
import { xhsStorageIdentity, type XhsMessagingRepository } from './xiaohongshu-messaging.js';

const bindingSchema=z.object({
  accountId:z.string().uuid(),platformUserId:z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/u),
  displayName:z.string().trim().min(1).max(100),generation:z.string().uuid(),
  state:z.enum(['ready','expired','verification_required','im_unavailable']),revision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict();
export interface XhsAccount extends z.infer<typeof bindingSchema> {deviceId:string;updatedAt:number}
function conflict(code:string):never {throw new GrowthHttpError(409,`xhs_${code}`);}

export class XhsAccountService {
  constructor(private repository:XhsMessagingRepository, private clock:()=>number=Date.now) {}
  async list(context:ActiveWorkspaceContext) {
    xhsStorageIdentity(context);
    return (await this.repository.read(context)).accounts ?? [];
  }
  async resolve(context:ActiveWorkspaceContext,accountId:string,deviceId:string) {
    const account=(await this.list(context)).find(value=>value.accountId===accountId && value.deviceId===deviceId && value.state==='ready');
    return account ? {accountId:account.accountId,deviceId:account.deviceId,generation:account.generation,active:true} : null;
  }
  // Caller authenticates the registered desktop; Renderer cannot assert login.
  async bind(context:ActiveWorkspaceContext,deviceId:string,input:unknown) {
    xhsStorageIdentity(context);
    z.string().regex(/^(?:[A-Za-z0-9_-]{1,160}|sha256:[a-f0-9]{64})$/u).parse(deviceId);
    const value=bindingSchema.parse(input);
    const state=await this.repository.read(context), expected=state.revision;
    const accounts=state.accounts ?? [];
    const previous=accounts.find(item=>item.accountId===value.accountId);
    if ((previous?.revision ?? 0)!==value.revision) conflict('revision_conflict');
    if (previous && previous.platformUserId!==value.platformUserId) conflict('account_identity_changed');
    if (accounts.some(item=>item.accountId!==value.accountId && item.platformUserId===value.platformUserId)) conflict('account_exists');
    const updatedAt=this.clock();
    if (!Number.isSafeInteger(updatedAt) || updatedAt<0) conflict('clock_invalid');
    const account:XhsAccount={...value,deviceId,revision:value.revision+1,updatedAt};
    state.accounts=[...accounts.filter(item=>item.accountId!==value.accountId),account];
    state.revision=expected+1;
    await this.repository.save(context,state,expected);
    return account;
  }
}
