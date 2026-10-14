import type { FinanceDocumentInspection } from './api';
import {reportMetrics,metricAmount} from './report-metrics';
export {detailedReportStyle} from './detailed-report-style';

const escape = (value: string) => value.replace(/[&<>"']/gu, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]!);
const titles = {overview:'经营概况',income:'收入质量',cost:'成本与费用',profit:'利润形成',cashflow:'现金流',comparison:'可比口径',actions:'行动计划'};
const coverage = {supported:'资料支持',partial:'部分资料支持',insufficient:'待补充资料'};

/** One semantic report for preview, HTML and PDF. No external assets or scripts. */
export function detailedReportBody(value: FinanceDocumentInspection): string {
  const report=value.detailedReport;
  if(!report)throw new Error('detailed_report_missing');
  const names=new Map(value.cells.map(cell=>[cell.sourceRef,value.files?.filter(file=>cell.sourceRef.startsWith(file.prefix)).sort((a,b)=>b.prefix.length-a.prefix.length)[0]?.fileName??value.fileName]));
  const refs=new Map(value.cells.map((cell,i)=>[cell.sourceRef,i+1]));
  const reference=(items:string[])=>items.length?`<span class="report-ref"> ${items.map(ref=>refs.has(ref)?`[${refs.get(ref)}]`:'[来源未包含]').join(' ')}</span>`:'';
  const block=(items:typeof report.sections[number]['evidence'])=>items.map(item=>`<p>${escape(item.text)}${reference(item.sourceRefs)}</p>`).join('')||'<p class="report-muted">当前未提供。</p>';
  const overview=report.sections.find(section=>section.id==='overview');
  const metrics=reportMetrics(value);
  const groups=new Map<string,typeof metrics>();
  for(const metric of metrics){const key=`${metric.period} · ${metric.currency}`;groups.set(key,[...(groups.get(key)??[]),metric]);}
  const chart=[...groups].map(([label,items])=>{
    const max=Math.max(...items.map(item=>Math.abs(item.amount)),1);
    return `<section class="report-chart"><h3>${escape(label)} <span>单位：主币单位</span></h3><div class="report-kpis">${items.map(item=>`<div><span>${escape(item.label)}</span><strong>${metricAmount(item)}</strong>${reference(item.sourceRefs)}</div>`).join('')}</div><div class="report-bars" aria-label="原始金额对比">${items.map(item=>`<div class="report-bar-row"><span>${escape(item.label)}</span><div class="report-bar-track"><div class="report-bar${item.amount<0?' report-bar-negative':''}" style="width:${Math.abs(item.amount)/max*100}%"></div></div><b>${metricAmount(item)}</b></div>`).join('')}</div><p class="report-caption">图示原表金额，不作加总；条长按金额绝对值比例绘制，负值标为红色。收入、成本、利润与现金流不是可直接相加的组成项。</p></section>`;
  }).join('');
  const sourceRows = new Map<string, typeof value.cells>();
  for(const cell of value.cells){const key='sheetName' in cell?JSON.stringify([names.get(cell.sourceRef),cell.sheetName,cell.row]):cell.sourceRef;sourceRows.set(key,[...(sourceRows.get(key)??[]),cell]);}
  const location=(cell:typeof value.cells[number])=>'sheetName' in cell?`${cell.sheetName} · 第${cell.row}行`:'page' in cell?`第${cell.page}页`:'paragraph' in cell?`第${cell.paragraph}段`:`表${cell.table} · 第${cell.row}行`;
  return `<div class="enterprise-report"><header class="report-cover"><div class="report-brand">SHENSI <span>燊锶 · 经营洞察</span></div><p class="report-eyebrow">FINANCIAL &amp; OPERATING REVIEW</p><h1>财务经营报告</h1><p class="report-source-name">${escape(value.fileName)}</p><p class="report-scope">${groups.size?[...groups.keys()].map(escape).join(' / '):'期间与币种：当前资料未形成可绘图口径'}</p></header>
    <section class="report-executive"><h2><span>01</span> 执行摘要</h2><div class="report-lead">${overview?block(overview.evidence):'<p>现有资料不足以形成经营结论。</p>'}</div><h3>判断与关注点</h3>${overview?block(overview.interpretation):'<p>请补充收入、成本与现金流资料。</p>'}<div class="report-priority"><b>建议先做</b>${overview?block(overview.action):'<p>先核对来源、期间与币种，再分析经营表现。</p>'}</div></section>
    <section class="report-metrics"><h2><span>02</span> 关键指标与经营表现</h2>${chart||'<div class="report-empty"><h3>本次不绘制金额图表</h3><p>缺少可直接核对的指标、金额、币种、期间或单位。以下保留有来源的定性分析，不将缺失金额填为零，也不从模型文字推算图表。</p></div>'}</section>
    <div class="report-analysis"><h2><span>03</span> 经营解释与行动建议</h2>${report.sections.map(section=>`<section class="report-chapter" id="report-${escape(section.id)}"><div class="report-chapter-heading"><h3>${titles[section.id]}</h3><span class="report-coverage">${coverage[section.coverage]}</span></div><div class="report-evidence"><b>资料记载</b>${block(section.evidence)}</div><div><b>分析判断</b>${block(section.interpretation)}</div><div class="report-action"><b>建议与复核</b>${block(section.action)}</div></section>`).join('')||'<p>尚无有来源的分析内容。</p>'}</div>
    <section class="report-appendix"><h2><span>04</span> 数据口径与来源附录</h2><div class="report-method"><p>报告基于选中资料的只读分析，不是审计鉴证报告。资料记载、分析判断与行动建议分别呈现；金额图表仅摘录明确列有指标、金额、币种、期间、单位的原始表格，缓存公式、冲突或不明确值不绘图。</p><p>不同币种、期间分别展示，不折算、不混加。缺失项目不视为零；无可比资料不计算同比、环比或行业排名。</p></div><h3>公开行业依据</h3>${report.research?`<p>${escape(report.research.query)} · ${escape(report.research.retrievedAt)}</p>${report.research.sources.filter(s=>report.research!.citationIds.includes(s.id)).map(s=>`<article><b>${escape(s.title)}</b><p>${escape(s.snippet)}</p><p class="report-caption">${escape(s.url)} · ${escape(s.fetchedAt)}</p></article>`).join('')}<p>以上是公开搜索摘要，不等于企业事实或经核验行业基准。</p>`:'<p>本次未提供可引用的公开行业依据，不形成同行排名或基准结论。</p>'}<h3>原始资料索引</h3><table><thead><tr><th>文件与位置</th><th>原始内容与引用编号</th></tr></thead><tbody>${[...sourceRows.values()].map(cells=>`<tr><td>${escape(names.get(cells[0].sourceRef)??value.fileName)}<span class="report-location">${escape(location(cells[0]))}</span></td><td>${cells.map(cell=>`<p><span class="report-ref">[${refs.get(cell.sourceRef)}]</span> ${escape(cell.text)}${'valueStatus' in cell&&cell.valueStatus==='cached_formula'?'（缓存显示，未重算）':''}<span class="report-source-code">${escape(cell.sourceRef)}</span></p>`).join('')}</td></tr>`).join('')||'<tr><td colspan="2">未提供可引用的原始资料。</td></tr>'}</tbody></table></section><footer class="report-end">SHENSI · 燊锶经营洞察 <span>资料核对是行动决策的前提</span></footer></div>`;
}
