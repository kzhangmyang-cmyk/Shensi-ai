import '../src/vendor/phosphor/regular/style.css';
import '../src/decision-simulation/cosmos.css';
import {mountDecisionAnalysis} from '../src/decision-simulation/analysis-view';
import type {components} from '../src/generated/decision-simulation';
type Preparation=components['schemas']['Preparation'];
const value:Preparation={id:'isolated-visual-fixture',expiresAt:'2026-09-15T00:00:00Z',dataKind:'synthetic',state:'analyzing',files:[],sources:[],facts:[],uncertain:[],runId:null,errorCode:null,agents:[]};
const roles=['founder','market','operations','finance','judge'] as const;
const view=mountDecisionAnalysis(document.querySelector<HTMLElement>('#analysis')!,()=>draw('running'));
view.setActive(true);
function draw(mode:string){const state:Preparation['state']=mode==='failed'?'failed':mode==='completed'?'completed':'analyzing';view.update({...value,state,agents:roles.map((role,index)=>({role,state:mode==='completed'||index<2?'completed':index===2?mode==='failed'?'failed':'running':'queued',provider:index<2?'fixture':null,model:index<2?'isolated-visual-state':null,errorCode:null,observations:[]}))});}
document.querySelectorAll<HTMLButtonElement>('[data-fixture]').forEach(button=>button.onclick=()=>draw(button.dataset.fixture!));draw('running');
document.querySelectorAll<HTMLButtonElement>('[data-theme-fixture]').forEach(button=>button.onclick=()=>{
 document.documentElement.dataset.theme=button.dataset.themeFixture!;
});
