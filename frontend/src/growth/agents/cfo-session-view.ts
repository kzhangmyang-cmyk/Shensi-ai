import {mountCfoConversation} from './cfo-conversation';
import {BUSINESS_AGENT_TEAM} from './agents';

type Options=Parameters<typeof mountCfoConversation>[0];
type RoleView={panel:HTMLElement; controller:ReturnType<typeof mountCfoConversation>};
type Session={scope:string; identity:string; role:string; views:Map<string,RoleView>; host:HTMLElement|null; destroy():void};
const sessions=new WeakMap<Document,Session>();
const identity=(doc:Document)=>JSON.stringify([doc.body.dataset.sessionWorkspaceId,doc.body.dataset.sessionUserId]);

export function clearRetainedCfoConversation(doc:Document) { sessions.get(doc)?.destroy(); }

// Reuse the document-owned, detached-view lifecycle used by enterprise-analysis.
// Text requests remain owned by their role view, never by the current route.
export function mountRetainedCfoConversation(options:Options) {
  const doc=options.host.ownerDocument;const scope=options.scope();
  if(!scope)return mountCfoConversation(options);
  let state=sessions.get(doc);
  if(state&&(state.scope!==scope||state.identity!==identity(doc))){state.destroy();state=undefined;}
  if(!state){
    const value:Session={scope,identity:identity(doc),role:'cfo',views:new Map(),host:null,destroy(){
      for(const view of value.views.values()){view.controller.dispose();view.panel.replaceChildren();view.panel.remove();}
      value.views.clear();value.host=null;observer?.disconnect();doc.removeEventListener('goodjob:auth-state-changed',auth);
      doc.defaultView?.removeEventListener('pagehide',pagehide);
      if(sessions.get(doc)===value)sessions.delete(doc);
    }};
    const auth=(event:Event)=>{if((event as CustomEvent<{authenticated?:boolean}>).detail?.authenticated===false)value.destroy();};
    const pagehide=()=>value.destroy();
    const Observer=doc.defaultView?.MutationObserver;
    const observer=Observer?new Observer(()=>{if(identity(doc)!==value.identity||options.scope()!==scope)value.destroy();}):undefined;
    observer?.observe(doc.body,{attributes:true,attributeFilter:['data-session-workspace-id','data-session-user-id']});
    doc.addEventListener('goodjob:auth-state-changed',auth);doc.defaultView?.addEventListener('pagehide',pagehide);
    sessions.set(doc,value);state=value;
  }
  const current=state;current.host=options.host;
  function show(role:string){
    const agent=BUSINESS_AGENT_TEAM.find(item=>item.id===role);
    if(!agent||sessions.get(doc)!==current||!current.host)return;
    if(current.views.get(role)?.panel.parentElement===current.host)return;
    if (role !== current.role) current.views.get(current.role)?.controller.cancelPending();
    current.views.get(current.role)?.controller.suspend();
    let view=current.views.get(role);
    if(!view){
      const panel=doc.createElement('div');
      const controller=mountCfoConversation({...options,host:panel,initialRole:role,onRoleChange:show});
      view={panel,controller};current.views.set(role,view);
    }
    current.role=role;current.host.replaceChildren(view.panel);view.controller.resume();
    const EventType=doc.defaultView?.CustomEvent??CustomEvent;
    queueMicrotask(()=>{if(sessions.get(doc)===current&&current.host?.isConnected)doc.dispatchEvent(new EventType('goodjob:cfo-role-changed',{detail:{roleId:role,roleName:agent.name.replace(/^AI\s*/u,'')}}));});
  }
  show(current.role);
  return {dispose(){
    // A stale route disposer must not detach a subsequently mounted view.
    if(current.host!==options.host)return;
    current.views.get(current.role)?.controller.suspend();
    current.views.get(current.role)?.panel.remove();current.host=null;
  }};
}
