// Deliberately no raw command, executable, URL, Profile, token or cookie bridge.
export function exposeXhsApi(options:{contextBridge:{exposeInMainWorld(name:string,value:unknown):void};ipcRenderer:{invoke(channel:string,value:unknown):Promise<unknown>}}) {
  const invoke=(value:unknown)=>options.ipcRenderer.invoke('shensi:xiaohongshu',value);
  options.contextBridge.exposeInMainWorld('shensiXiaohongshu',Object.freeze({
    open:(workspaceId:string,accountId:string)=>invoke({action:'open',workspaceId,accountId}),
    connect:(workspaceId:string,accountId:string,displayName:string)=>invoke({action:'connect',workspaceId,accountId,displayName}),
    close:(workspaceId:string,accountId:string)=>invoke({action:'close',workspaceId,accountId}),
    send:(workspaceId:string,draftId:string,revision:number)=>invoke({action:'send',workspaceId,draftId,revision}),
  }));
}
