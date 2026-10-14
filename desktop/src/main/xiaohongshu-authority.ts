import { createHash } from 'node:crypto';
import type { XhsAuthority, XhsScope } from './xiaohongshu-service.ts';
import type { DeviceCredentialStore } from './device-credential-store.ts';
import type { DeviceInstallationStore } from './device-installation.ts';
interface Session {
  fetch(url:string,init:RequestInit):Promise<Response>;
  cookies:{get(filter:{url:string}):Promise<{name:string;value:string}[]>};
}
export function createXhsAuthority(options:{localOrigin:string;session():Session|undefined;
  installationStore:DeviceInstallationStore;credentialStore:Pick<DeviceCredentialStore,'load'>}):XhsAuthority {
  const prefix='/api/v1/acquisition/xiaohongshu';
  async function identity(workspaceId:string) {
    if(!/^[A-Za-z0-9_-]{1,160}$/u.test(workspaceId) || workspaceId==='all')throw new Error('xhs_scope_invalid');
    const session=options.session();if(!session)throw new Error('xhs_auth_required');
    const response=await session.fetch(`${options.localOrigin}/api/auth/me`,{credentials:'include',redirect:'error',
      headers:{'X-Workspace-Id':workspaceId},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('xhs_auth_required');
    const data=await response.json();
    if(typeof data?.user?.id!=='string' || !/^[A-Za-z0-9_-]{1,160}$/u.test(data.user.id))throw new Error('xhs_auth_required');
    const credential=await options.credentialStore.load(workspaceId);
    if(!credential)throw new Error('xhs_device_registration_required');
    const installationId=await options.installationStore.getOrCreateInstallationId();
    const deviceId=`sha256:${createHash('sha256').update(`shensi-desktop-installation\0${installationId}`,'utf8').digest('hex')}`;
    return {session,credential,installationId,scope:{workspaceId,actorId:data.user.id,deviceId} as XhsScope};
  }
  async function request(scope:XhsScope,path:string,input?:unknown) {
    const current=await identity(scope.workspaceId);
    if(current.scope.actorId!==scope.actorId || current.scope.deviceId!==scope.deviceId)throw new Error('xhs_scope_changed');
    const headers:Record<string,string>={'X-Workspace-Id':scope.workspaceId,Origin:options.localOrigin};
    if(input!==undefined) {
      const csrf=(await current.session.cookies.get({url:options.localOrigin})).find(value=>value.name==='gj_csrf')?.value;
      if(!csrf)throw new Error('xhs_auth_required');
      headers['x-csrf-token']=decodeURIComponent(csrf);headers['Content-Type']='application/json';
      headers['X-Shensi-Desktop-Installation-Id']=current.installationId;
      headers['X-Shensi-Desktop-Device-Token']=current.credential.deviceToken;
    }
    const response=await current.session.fetch(`${options.localOrigin}${prefix}${path}`,{credentials:'include',redirect:'error',headers,
      method:input===undefined?'GET':'POST',body:input===undefined?undefined:JSON.stringify(input),signal:AbortSignal.timeout(15000)});
    if(!response.ok) {
      const value=await response.json().catch(()=>null);
      throw new Error(typeof value?.code==='string' && /^xhs_[a-z_]{1,60}$/u.test(value.code)?value.code:'xhs_backend_unavailable');
    }
    return response.json();
  }
  return {
    async authorize(workspaceId) {
      const {scope}=await identity(workspaceId);
      await request(scope,'/accounts'); // Backend resolves current membership and approval capability.
      return scope;
    },
    async accounts(scope) {const value=await request(scope,'/accounts');if(!Array.isArray(value?.items))throw new Error('xhs_protocol_failed');return value.items;},
    bind:(scope,value)=>request(scope,'/accounts/bind',value),
    claim:(scope,id,revision)=>request(scope,`/drafts/${encodeURIComponent(id)}/claim`,{revision}),
    receipt:(scope,id,value)=>request(scope,`/drafts/${encodeURIComponent(id)}/receipt`,value),
  };
}
