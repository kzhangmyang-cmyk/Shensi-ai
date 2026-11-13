import type {components} from '../generated/system-reference';
type Topic=components['schemas']['ReferenceTopicId'];
const labels:Record<Topic,string>={budget_variance:'预算偏差',budget_planning:'预算编制',cost_driver:'成本动因',cost_structure:'成本结构',cashflow_forecast:'现金流预测',working_capital:'营运资金',profitability_analysis:'盈利分析',break_even:'盈亏平衡',statement_analysis:'报表分析',ratio_analysis:'财务比率',tax_document_review:'税务资料核对',tax_risk_review:'税务风险核对'};
export function mountReferenceTopics(host:HTMLElement){
  const doc=host.ownerDocument,selected=new Set<Topic>();let disabled=false;
  const details=doc.createElement('details'),summary=doc.createElement('summary');summary.textContent='默认参考库主题（可选）';
  const note=doc.createElement('p');note.textContent='最多选择3个通用主题；不选时仅在本机匹配固定词表，不向中央书库发送原问题。';
  const group=doc.createElement('fieldset'),legend=doc.createElement('legend');legend.textContent='选择本题参考主题';group.append(legend);
  const inputs=new Map<Topic,HTMLInputElement>();
  const render=()=>{for(const [topic,input] of inputs){input.checked=selected.has(topic);input.disabled=disabled||selected.size>=3&&!selected.has(topic);}};
  const change=(event:Event)=>{const input=event.target as HTMLInputElement,topic=input.dataset.referenceTopic as Topic;if(inputs.get(topic)!==input)return;
    if(!disabled){if(!input.checked)selected.delete(topic);else if(selected.size<3)selected.add(topic);}render();};
  for(const [topic,label] of Object.entries(labels) as [Topic,string][]){const row=doc.createElement('label'),input=doc.createElement('input');input.type='checkbox';input.dataset.referenceTopic=topic;inputs.set(topic,input);row.append(input,doc.createTextNode(label));group.append(row);}
  group.addEventListener('change',change);details.append(summary,note,group);host.replaceChildren(details);
  return {value:():Topic[]|undefined=>selected.size?[...selected]:undefined,setDisabled(value:boolean){disabled=value;render();},clear(){selected.clear();render();},dispose(){group.removeEventListener('change',change);host.replaceChildren();}};
}
