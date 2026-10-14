import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';
import { requireGrowthCapabilities } from './growth-capabilities.js';
import { GrowthHttpError } from './growth-command-context.js';
import { encryptAgentJobPayload, decryptAgentJobPayload } from './agent-job-security.js';
import type { XhsAccount } from './xiaohongshu-accounts.js';

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/u);
const text = z.string().min(1).max(800).refine(value => Boolean(value.trim()));
const deviceId = z.union([id,z.string().regex(/^sha256:[a-f0-9]{64}$/u)]);
const draftSchema = z.object({ id:z.string().uuid(), accountId:id, deviceId, recipientId:id, body:text }).strict();
const receiptSchema = z.discriminatedUnion('status', [
  z.object({status:z.literal('unknown')}).strict(),
  z.object({status:z.literal('confirmed'), serverMessageId:id}).strict(),
  z.object({status:z.literal('rejected'), platformCode:z.number().int().min(1).max(0xffffffff)}).strict()
]);
type Receipt = z.infer<typeof receiptSchema>;
export interface XhsDraft extends z.infer<typeof draftSchema> {
  revision:number; status:'draft'|'approved'|'executing'|'unknown'|'confirmed'|'rejected';
  generation?:string; clientMessageId?:string; expiresAt?:number; quotaDay?:string;
  receipt?:Receipt; updatedAt:number;
}
export interface XhsMessagingState { revision:number; drafts:XhsDraft[]; accounts?:XhsAccount[] }
export interface XhsMessagingRepository {
  read(context:ActiveWorkspaceContext):Promise<XhsMessagingState>;
  save(context:ActiveWorkspaceContext, state:XhsMessagingState, expected:number):Promise<void>;
}
function fail(code:string):never { throw new GrowthHttpError(409, `xhs_${code}`); }
function authorize(context:ActiveWorkspaceContext) {
  requireGrowthCapabilities(context,['acquisition.outreach.approve']);
  if (!id.safeParse(context.workspaceId).success || context.workspaceId === 'all' || !id.safeParse(context.actorId).success)
    throw new GrowthHttpError(403,'workspace_required');
}
export function xhsStorageIdentity(context:ActiveWorkspaceContext) {
  authorize(context);
  return {id:'messaging',teamId:context.workspaceId,ownerId:context.actorId,jobType:'xiaohongshu-messaging.v1'};
}
// Uses the same scoped authenticated encryption as existing saved conversations.
export class MemoryXhsMessagingRepository implements XhsMessagingRepository {
  private rows = new Map<string,{revision:number;payload:string}>();
  private key(context:ActiveWorkspaceContext) { xhsStorageIdentity(context); return JSON.stringify([context.workspaceId,context.actorId]); }
  async read(context:ActiveWorkspaceContext):Promise<XhsMessagingState> {
    const row = this.rows.get(this.key(context));
    return row ? decryptAgentJobPayload(xhsStorageIdentity(context),'output',row.payload) as unknown as XhsMessagingState : {revision:0,drafts:[]};
  }
  async save(context:ActiveWorkspaceContext,state:XhsMessagingState,expected:number) {
    const key = this.key(context);
    if ((this.rows.get(key)?.revision ?? 0) !== expected || state.revision !== expected+1) fail('revision_conflict');
    this.rows.set(key,{revision:state.revision,payload:encryptAgentJobPayload(xhsStorageIdentity(context),'output',{...state})});
  }
}
interface Account { accountId:string; deviceId:string; generation:string; active:boolean }
interface Options {
  enabled?:boolean; dailyLimit?:number; clock?:()=>number;
  // Must verify a registered device and account in the authenticated scope.
  account:(context:ActiveWorkspaceContext, accountId:string, deviceId:string)=>Promise<Account|null>;
}
export class XiaohongshuMessagingService {
  private clock:()=>number;
  private limit:number;
  constructor(private repository:XhsMessagingRepository, private options:Options) {
    this.clock = options.clock ?? Date.now;
    this.limit = options.dailyLimit ?? 20;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 100) throw new Error('invalid_xhs_daily_limit');
  }
  private guard(context:ActiveWorkspaceContext) {
    authorize(context);
    if (this.options.enabled !== true) fail('sending_disabled');
  }
  private now() { const now=this.clock(); if (!Number.isSafeInteger(now) || now < 0) fail('clock_invalid'); return now; }
  private async mutate<T>(context:ActiveWorkspaceContext, apply:(state:XhsMessagingState)=>Promise<T>|T):Promise<T> {
    const state = await this.repository.read(context);
    const expected = state.revision;
    const result = await apply(state);
    state.revision = expected+1;
    await this.repository.save(context,state,expected);
    return structuredClone(result);
  }
  private record(state:XhsMessagingState,draftId:string,revision?:number) {
    const record = state.drafts.find(value=>value.id === draftId);
    if (!record) fail('not_found');
    if (revision !== undefined && (!Number.isSafeInteger(revision) || record.revision !== revision)) fail('revision_conflict');
    return record;
  }
  private async binding(context:ActiveWorkspaceContext, record:XhsDraft, deviceId=record.deviceId) {
    const account = await this.options.account(context,record.accountId,deviceId);
    if (!account?.active || account.accountId !== record.accountId || account.deviceId !== record.deviceId || deviceId !== record.deviceId || !id.safeParse(account.generation).success)
      fail('account_not_ready');
    return account;
  }
  private quota(state:XhsMessagingState, record:XhsDraft, now:number) {
    const day = new Date(now).toISOString().slice(0,10);
    const occupied = state.drafts.filter(value=>value.id !== record.id && value.accountId === record.accountId && value.quotaDay === day &&
      (value.status === 'approved' ? (value.expiresAt ?? 0)>now : ['executing','unknown','confirmed','rejected'].includes(value.status))).length;
    if (occupied >= this.limit) fail('daily_limit');
    return day;
  }
  async list(context:ActiveWorkspaceContext) {
    authorize(context); const now=this.now();
    return (await this.repository.read(context)).drafts.map(record =>
      record.status === 'executing' && (record.expiresAt ?? 0) <= now
        ? {...record,status:'unknown' as const,receipt:{status:'unknown' as const}} : record);
  }
  async create(context:ActiveWorkspaceContext,input:unknown) {
    this.guard(context);
    const value = draftSchema.parse(input);
    return this.mutate(context,state=>{
      if (state.drafts.some(record=>record.id === value.id)) fail('draft_exists');
      if (state.drafts.length >= 2000) fail('history_full');
      const record:XhsDraft={...value,revision:1,status:'draft',updatedAt:this.now()};
      state.drafts.push(record); return record;
    });
  }
  async edit(context:ActiveWorkspaceContext,draftId:string,revision:number,input:unknown) {
    this.guard(context);
    const change = draftSchema.pick({recipientId:true,body:true}).parse(input);
    return this.mutate(context,state=>{
      const record = this.record(state,draftId,revision);
      if (!['draft','approved'].includes(record.status)) fail('not_editable');
      Object.assign(record,change,{status:'draft',revision:record.revision+1,updatedAt:this.now()});
      delete record.generation; delete record.clientMessageId; delete record.expiresAt; delete record.quotaDay;
      return record;
    });
  }
  async approve(context:ActiveWorkspaceContext,draftId:string,revision:number) {
    this.guard(context);
    return this.mutate(context,async state=>{
      const record = this.record(state,draftId,revision);
      if (record.status !== 'draft') fail('not_editable');
      const account = await this.binding(context,record);
      const now = this.now(); const quotaDay = this.quota(state,record,now);
      Object.assign(record,{status:'approved',revision:record.revision+1,generation:account.generation,clientMessageId:randomUUID(),
        expiresAt:now+300_000,quotaDay,updatedAt:now});
      return record;
    });
  }
  async claim(context:ActiveWorkspaceContext,deviceId:string,draftId:string,revision:number) {
    this.guard(context);
    return this.mutate(context,async state=>{
      const record = this.record(state,draftId,revision);
      if (record.status !== 'approved') fail('not_approved');
      const account = await this.binding(context,record,deviceId);
      if (account.generation !== record.generation) fail('account_changed');
      const now = this.now();
      if (!record.expiresAt || record.expiresAt <= now) fail('approval_expired');
      record.quotaDay = this.quota(state,record,now);
      record.status='executing'; record.revision++; record.updatedAt=now;
      return {commandId:record.id,workspaceId:context.workspaceId,actorId:context.actorId,deviceId:record.deviceId,accountId:record.accountId,
        recipientId:record.recipientId,body:record.body,revision,clientMessageId:record.clientMessageId!,generation:record.generation!,expiresAt:record.expiresAt};
    });
  }
  async receipt(context:ActiveWorkspaceContext,deviceId:string,draftId:string,mid:string,generation:string,input:unknown) {
    authorize(context); // Disabling new sends must not discard an in-flight receipt.
    const receipt = receiptSchema.parse(input);
    return this.mutate(context,state=>{
      const record = this.record(state,draftId);
      if (record.deviceId !== deviceId || record.clientMessageId !== mid || record.generation !== generation) fail('receipt_mismatch');
      if (['confirmed','rejected'].includes(record.status)) {
        if (JSON.stringify(record.receipt) !== JSON.stringify(receipt)) fail('receipt_conflict');
        return record;
      }
      if (!['executing','unknown'].includes(record.status)) fail('not_executing');
      record.status=receipt.status; record.receipt=receipt; record.revision++; record.updatedAt=this.now();
      return record;
    });
  }
}
