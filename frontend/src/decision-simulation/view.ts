import { escapeHtml as e } from '../demo/demo-ui';
import { createGrowthHttpClient } from '../growth/http';
import { operatingExample, type SimulationInput, type SimulationRecord, type SimulationHistory } from './samples';
import type { components } from '../generated/decision-simulation';
import { renderDecisionExport } from './export';
import { mountDecisionReplay } from './replay-view';
import { mountDecisionAnalysis } from './analysis-view';
import { mountEventEditor } from './event-editor';
import {renderOperatingRecommendations} from './recommendations';
import {mountDecisionPreferences,renderPreferenceAssessment} from './preferences';
import {mountDecisionMemory,createOperatingMemoryApi,type DecisionMemoryApi} from '../agents/operating-memory';
type Preparation=components['schemas']['Preparation'];
type SourceInput=components['schemas']['SourceInput'];
export interface DecisionSimulationApi {
  memory?:DecisionMemoryApi;
  list(): Promise<SimulationHistory[]>; get(id: string): Promise<SimulationRecord>; create(input: SimulationInput): Promise<SimulationRecord>;
  prepare?(input:SourceInput):Promise<Preparation>;
  progress?(id:string):Promise<Preparation>;
  analyze?(id:string,input:SimulationInput):Promise<Preparation>;
}
const money = (value: number) => (value / 100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const fieldDefinitions = [
  ['cashMinor','期初现金（元）',true],['monthlyOrders','每月订单（件）',false],['backlogUnits','期初积压（件）',false],
  ['capacityUnits','每月交付产能（件）',false],['priceMinor','销售单价（元）',true],['unitCostMinor','单位直接成本（元）',true],
  ['fixedCostMinor','每月固定费用（元）',true],['collectionMonths','基础回款周期（月）',false],
] as const;
export function mountDecisionSimulation(host: HTMLElement, suppliedApi?: DecisionSimulationApi): void {
  const document=host.ownerDocument;
  const http=createGrowthHttpClient({workspaceId:()=>document.body.dataset.sessionWorkspaceId??null});
  const api:DecisionSimulationApi=suppliedApi??{
    list:async()=> (await http.request<SimulationHistory[]>('/api/v1/decision-simulations')).body,
    get:async(id:string)=> (await http.request<SimulationRecord>(`/api/v1/decision-simulations/${encodeURIComponent(id)}`)).body,
    create:async(input:SimulationInput)=> (await http.request<SimulationRecord>('/api/v1/decision-simulations',{method:'POST',body:input})).body,
    prepare:async(input)=> (await http.request<Preparation>('/api/v1/decision-simulations/preparations',{method:'POST',body:input})).body,
    progress:async(id)=> (await http.request<Preparation>(`/api/v1/decision-simulations/preparations/${encodeURIComponent(id)}`)).body,
    analyze:async(id,input)=> (await http.request<Preparation>(`/api/v1/decision-simulations/preparations/${encodeURIComponent(id)}/analyze`,{method:'POST',body:{confirm:true,input}})).body,
  };
  let draft=operatingExample('normal');
  let pending:{fingerprint:string;input:SimulationInput}|undefined;
  let busy=false;
  let preparation:Preparation|undefined;
  let savedRecord:SimulationRecord|undefined;
  let followProgress=true;
  let inputEdited=false;
  const scope=JSON.stringify([document.body.dataset.sessionWorkspaceId,document.body.dataset.sessionUserId]);
  host.innerHTML=`<section class="decision-simulation" aria-label="星盘决策模拟">
    <header class="decision-hero"><div><h2>星盘决策模拟</h2><p>相同经营起点 · 相同波动样本</p></div><div class="decision-view-switch"><button type="button" data-show-input aria-pressed="true">资料与校对</button><button type="button" data-show-report aria-pressed="false" disabled>结果与回放</button></div><span class="decision-mode">在营企业模式</span></header>
    <ol class="decision-workflow" aria-label="决策流程">${[['source','资料'],['facts','校对'],['agents','五角色'],['worlds','100情景'],['report','报告']].map(([key,label],index)=>`<li data-stage="${key}"><button type="button" data-step="${key}">${index+1}　${label}</button></li>`).join('')}</ol>
    <p class="decision-step-status" data-step-status role="status"></p>
    <section class="decision-source-panel" aria-label="企业资料上传"><h3>从企业资料开始</h3><p>上传资料 → 校对经营起点 → 五角色分析 → 100条平行路径 → 报告与回放</p>
      <label>选择企业文件<input type="file" multiple accept=".csv,.xls,.xlsx,.pdf,.docx" data-source-files></label><p>支持CSV、Excel、文本PDF、Word（DOCX），最多10份、合计5MB。扫描PDF暂不支持OCR。</p>
      <label><input type="checkbox" data-source-synthetic>这些是合成示例文件，不是真实企业资料</label><button type="button" data-source-inspect>读取所选资料</button> <button type="button" data-download-sample>下载合成企业资料CSV</button>
      <p role="status" data-source-status>资料读取不会调用模型或写入客户池。</p><div data-source-review></div>
      <label><input type="checkbox" data-model-consent>我已校对下方经营数据、应收应付与假设，同意将所选资料发送给当前配置模型进行五角色分析</label><div data-agent-progress aria-live="polite"></div>
    </section>
    <div class="decision-example-bar"><strong>没有资料？从示例开始</strong><button type="button" data-example="normal">正常经营</button><button type="button" data-example="cash">回款延迟</button><button type="button" data-example="capacity">产能受限</button><span>仅填入假设，不写CRM或正式财务</span></div>
    <div class="decision-workspace"><form aria-label="经营模拟输入"><h3>01 / 经营起点</h3><label>名称<input name="title" maxlength="100" required></label><div class="decision-fields">${fieldDefinitions.map(([key,label,isMoney])=>`<label>${label}<input name="${key}" type="number" step="${isMoney?'0.01':'1'}" ${key==='cashMinor'?'':'min="0"'} required></label>`).join('')}</div>
      <details><summary>应收应付、备选方案与波动假设</summary><p>金额以分记账；到期月1表示第一个模拟月。方案中的倍数1表示维持当前水平。修改JSON可比较最多3个备选方案。</p>
        <label>期初应收<textarea name="receivables" rows="3"></textarea></label><label>期初应付<textarea name="payables" rows="3"></textarea></label>
        <label>备选方案<textarea name="alternatives" rows="7"></textarea></label><label>随机样本与波动参数<textarea name="options" rows="9"></textarea></label>
      </details><label>资料性质<select name="dataKind"><option value="synthetic">示例 / 模拟数据</option><option value="user_defined">本人填写的经营数据</option></select></label><label>假设与来源说明<textarea name="assumptionNote" rows="3" maxlength="1000" required></textarea></label>
      <button class="decision-primary" type="submit">生成并保存对比</button><p role="status" data-status>示例已填入。点击生成后保存到本人决策记录，不影响客户池。</p>
    </form><aside><h3>最近决策记录</h3><button type="button" data-refresh-history>刷新记录</button><div data-history>正在读取…</div><div class="decision-boundary"><strong>当前模型口径</strong><p>现金为期初与月末余额；收入按交付确认，回款到期才计现金。直接成本当月支付。</p><p>不含库存、融资、税与折旧。样本范围不是置信区间，缺口样本占比不是现实失败概率。</p></div></aside></div>
    <section data-report aria-live="polite"><div class="decision-empty"><h3>你的第一个方案对照</h3><p>生成后查看现金下行、利润区间、积压、敏感因素和每月回放。</p></div></section>
  </section>`;
  const root=host.querySelector<HTMLElement>('.decision-simulation')!;
  let disposeReplay:(()=>void)|undefined;
  const workspace=root.querySelector<HTMLElement>('.decision-workspace')!;
  const sourcePanel=root.querySelector<HTMLElement>('.decision-source-panel')!;
  const fileList=document.createElement('ul');fileList.className='decision-source-files';fileList.setAttribute('aria-label','所选企业资料');
  const fileInput=root.querySelector<HTMLInputElement>('[data-source-files]')!;fileInput.closest('label')!.after(fileList);
  fileInput.onchange=()=>{clearPreparation(false);fileList.innerHTML=[...(fileInput.files??[])].map(file=>`<li><strong>${e(file.name)}</strong><small>${(file.size/1024).toFixed(1)} KB · 待读取</small></li>`).join('');};
  const clearFiles=document.createElement('button');clearFiles.type='button';clearFiles.textContent='清除资料选择';fileList.after(clearFiles);clearFiles.onclick=()=>{if(!busy)clearPreparation();};
  const inputForm=root.querySelector<HTMLFormElement>('form')!;
  const disabledControls=new Map<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement,boolean>();
  const lockInputs=(locked:boolean)=>{
    if(locked){workspace.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement>('input,textarea,select,button').forEach(item=>{disabledControls.set(item,item.disabled);item.disabled=true;});}
    else {disabledControls.forEach((disabled,item)=>{item.disabled=disabled;});disabledControls.clear();}
  };
  const submit=inputForm.querySelector<HTMLButtonElement>('button[type=submit]')!;
  inputForm.insertBefore(root.querySelector('[data-model-consent]')!.closest('label')!,submit);
  const agentProgress=root.querySelector<HTMLElement>('[data-agent-progress]')!;agentProgress.classList.add('decision-agent-progress');root.querySelector('.decision-workflow')!.after(agentProgress);
  workspace.prepend(sourcePanel);
  sourcePanel.append(workspace.querySelector('aside')!);
  const sourceInspector=document.createElement('aside');sourceInspector.className='decision-source-inspector';sourceInspector.innerHTML='<h3>来源核对</h3><p>读取文件后，选择经营字段查看原始位置与候选值。未识别不是零；请补充数据或注明假设。</p>';workspace.append(sourceInspector);
  const historyDisclosure=document.createElement('details');historyDisclosure.className='decision-history-disclosure';historyDisclosure.innerHTML='<summary>历史记录</summary>';historyDisclosure.append(sourcePanel.querySelector('aside')!);root.querySelector('.decision-hero')!.append(historyDisclosure);
  const sourceTitle=inputForm.querySelector('[name=title]')!.closest('label')!;sourcePanel.prepend(sourceTitle);
  const assumptions=inputForm.querySelector('[name=assumptionNote]')!.closest('label')!;
  inputForm.prepend(assumptions);inputForm.querySelector('h3')!.textContent='校对经营起点';
  const factDisclosure=document.createElement('details');factDisclosure.className='decision-fact-disclosure';factDisclosure.open=true;factDisclosure.innerHTML='<summary>经营起点 · 8项数据</summary>';
  inputForm.querySelector('.decision-fields')!.before(factDisclosure);factDisclosure.append(inputForm.querySelector('.decision-fields')!);
  const rolePreview=document.createElement('section');rolePreview.className='decision-role-preview';rolePreview.innerHTML='<h3>五位智能体共同分析</h3><div><span>经营负责人</span><span>市场</span><span>运营</span><span>财务</span><span>综合复核</span></div><p>使用设置中心当前已启用模型；实际服务商与型号随分析结果保存。</p>';inputForm.querySelector('[data-model-consent]')!.closest('label')!.before(rolePreview);
  const analysisHost=document.createElement('div');analysisHost.className='decision-analysis-host';workspace.before(analysisHost);
  const analysisView=mountDecisionAnalysis(analysisHost,()=>{if(!busy)inputForm.requestSubmit();});
  const showView=(view:'input'|'report'|'analysis')=>{root.dataset.view=view;historyDisclosure.open=false;analysisView.setActive(view==='analysis');root.querySelector('[data-show-input]')!.setAttribute('aria-pressed',String(view==='input'));root.querySelector('[data-show-report]')!.setAttribute('aria-pressed',String(view==='report'));if(view!=='report')root.querySelector('.decision-replay')?.dispatchEvent(new Event('decision-replay-pause'));root.scrollIntoView?.({block:'start',behavior:'instant'});};
  const stepStatus=root.querySelector<HTMLElement>('[data-step-status]')!;
  const stage=(name:string)=>{root.dataset.currentStep=name;root.querySelectorAll<HTMLElement>('[data-stage]').forEach(item=>{for(const node of [item,item.querySelector('button')!]){if(item.dataset.stage===name)node.setAttribute('aria-current','step');else node.removeAttribute('aria-current');}});};
  const navigate=(name:string)=>{
    followProgress=false;
    const savedNote=savedRecord?`保存版本：${savedRecord.input.title}。${inputEdited?'当前输入已修改，尚未重新生成；保存结果未改变。':'切换仅回看，不重新计算。'}`:'';
    let destination:HTMLElement|null=null;
    if(name==='source'||name==='facts'){
      showView('input');destination=name==='source'?sourcePanel:inputForm;
      stepStatus.textContent=(name==='facts'&&!preparation?'可校对手填经营数据；尚未读取文件来源。':'')+savedNote;
    }else if(name==='agents'&&preparation&&preparation.state!=='completed'){
      showView('analysis');stepStatus.textContent=preparation.state==='analyzing'?'分析仍在后台进行，切换不会取消或重复启动。':'当前资料分析状态；只有确认提交才会启动分析。';
    }else if(name==='agents'){
      analysisView.update({id:savedRecord?.runId??'preview',expiresAt:'',dataKind:savedRecord?.input.dataKind??'synthetic',state:'completed',files:savedRecord?.analysis?.files??[],sources:savedRecord?.analysis?.sources??[],facts:[],uncertain:savedRecord?.analysis?.uncertain??[],runId:savedRecord?.runId??null,errorCode:null,agents:savedRecord?.analysis?.agents??[]},savedRecord?.analysis?'history':'empty');
      showView('analysis');stepStatus.textContent=savedRecord?.analysis?`${savedNote}星系为历史查看，不重复分析。`:'五角色尚未就绪；当前为明确动效预览，未启动模型。';
    }else if(savedRecord){
      showView('report');destination=root.querySelector(name==='agents'?'.decision-agent-report':name==='worlds'?'.decision-replay':'.decision-report-header');
      stepStatus.textContent=savedNote+(name==='agents'&&!savedRecord.analysis?'这条保存记录未执行五角色分析。':'');
    }else{
      stepStatus.textContent=name==='agents'?'五角色尚未就绪：请读取资料、校对并确认模型分析。':'结果尚未就绪：请先生成并保存模拟；点击步骤不会启动任务。';
      return;
    }
    stage(name);destination?.scrollIntoView?.({block:'start',behavior:'instant'});
  };
  root.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(button=>button.onclick=()=>navigate(button.dataset.step!));
  root.querySelector<HTMLButtonElement>('[data-show-input]')!.onclick=()=>navigate('source');
  root.querySelector<HTMLButtonElement>('[data-show-report]')!.onclick=()=>navigate('report');
  const markEdited=()=>{if(savedRecord){inputEdited=true;stepStatus.textContent=`当前输入已修改，尚未重新生成；保存版本「${savedRecord.input.title}」及其结果未改变。`;}};
  workspace.addEventListener('input',markEdited);workspace.addEventListener('change',markEdited);
  showView('input');stage('source');
  const live=()=>root.isConnected&&scope===JSON.stringify([document.body.dataset.sessionWorkspaceId,document.body.dataset.sessionUserId]);
  const control=(name:string)=>root.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>(`[name="${name}"]`)!;
  const eventHost=document.createElement('section');eventHost.className='decision-event-editor';
  control('options').closest('details')!.after(eventHost);
  const eventEditor=mountEventEditor(eventHost,()=>JSON.parse(control('options').value),options=>{control('options').value=JSON.stringify(options,null,2);});
  const preferencesHost=document.createElement('section');eventHost.after(preferencesHost);
  const preferenceEditor=mountDecisionPreferences(preferencesHost);
  const memoryApi:DecisionMemoryApi|undefined=suppliedApi?.memory??(suppliedApi?undefined:createOperatingMemoryApi(http));
  const memoryHost=document.createElement('section');preferencesHost.after(memoryHost);
  const memoryView=memoryApi?mountDecisionMemory(memoryHost,memoryApi,{read:preferenceEditor.read,set:value=>{preferenceEditor.set(value);markEdited();}},live,(name,content)=>download(name,content,'application/json;charset=utf-8')):undefined;
  control('options').addEventListener('change',()=>eventEditor.sync());
  const status=root.querySelector<HTMLElement>('[data-status]')!;
  const sourceStatus=root.querySelector<HTMLElement>('[data-source-status]')!;
  const roleNames={founder:'经营负责人',market:'市场分析',operations:'运营分析',finance:'财务分析',judge:'综合复核'};
  const stateNames={queued:'待执行',running:'正在分析',completed:'已完成',insufficient:'资料不足',failed:'调用失败',cancelled:'已取消'};
  const inspectFact=(key:string)=>{
    const fact=preparation?.facts.find(item=>item.field===key);if(!preparation||!fact)return;
    const isMoney=fieldDefinitions.find(item=>item[0]===key)?.[2];
    sourceInspector.innerHTML=`<h3>来源核对</h3><strong>${e(fact.label)}</strong><p>${fact.status==='missing'?'未识别：请在经营起点填写，并注明来源或假设。':fact.status==='conflict'?'发现不同候选值，请核对单位与期间后选择。':'已提取候选值，仍需确认是否适用于本次模拟。'}</p>${fact.candidates.map((candidate,index)=>`<section><h4>候选 ${index+1}：${e(String(candidate.value/(isMoney?100:1)))}</h4>${candidate.sourceRefs.map(ref=>`<p><code>${e(ref)}</code><br>${e(preparation!.sources.find(source=>source.sourceRef===ref)?.text??'原引用未包含在本次读取范围')}</p>`).join('')}<button type="button" data-use-fact="${index}">使用此值</button></section>`).join('')}`;
    sourceInspector.querySelectorAll<HTMLButtonElement>('[data-use-fact]').forEach(button=>button.onclick=()=>{control(key).value=String(fact.candidates[Number(button.dataset.useFact)].value/(isMoney?100:1));control(key).focus({preventScroll:true});sourceStatus.textContent=`已选用${fact.label}候选值。请继续校对其他数据与假设。`;});
  };
  for(const [key]of fieldDefinitions)control(key).addEventListener('focus',()=>inspectFact(key));
  let shownAgents='';
  const clearPreparation=(clearFiles=true)=>{preparation=undefined;shownAgents='';agentProgress.innerHTML='';root.querySelector('[data-source-review]')!.innerHTML='';root.querySelector<HTMLInputElement>('[data-model-consent]')!.checked=false;fileList.innerHTML='';if(clearFiles)fileInput.value='';sourceInspector.innerHTML='<h3>来源核对</h3><p>读取文件后选择经营字段，查看对应原文与候选值。当前没有待确认资料会话。</p>';submit.textContent='生成并保存对比';sourceStatus.textContent=clearFiles?'当前为手填计算。需要五角色分析时，请重新选择并读取资料。':'文件已选择，尚未读取。请先读取资料，再启动五角色分析。';stage('source');};
  const showAgents=(current:Preparation)=>{
    preparation=current;analysisView.update(current);
    if(followProgress){if(root.dataset.view!=='analysis'&&current.state!=='completed')showView('analysis');stage(current.state==='completed'?'report':'agents');}
    const snapshot=JSON.stringify(current.agents);if(snapshot===shownAgents)return;shownAgents=snapshot;
    agentProgress.innerHTML=current.agents.map(agent=>`<article data-role-state="${e(agent.state)}"><strong>${e(roleNames[agent.role])}</strong><span>${e(stateNames[agent.state])}</span><small>${agent.model?e(`${agent.provider} / ${agent.model}`):'尚无模型结果'}</small></article>`).join('');
  };
  const download=(fileName:string,content:string,type:string)=>{
    const url=URL.createObjectURL(new Blob([content],{type}));const link=document.createElement('a');link.href=url;link.download=fileName;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  root.querySelector<HTMLButtonElement>('[data-download-sample]')!.onclick=()=>download('合成企业经营资料.csv','\uFEFF项目,值,单位\n资料性质,合成示例,非真实企业\n期初现金,60000,元\n月订单,100,件\n期初积压,0,件\n月产能,120,件\n销售单价,100,元\n单位直接成本,60,元\n月固定费用,2500,元\n基础回款周期,1,月\n应收应付,假设期初没有余额,请校对\n','text/csv;charset=utf-8');
  root.querySelector<HTMLButtonElement>('[data-source-inspect]')!.onclick=()=>{
    if(busy)return;const files=[...(root.querySelector<HTMLInputElement>('[data-source-files]')!.files??[])];
    if(!files.length||files.length>10||files.reduce((sum,file)=>sum+file.size,0)>5*1024*1024){sourceStatus.textContent='请选择1–10份文件，合计不超过5MB。';return;}
    busy=true;const button=root.querySelector<HTMLButtonElement>('[data-source-inspect]')!;button.disabled=true;sourceStatus.textContent='正在安全读取原始内容与位置…';
    void (async()=>{
      if(!api.prepare)throw new Error('资料读取接口不可用');
      const media:Record<string,SourceInput['files'][number]['mediaType']>={csv:'text/csv',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
      const body:SourceInput={dataKind:root.querySelector<HTMLInputElement>('[data-source-synthetic]')!.checked?'synthetic':'user_defined',files:[]};
      for(const file of files){const mediaType=media[file.name.split('.').at(-1)?.toLowerCase()??''];if(!mediaType)throw new Error(`不支持的文件类型：${file.name}`);
        const contentBase64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('文件读取失败'));reader.readAsDataURL(file);});body.files.push({fileName:file.name,mediaType,contentBase64});}
      const value=await api.prepare(body);if(!live())return;preparation=value;pending=undefined;
      fileList.innerHTML=value.files.map(file=>`<li><strong>${e(file.fileName)}</strong><small>已读取 · ${e(file.prefix)}</small></li>`).join('');
      control('title').value=files[0].name.replace(/\.[^.]+$/,'');control('dataKind').value=value.dataKind;
      control('assumptionNote').value='请校对：有明确来源的项目已填入；缺失项目须补充或明确假设。期初应收应付暂为空，不代表企业实际为零。波动区间为假设，非历史估计。';
      control('receivables').value='[]';control('payables').value='[]';
      control('alternatives').value='[]';
      root.querySelector<HTMLInputElement>('[data-model-consent]')!.checked=false;
      for(const[key,,isMoney]of fieldDefinitions){const fact=value.facts.find(item=>item.field===key);control(key).value=fact?.status==='candidate'?String(fact.candidates[0].value/(isMoney?100:1)):'';}
      inspectFact(value.facts.find(fact=>fact.status!=='candidate')?.field??'cashMinor');
      const options=JSON.parse(control('options').value);options.samples=100;control('options').value=JSON.stringify(options,null,2);
      root.querySelector<HTMLElement>('[data-source-review]')!.innerHTML=`<h3>请校对来源与缺项</h3>${value.facts.map(fact=>`<p><strong>${e(fact.label)}</strong> · ${fact.status==='missing'?'未识别：请在下方补充并说明假设':fact.status==='conflict'?'存在冲突：请核对期间和取值':'已提取，待确认'}<small>${fact.candidates.map(item=>e(item.sourceRefs.join(' · '))).join('<br>')}</small></p>`).join('')}<details><summary>查看原文件引用（${value.sources.length}项）</summary>${value.sources.map(source=>`<p><code>${e(source.sourceRef)}</code> ${e(source.text)}</p>`).join('')}</details>`;
      sourceStatus.textContent=`已读取${value.files.length}份资料。校对经营起点后，勾选模型确认并启动模拟。`;stage('facts');
      root.querySelector<HTMLButtonElement>('button[type=submit]')!.textContent='确认基线，启动五角色与100条模拟';
    })().catch(error=>{if(live())sourceStatus.textContent=`资料未读取：${error instanceof Error?error.message:'请求失败'}。原输入保留。`;}).finally(()=>{busy=false;if(live())button.disabled=false;});
  };
  const populate=()=>{
    control('title').value=draft.title; control('dataKind').value=draft.dataKind; control('assumptionNote').value=draft.assumptionNote;
    for(const [key,,isMoney] of fieldDefinitions) control(key).value=String(draft.baseline[key]/(isMoney?100:1));
    for(const key of ['receivables','payables'] as const) control(key).value=JSON.stringify(draft.baseline[key],null,2);
    control('alternatives').value=JSON.stringify(draft.alternatives,null,2); control('options').value=JSON.stringify(draft.options,null,2);
    eventEditor.sync();
    preferenceEditor.set(draft.decisionPreferences);
  };
  const showError=(error:unknown)=>{status.textContent=`操作未完成：${error instanceof Error?error.message:'请求失败'}。输入和已有结果已保留，可重试。`;};
  async function history() {
    const target=root.querySelector<HTMLElement>('[data-history]')!;
    try {
      const items=await api.list(); if(!live()) return;
      target.innerHTML=items.length?items.map(item=>`<button type="button" data-run="${e(item.runId)}"><strong>${e(item.title)}</strong><small>${item.dataKind==='synthetic'?'示例':'本人数据'} · ${e(new Date(item.createdAt).toLocaleDateString())}</small></button>`).join(''):'<p>暂无已保存记录</p>';
      target.querySelectorAll<HTMLButtonElement>('[data-run]').forEach(button=>button.onclick=()=>{if(busy)return; void api.get(button.dataset.run!).then(record=>{if(!live())return;clearPreparation();draft=structuredClone(record.input);populate();renderReport(record);status.textContent='已读取保存版本，没有重新计算。';}).catch(error=>{if(live())showError(error);});});
    } catch { if(live())target.textContent='记录读取失败，可点击刷新；不会切换成演示记录。'; }
  }
  function renderReport(record:SimulationRecord) {
    savedRecord=record;inputEdited=false;
    disposeReplay?.();
    const report=record.report;
    const target=root.querySelector<HTMLElement>('[data-report]')!;
    target.innerHTML=`<header class="decision-report-header"><div><span class="decision-eyebrow">02 / 同路径方案对照</span><h3>${e(record.input.title)}</h3><p>${record.input.dataKind==='synthetic'?'明确示例，非真实企业结果':'用户填写数据'} · ${record.input.options.samples}个样本 × ${record.input.options.months}个月 · seed ${record.input.options.seed}</p></div><small>${e(report.modelVersion)}</small></header>
      <div class="decision-results">${report.plans.map(plan=>`<article><span>${e(plan.planId==='baseline'?'维持现状':plan.planId)}</span><h4>¥ ${money(plan.worstMinimumCashMinor)}</h4><p>样本最差月末现金</p><dl><div><dt>累计经营利润范围</dt><dd>¥ ${money(plan.profitRangeMinor[0])}–${money(plan.profitRangeMinor[1])}</dd></div><div><dt>资金缺口样本</dt><dd>${plan.samplesWithFundingGap} / ${plan.sampleCount}</dd></div><div><dt>交付积压样本</dt><dd>${plan.samplesWithBacklog} / ${plan.sampleCount}</dd></div><div><dt>最大积压</dt><dd>${plan.maximumBacklogUnits} 件</dd></div></dl></article>`).join('')}</div>
      <div class="decision-threshold"><strong>基线月经营盈亏平衡</strong><span>${report.threshold.unitsForMonthlyOperatingBreakEven===null?'单位贡献不足，没有有限的平衡交付量':`${report.threshold.unitsForMonthlyOperatingBreakEven} 件交付 / 月 · ${report.threshold.withinBaselineCapacity?'基线产能可覆盖':'超过基线产能'}`}</span><p>条件：基线价格、单位成本与固定费用不变，无波动。这不是现金平衡点。</p></div>
      <details><summary>敏感性 · 哪个因素改变结果？</summary><p>条件性单因素扰动，其余路径固定；不是因果归因或全局方差分析。</p><div class="decision-table-wrap"><table><thead><tr><th>因素扰动</th><th>方案</th><th>最差月末现金</th><th>利润范围</th></tr></thead><tbody>${report.sensitivity.flatMap(change=>change.plans.map(plan=>`<tr><td>${e(({demand:'需求',procurement:'采购成本',collectionDelay:'回款周期',delivery:'交付效率'})[change.factor])} ${change.direction==='up'?'+':'−'}${change.factor==='collectionDelay'?'1月':'10%'}</td><td>${e(plan.planId==='baseline'?'维持现状':plan.planId)}</td><td>¥ ${money(plan.worstMinimumCashMinor)}</td><td>¥ ${money(plan.profitRangeMinor[0])}–${money(plan.profitRangeMinor[1])}</td></tr>`)).join('')}</tbody></table></div></details>
      <h3>03 / 月度回放</h3><div class="decision-replay-controls"><label>方案<select data-replay-plan>${report.replays.map((plan,index)=>`<option value="${index}">${e(plan.planId==='baseline'?'维持现状':plan.planId)}</option>`).join('')}</select></label><label>样本<select data-replay-sample>${record.paths.map((_,index)=>`<option value="${index}">样本 ${index+1}</option>`).join('')}</select></label></div><div data-replay-table></div>`;
    const replay=()=>{
      const plan=Number(target.querySelector<HTMLSelectElement>('[data-replay-plan]')!.value)||0;
      const sample=Number(target.querySelector<HTMLSelectElement>('[data-replay-sample]')!.value)||0;
      target.querySelector<HTMLElement>('[data-replay-table]')!.innerHTML=`<div class="decision-table-wrap"><table><thead><tr><th>月</th><th>订单 / 交付</th><th>积压</th><th>收入</th><th>回款</th><th>支付</th><th>期末应收</th><th>月末现金</th></tr></thead><tbody>${report.replays[plan].samples[sample].months.map(month=>`<tr><td>M${month.month}</td><td>${month.orders} / ${month.delivered}</td><td>${month.backlogUnits}</td><td>${money(month.revenueMinor)}</td><td>${money(month.receiptsMinor)}</td><td>${money(month.paymentsMinor)}</td><td>${money(month.receivablesMinor)}</td><td>${money(month.cashMinor)}</td></tr>`).join('')}</tbody></table></div>`;
    };
    const replayHost=document.createElement('div');
    target.querySelector('.decision-report-header')!.after(replayHost);
    disposeReplay=mountDecisionReplay(replayHost,record,(plan,sample)=>{
      target.querySelector<HTMLSelectElement>('[data-replay-plan]')!.value=String(plan);
      target.querySelector<HTMLSelectElement>('[data-replay-sample]')!.value=String(sample);
      replay();
    });
    const evidence=document.createElement('section');evidence.className='decision-agent-report';
    const roleEvidence=record.analysis?.agents.map(agent=>`<details><summary><strong>${e(roleNames[agent.role])} · ${e(stateNames[agent.state])}</strong><small>${e(agent.provider??'')} / ${e(agent.model??'')}</small></summary>${agent.observations.map(observation=>`<p>${e(observation.text)}</p><details class="decision-source-evidence"><summary>查看依据（${observation.sourceRefs.length}项）</summary>${observation.sourceRefs.map(ref=>`<p><code>${e(ref)}</code><br>${e(record.analysis!.sources.find(source=>source.sourceRef===ref)?.text??'此引用未保存在当前报告中')}</p>`).join('')}</details>`).join('')}</details>`).join('');
    evidence.innerHTML=`<button type="button" data-export-report>导出完整报告HTML</button><h3>五角色决策分析</h3>${record.analysis?`<p>file为原资料引用，confirmed为人工确认条件，calc为规则计算；模型负责解释，不生成计算数值。</p>${roleEvidence}`:'<p>这条记录是手填计算，未执行上传资料的五角色分析。</p>'}`;
    const insights=document.createElement('div');insights.className='decision-insights';
    replayHost.after(insights);insights.append(evidence,target.querySelector('.decision-threshold')!);
    insights.insertAdjacentHTML('afterend',renderOperatingRecommendations(report.recommendations));
    if(memoryView){const reviews=document.createElement('section');target.append(reviews);memoryView.showReport(reviews,record);}
    target.querySelector('.decision-report-header')!.insertAdjacentHTML('afterend',renderPreferenceAssessment(record));
    evidence.querySelector<HTMLButtonElement>('[data-export-report]')!.onclick=()=>download('Shensi-星盘决策模拟报告.html',renderDecisionExport(record),'text/html;charset=utf-8');
    target.querySelector('.decision-report-header')!.append(evidence.querySelector('[data-export-report]')!);
    const edit=document.createElement('button');edit.type='button';edit.textContent='编辑经营起点';edit.onclick=()=>navigate('facts');target.querySelector('.decision-report-header')!.append(edit);
    const summary=document.createElement('div');summary.className='decision-summary-strip';
    const firstPlan=report.plans[0];
    if(firstPlan)summary.innerHTML=`<div><span>当前基线</span><strong>${e(firstPlan.planId==='baseline'?'维持现状':firstPlan.planId)}</strong></div><div><span>样本最差月末现金</span><strong class="${firstPlan.worstMinimumCashMinor<0?'decision-negative':''}">¥ ${money(firstPlan.worstMinimumCashMinor)}</strong></div><div><span>累计经营利润范围</span><strong>¥ ${money(firstPlan.profitRangeMinor[0])}–${money(firstPlan.profitRangeMinor[1])}</strong></div><div><span>资金缺口样本</span><strong>${firstPlan.samplesWithFundingGap} / ${firstPlan.sampleCount}</strong></div><p>样本统计，不代表现实发生概率。</p>`;
    target.querySelector('.decision-report-header')!.after(summary);
    target.querySelector('.decision-results')!.innerHTML=`<h3>方案对比 · 相同条件情景</h3><div class="decision-table-wrap"><table><thead><tr><th>方案</th><th>最差月末现金（元）</th><th>经营利润范围（元）</th><th>缺口样本</th><th>最大积压</th></tr></thead><tbody>${report.plans.map(plan=>`<tr><td>${e(plan.planId==='baseline'?'维持现状':plan.planId)}</td><td class="${plan.worstMinimumCashMinor<0?'decision-negative':''}">${money(plan.worstMinimumCashMinor)}</td><td>${money(plan.profitRangeMinor[0])}–${money(plan.profitRangeMinor[1])}</td><td>${plan.samplesWithFundingGap}/${plan.sampleCount}</td><td>${plan.maximumBacklogUnits}件</td></tr>`).join('')}</tbody></table></div>`;
    target.querySelectorAll<HTMLElement>('.decision-results h4').forEach((heading,index)=>{if(report.plans[index].worstMinimumCashMinor<0)heading.classList.add('decision-negative');});
    target.querySelectorAll<HTMLSelectElement>('.decision-replay-controls select').forEach(select=>select.onchange=replay); replay();
    root.querySelector<HTMLButtonElement>('[data-show-report]')!.disabled=false;
    if(!busy||followProgress){stage('report');showView('report');}
    stepStatus.textContent=`保存版本：${record.input.title}。可点击五步回看，不会重新计算。`;
  }
  root.querySelectorAll<HTMLButtonElement>('[data-example]').forEach(button=>button.onclick=()=>{
    if(busy)return;clearPreparation(); draft=operatingExample(button.dataset.example as 'normal'|'cash'|'capacity');pending=undefined;populate();status.textContent='手填示例已填入，尚未计算或保存。此入口不执行五角色资料分析。';root.querySelector<HTMLButtonElement>('button[type=submit]')!.textContent='生成并保存对比';
  });
  root.querySelector<HTMLButtonElement>('[data-refresh-history]')!.onclick=()=>void history();
  root.querySelector('form')!.onsubmit=event=>{
    event.preventDefault(); if(busy)return;
    if(!preparation&&fileInput.files?.length){status.textContent='所选文件尚未读取。请先读取资料；或清除资料选择后使用手填计算。';return;}
    if(preparation&&!root.querySelector<HTMLInputElement>('[data-model-consent]')!.checked){status.textContent='请先校对数据与假设，再勾选资料模型分析确认。';return;}
    let input:SimulationInput;
    try {
      input=structuredClone(draft);input.title=control('title').value;input.dataKind=control('dataKind').value as SimulationInput['dataKind'];input.assumptionNote=control('assumptionNote').value;
      const preferences=preferenceEditor.read();if(preferences)input.decisionPreferences=preferences;else delete input.decisionPreferences;
      for(const [key,,isMoney] of fieldDefinitions) {const raw=control(key).value;const value=Number(raw);if(!raw.trim()||!Number.isFinite(value)||(!isMoney&&!Number.isInteger(value)))throw new Error('请填写有效数字，件数和月份必须为整数'); input.baseline[key]=Math.round(value*(isMoney?100:1));}
      input.baseline.receivables=JSON.parse(control('receivables').value);input.baseline.payables=JSON.parse(control('payables').value);
      input.alternatives=JSON.parse(control('alternatives').value);input.options=JSON.parse(control('options').value);
      const fingerprint=JSON.stringify({...input,runId:''});
      if(pending?.fingerprint===fingerprint)input=pending.input;
      else {input.runId=crypto.randomUUID();pending={fingerprint,input};}
    } catch(error){showError(error);return;}
    followProgress=true;busy=true;lockInputs(true);const button=root.querySelector<HTMLButtonElement>('button[type=submit]')!;button.disabled=true;root.setAttribute('aria-busy','true');status.textContent=preparation?'正在执行五角色分析，完成后计算并保存100条情景…':'正在计算并保存…';stage(preparation?'agents':'worlds');root.scrollIntoView?.({block:'start',behavior:'instant'});
    const execute=async()=>{
      if(!preparation)return api.create(input);
      if(!api.analyze||!api.progress)throw new Error('分析接口不可用');
      let current=await api.analyze(preparation.id,input);showAgents(current);
      while(current.state==='analyzing'){
        if(!live())throw new Error('页面已离开，任务成功后可从最近记录查看');
        await new Promise(resolve=>setTimeout(resolve,1200));if(!live())throw new Error('页面已离开');
        current=await api.progress(current.id);if(live())showAgents(current);
      }
      if(current.state!=='completed'||!current.runId)throw new Error(current.errorCode??'分析未完成');
      return api.get(current.runId);
    };
    void execute().then(record=>{if(!live())return;renderReport(record);status.textContent='已保存完整输入、假设、随机路径和结果，可从最近记录重新打开。';void history();}).catch(error=>{if(live()){showError(error);if(followProgress&&preparation?.state!=='failed')showView('input');}}).finally(()=>{busy=false;if(live()){lockInputs(false);button.disabled=false;root.removeAttribute('aria-busy');}});
  };
  populate(); void history();
}
