import type { XhsDesktopService } from './xiaohongshu-service.ts';
export const XHS_CHANNEL='shensi:xiaohongshu';
export function registerXhsIpc(options:{
  localOrigin:string;
  authorizedSender():{mainFrame:{url?:string};isDestroyed():boolean}|undefined;
  service:Pick<XhsDesktopService,'open'|'connect'|'close'|'send'|'dispose'>;
  ipcMain:{handle(channel:string,handler:(event:any,value:unknown)=>Promise<unknown>):void;removeHandler(channel:string):void};
}) {
  options.ipcMain.handle(XHS_CHANNEL,async(event,raw)=>{
    const sender=options.authorizedSender();
    if(!sender || sender.isDestroyed() || event.sender!==sender || event.senderFrame!==sender.mainFrame)
      throw new Error('xhs_sender_invalid');
    try {if(new URL(event.senderFrame.url).origin!==options.localOrigin)throw new Error();}
    catch {throw new Error('xhs_sender_invalid');}
    if(!raw || typeof raw!=='object' || Array.isArray(raw))throw new Error('xhs_input_invalid');
    const value=raw as Record<string,unknown>;
    const keys=Object.keys(value).sort().join(',');
    if(typeof value.workspaceId!=='string' || !/^[A-Za-z0-9_-]{1,160}$/u.test(value.workspaceId) || value.workspaceId==='all')
      throw new Error('xhs_input_invalid');
    const uuid=(id:unknown):id is string=>typeof id==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id);
    try {
      if((value.action==='open'||value.action==='close') && keys==='accountId,action,workspaceId' && uuid(value.accountId))
        return await options.service[value.action](value.workspaceId,value.accountId);
      if(value.action==='connect' && keys==='accountId,action,displayName,workspaceId' && uuid(value.accountId)
        && typeof value.displayName==='string' && value.displayName.trim() && value.displayName.length<=100)
        return await options.service.connect(value.workspaceId,value.accountId,value.displayName.trim());
      if(value.action==='send' && keys==='action,draftId,revision,workspaceId' && uuid(value.draftId)
        && typeof value.revision==='number' && Number.isSafeInteger(value.revision) && value.revision>=1)
        return await options.service.send(value.workspaceId,value.draftId,value.revision);
      throw new Error('xhs_input_invalid');
    } catch(error) {
      throw new Error(error instanceof Error && /^xhs_[a-z_]{1,60}$/u.test(error.message)?error.message:'xhs_operation_failed');
    }
  });
  return {async dispose(){options.ipcMain.removeHandler(XHS_CHANNEL);await options.service.dispose();}};
}
