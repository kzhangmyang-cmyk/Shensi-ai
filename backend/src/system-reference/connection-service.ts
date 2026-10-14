import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { assertKnowledgeScope, type KnowledgeScope } from '../knowledge/domain.js';
import { ReferenceAccessError } from './authority.js';
import { bindingExchangeSchema, bindingPendingSchema, referenceOrigin, type ReferenceBindingTransport, type ReferenceClient } from './client.js';
import { createConnectionCrypto, type ConnectionRecord, type ConnectionScope, type ConnectionSlot, type ConnectionStore } from './connection-store.js';
import { queryResultSchema, systemReferenceSchema, systemReferenceQuerySchema, type ConnectionStatus } from './domain.js';

export type LocalReferenceIdentity = { actorId: string; workspaceId: string; authVersion: number };
type Common = { current(ctx: KnowledgeScope): Promise<LocalReferenceIdentity> };
type ClientOptions = Common & { mode:'client';backendInstanceId:string;issuer:string;store:ConnectionStore;secret:string;transport:ReferenceBindingTransport;now?:()=>number };
export type ReferenceConnectionOptions = Common & ({mode:'disabled'} | {mode:'central';central(ctx:KnowledgeScope,signal?:AbortSignal):Promise<ReferenceClient>}) | ClientOptions;
const unavailable=()=>new ReferenceAccessError(503,'reference_unavailable');
const changed=()=>new ReferenceAccessError(401,'reference_connection_changed');
const conflict=()=>new ReferenceAccessError(409,'reference_connection_unconfirmed');
const day=86400000;

export class ReferenceConnectionService {
  private readonly crypto;
  private readonly now:()=>number;
  private readonly epochs=new Map<string,number>();
  private readonly flights=new Map<string,Set<AbortController>>();
  private readonly poisoned=new Set<string>();
  private closed=false;
  private readonly lifetime=new AbortController();
  /** Shutdown cancels only this instance; durable credentials/tombstones survive. */
  close(){
    if(this.closed)return;this.closed=true;this.lifetime.abort();
    for(const actorId of this.flights.keys())this.abortActor(actorId);
  }
  private ensureOpen(){if(this.closed)throw changed();}
  constructor(private readonly options:ReferenceConnectionOptions) {
    this.now=options.mode==='client'?(options.now??Date.now):Date.now;
    this.crypto=options.mode==='client'?createConnectionCrypto(options.secret):null;
    if(options.mode==='client') {
      referenceOrigin(options.issuer);
      if(options.transport.origin!==options.issuer || !options.backendInstanceId || options.backendInstanceId.length>191)throw Error('reference_configuration_invalid');
    }
  }
  private clientOptions() {this.ensureOpen();if(this.options.mode!=='client')throw conflict();return this.options;}
  private async identity(ctx:KnowledgeScope) {
    this.ensureOpen();
    assertKnowledgeScope(ctx,'knowledge.read');
    try {
      const identity=await this.options.current(ctx);
      this.ensureOpen();
      if(identity.actorId!==ctx.actorId||identity.workspaceId!==ctx.workspaceId||!Number.isSafeInteger(identity.authVersion)||identity.authVersion<1)throw changed();
      return identity;
    } catch {this.abortActor(ctx.actorId);throw changed();}
  }
  private epoch(actorId:string) {return this.epochs.get(actorId)??0;}
  private abortActor(actorId:string) {
    this.epochs.set(actorId,this.epoch(actorId)+1);
    for(const controller of this.flights.get(actorId)??[])controller.abort();
    this.flights.delete(actorId); // No evidence/body cache exists in this service.
  }
  private async transaction<T>(actorId:string,fn:(row:ConnectionRecord)=>Promise<T>) {
    const options=this.clientOptions();
    if(this.poisoned.has(actorId))throw unavailable();
    try {return await options.store.transaction(options.backendInstanceId,actorId,fn);}
    catch(error) {
      if(error instanceof ReferenceAccessError && error.status!==503)throw error;
      this.abortActor(actorId);this.poisoned.add(actorId);throw unavailable();
    }
  }
  private retire(row:ConnectionRecord,slot:ConnectionSlot) {
    let sealed:string|null=null;
    try {sealed=this.crypto!.seal(slot.scope,{verifier:this.crypto!.open(slot.scope,slot.sealed).verifier});} catch { /* no recoverable credential */ }
    row.tombstones.push({scope:slot.scope,requestId:slot.requestId,sealed,expiresAt:slot.expiresAt,
      retainUntil:Math.max(this.now(),slot.expiresAt)+7*day,cancelled:!slot.requestId});
    row.connections=row.connections.filter(item=>item!==slot);
  }
  private prune(row:ConnectionRecord) {
    row.tombstones=row.tombstones.filter(item=>item.retainUntil>this.now());
    for(const item of row.tombstones)if(item.expiresAt<=this.now()){item.cancelled=true;item.sealed=null;}
    if(row.tombstones.length>=999)throw conflict();
  }
  private async load(ctx:KnowledgeScope) {
    const identity=await this.identity(ctx),options=this.clientOptions();
    return this.transaction(ctx.actorId,async row=>{
      this.prune(row);
      const slot=row.connections.find(item=>item.scope.workspaceId===ctx.workspaceId);
      if(slot&&(slot.scope.issuer!==options.issuer||slot.scope.authVersion!==identity.authVersion||slot.expiresAt<=this.now())) {
        this.abortActor(ctx.actorId);row.generation++;this.retire(row,slot);
      }
      return {generation:row.generation,slot:structuredClone(row.connections.find(item=>item.scope.workspaceId===ctx.workspaceId)),
        unresolved:row.tombstones.some(item=>item.scope.workspaceId===ctx.workspaceId&&!item.cancelled&&item.expiresAt>this.now())};
    });
  }
  async status(ctx:KnowledgeScope):Promise<ConnectionStatus> {
    await this.identity(ctx);
    if(this.options.mode==='disabled')return {status:'unconfigured',generation:0};
    if(this.options.mode==='central'){await this.options.central(ctx);this.ensureOpen();return {status:'session_ready',generation:this.epoch(ctx.actorId)};}
    const row=await this.load(ctx);
    if(!row.slot)return {status:row.unresolved?'unconfirmed':'unbound',generation:row.generation};
    return {status:row.slot.status,generation:row.slot.scope.generation,expiresAt:new Date(row.slot.expiresAt).toISOString(),
      ...(row.slot.centralAccountLabel?{centralAccountLabel:row.slot.centralAccountLabel}:{})};
  }
  private async run<T>(ctx:KnowledgeScope,check:()=>Promise<void>,operation:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T> {
    this.ensureOpen();
    const epoch=this.epoch(ctx.actorId),controller=new AbortController(),abort=()=>controller.abort();
    const flights=this.flights.get(ctx.actorId)??new Set<AbortController>();flights.add(controller);this.flights.set(ctx.actorId,flights);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try {
      await check();this.ensureOpen();if(controller.signal.aborted||this.epoch(ctx.actorId)!==epoch)throw changed();
      const result=await operation(controller.signal);
      await check();this.ensureOpen();if(controller.signal.aborted||this.epoch(ctx.actorId)!==epoch)throw changed();return result;
    } finally {signal?.removeEventListener('abort',abort);flights.delete(controller);if(!flights.size)this.flights.delete(ctx.actorId);}
  }
  private async assertSlot(ctx:KnowledgeScope,scope:ConnectionScope,status?:ConnectionSlot['status']) {
    const row=await this.load(ctx);
    if(!row.slot||row.slot.scope.generation!==scope.generation||row.slot.scope.issuer!==scope.issuer||row.slot.scope.authVersion!==scope.authVersion||(status&&row.slot.status!==status))throw changed();
    return row.slot;
  }
  async begin(ctx:KnowledgeScope,signal?:AbortSignal) {
    const epoch=this.epoch(ctx.actorId),options=this.clientOptions(),identity=await this.identity(ctx);await this.load(ctx);
    const verifier=randomBytes(32).toString('base64url');
    const scope=await this.transaction(ctx.actorId,async row=>{
      if(this.epoch(ctx.actorId)!==epoch||signal?.aborted)throw changed();
      this.prune(row);
      if(row.connections.some(item=>item.scope.workspaceId===ctx.workspaceId)||row.tombstones.some(item=>item.scope.workspaceId===ctx.workspaceId&&!item.cancelled)||row.connections.length>=100)throw conflict();
      const scope={backendInstanceId:options.backendInstanceId,workspaceId:ctx.workspaceId,actorId:ctx.actorId,authVersion:identity.authVersion,generation:++row.generation,issuer:options.issuer};
      row.connections.push({scope,status:'unconfirmed',requestId:null,sealed:this.crypto!.seal(scope,{verifier}),expiresAt:this.now()+300000});return scope;
    });
    const pending=await this.run(ctx,async()=>{await this.assertSlot(ctx,scope,'unconfirmed');},async s=>bindingPendingSchema.parse(await options.transport.create(createHash('sha256').update(verifier).digest('base64url'),s)),signal);
    const expiresAt=Date.parse(pending.expiresAt);if(expiresAt<=this.now()||expiresAt>this.now()+300000)throw unavailable();
    await this.transaction(ctx.actorId,async row=>{
      if(this.epoch(ctx.actorId)!==epoch||signal?.aborted)throw changed();
      const slot=row.connections.find(item=>item.scope.generation===scope.generation);if(!slot)throw changed();
      slot.requestId=pending.requestId;slot.expiresAt=expiresAt;slot.status='pending';
    });
    const url=new URL('/reference-approval.html',options.issuer);url.searchParams.set('requestId',pending.requestId);url.searchParams.set('displayCode',pending.displayCode);
    return {...pending,approvalUrl:url.toString()};
  }
  async complete(ctx:KnowledgeScope,requestId:string,signal?:AbortSignal):Promise<ConnectionStatus> {
    if(!z.string().uuid().safeParse(requestId).success)throw conflict();
    const epoch=this.epoch(ctx.actorId),options=this.clientOptions(),loaded=await this.load(ctx);
    if(!loaded.slot||loaded.slot.requestId!==requestId||loaded.slot.status!=='pending')throw conflict();
    const scope=loaded.slot.scope,verifier=this.crypto!.open(scope,loaded.slot.sealed).verifier;
    await this.transaction(ctx.actorId,async row=>{
      if(this.epoch(ctx.actorId)!==epoch||signal?.aborted)throw changed();
      const slot=row.connections.find(item=>item.scope.generation===scope.generation);
      if(!slot||slot.status!=='pending'||slot.requestId!==requestId)throw conflict();
      slot.status='unconfirmed';slot.expiresAt=this.now()+7*day; // Durable no-replay marker before network.
    });
    let result:z.infer<typeof bindingExchangeSchema>;
    try {result=await this.run(ctx,async()=>{await this.assertSlot(ctx,scope,'unconfirmed');},s=>options.transport.exchange(requestId,verifier,s),signal);}
    catch(error) {await this.assertSlot(ctx,scope,'unconfirmed');if(signal?.aborted)throw changed();return this.status(ctx);}
    const parsed=bindingExchangeSchema.safeParse(result),expiry=parsed.success?Date.parse(parsed.data.expiresAt):0;
    if(!parsed.success||expiry<=this.now()||expiry>this.now()+7*day)return this.status(ctx);
    await this.assertSlot(ctx,scope,'unconfirmed');
    await this.transaction(ctx.actorId,async row=>{
      if(this.epoch(ctx.actorId)!==epoch||signal?.aborted)throw changed();
      const slot=row.connections.find(item=>item.scope.generation===scope.generation);if(!slot||slot.status!=='unconfirmed')throw changed();
      slot.sealed=this.crypto!.seal(scope,{verifier,readerToken:parsed.data.readerToken});slot.status='ready';slot.expiresAt=expiry;slot.centralAccountLabel=parsed.data.reader.subjectId;
    });
    return this.status(ctx);
  }
  /** Only called with a normally authenticated actor by the server logout seam. */
  async fenceActor(actorId:string):Promise<void> {
    this.ensureOpen();
    this.abortActor(actorId);
    if(this.options.mode!=='client')return;
    await this.transaction(actorId,async row=>{this.prune(row);row.generation++;for(const slot of [...row.connections])this.retire(row,slot);});
  }
  async unbind(ctx:KnowledgeScope,signal?:AbortSignal):Promise<ConnectionStatus> {
    signal=signal?AbortSignal.any([signal,this.lifetime.signal]):this.lifetime.signal;
    await this.identity(ctx);const options=this.clientOptions();this.abortActor(ctx.actorId);
    const tombstones=await this.transaction(ctx.actorId,async row=>{
      this.prune(row);row.generation++;for(const slot of [...row.connections])if(slot.scope.workspaceId===ctx.workspaceId)this.retire(row,slot);
      return structuredClone(row.tombstones.filter(item=>item.scope.workspaceId===ctx.workspaceId&&!item.cancelled));
    });
    for(const item of tombstones) {
      if(item.scope.issuer!==options.issuer||!item.requestId||!item.sealed)continue;
      try {
        await options.transport.cancel(item.requestId,this.crypto!.open(item.scope,item.sealed).verifier,signal);
        await this.transaction(ctx.actorId,async row=>{const target=row.tombstones.find(t=>t.scope.generation===item.scope.generation);if(target){target.cancelled=true;target.sealed=null;}});
      } catch { /* Explicit uncertainty; never restore active credentials. */ }
    }
    return this.status(ctx);
  }
  async clientFor(ctx:KnowledgeScope,signal?:AbortSignal):Promise<ReferenceClient> {
    const identity=await this.identity(ctx),epoch=this.epoch(ctx.actorId);
    if(this.options.mode==='disabled')throw unavailable();
    let check:()=>Promise<void>,get:(s?:AbortSignal)=>Promise<ReferenceClient>;
    if(this.options.mode==='central') {
      const options=this.options;await options.central(ctx,signal);
      check=async()=>{const now=await this.identity(ctx);if(now.authVersion!==identity.authVersion||this.epoch(ctx.actorId)!==epoch)throw changed();};
      get=s=>options.central(ctx,s); // Only this explicit mode may reuse normal central identity.
    } else {
      const options=this.options,loaded=await this.load(ctx);if(!loaded.slot||loaded.slot.status!=='ready')throw changed();
      const scope=loaded.slot.scope;
      check=async()=>{await this.assertSlot(ctx,scope,'ready');if(this.epoch(ctx.actorId)!==epoch)throw changed();};
      get=async()=>{const slot=await this.assertSlot(ctx,scope,'ready'),token=this.crypto!.open(scope,slot.sealed).readerToken;if(!token)throw changed();return options.transport.reader(token);};
    }
    const run=<T>(fn:(client:ReferenceClient,s:AbortSignal)=>Promise<T>,s?:AbortSignal)=>this.run(ctx,check,async inner=>fn(await get(inner),inner),
      signal&&s?AbortSignal.any([signal,s]):s??signal);
    return Object.freeze<ReferenceClient>({
      query:(input,s)=>run(async(client,inner)=>queryResultSchema.parse(await client.query(systemReferenceQuerySchema.parse(input),inner)),s),
      assertCurrent:(id,s)=>run(async(client,inner)=>{z.string().uuid().parse(id);await client.assertCurrent(id,inner);},s),
      citation:(id,ref,s)=>run(async(client,inner)=>{z.string().uuid().parse(id);z.string().uuid().parse(ref);const source=systemReferenceSchema.parse(await client.citation(id,ref,inner));if(source.queryGrantId!==id||source.referenceId!==ref)throw changed();return source;},s)
    });
  }
}
