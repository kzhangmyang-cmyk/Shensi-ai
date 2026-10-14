import {record} from './decision-replay-visual';
record.analysis={files:[],sources:[{sourceRef:'calc:fixture',text:'合成经营基线，仅供布局验收'}],uncertain:[],agents:(['founder','market','operations','finance','judge'] as const).map(role=>({role,state:'completed',observations:[{text:'合成的已保存分析，点击可以查看对应依据。',sourceRefs:['calc:fixture']}],provider:'fixture',model:'isolated-visual-fixture',errorCode:null}))};
document.querySelectorAll<HTMLButtonElement>('nav [data-theme]').forEach(button=>button.onclick=()=>{document.documentElement.dataset.theme=button.dataset.theme;});
