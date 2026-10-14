import { escapeHtml as e } from '../demo/demo-ui';
import type { SimulationRecord } from './samples';
import {renderOperatingRecommendations} from './recommendations';
import {renderPreferenceAssessment} from './preferences';
const money=(minor:number)=>(minor/100).toFixed(2);
export function renderDecisionExport(record:SimulationRecord):string{
  const json=(value:unknown)=>`<pre>${e(JSON.stringify(value,null,2))}</pre>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${e(record.input.title)} · 星盘决策模拟报告</title><style>body{font:15px/1.7 system-ui;max-width:1100px;margin:40px auto;padding:20px;color:#18362a}table{width:100%;border-collapse:collapse;font-size:12px}td,th{border:1px solid #ccd9d1;padding:8px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f6f3;padding:16px}small{color:#536f60}details{margin:16px 0}h2{margin-top:36px}</style>
    <p>星盘决策模拟 · 经营分析报告</p><h1>${e(record.input.title)}</h1><p>${record.input.dataKind==='synthetic'?'合成示例，非真实企业经营结论':'用户确认的企业资料与假设'} · ${e(record.createdAt)}</p><p>记录 ${e(record.runId)} · ${e(record.recordVersion)} · ${e(record.report.modelVersion)} · seed ${record.input.options.seed}</p>
    <h2>经营基线与假设</h2><p>${e(record.input.assumptionNote)}</p>${json(record.input)}
    <h2>五角色分析</h2>${record.analysis?record.analysis.agents.map(agent=>`<section><h3>${e(agent.role)} · ${e(agent.state)}</h3><small>${e(agent.provider??'')} / ${e(agent.model??'')}</small>${agent.observations.map(observation=>`<p>${e(observation.text)}<br><small>来源 ${e(observation.sourceRefs.join('、'))}</small></p>`).join('')}</section>`).join(''):'<p>此记录来自手填计算，未执行资料智能体分析。</p>'}
    <h2>方案比较</h2><table><tr><th>方案</th><th>最差月末现金（元）</th><th>经营利润范围（元）</th><th>缺口样本</th><th>最大积压</th></tr>${record.report.plans.map(plan=>`<tr><td>${e(plan.planId)}</td><td>${money(plan.worstMinimumCashMinor)}</td><td>${plan.profitRangeMinor.map(money).join(' – ')}</td><td>${plan.samplesWithFundingGap}/${plan.sampleCount}</td><td>${plan.maximumBacklogUnits}</td></tr>`).join('')}</table>
    <h2>敏感因素、临界点与逐样本差值</h2>${json({threshold:record.report.threshold,sensitivity:record.report.sensitivity,pairedDifferences:record.report.plans.map(plan=>({planId:plan.planId,differencesMinor:plan.pairedProfitDifferenceMinor}))})}
    ${renderOperatingRecommendations(record.report.recommendations)}
    ${renderPreferenceAssessment(record)}
    <h2>全部路径月度回放</h2>${record.report.replays.map(plan=>`<h3>${e(plan.planId)}</h3>${plan.samples.map((sample,index)=>`<details><summary>样本 ${index+1}</summary><table><tr><th>月</th><th>订单</th><th>交付</th><th>积压</th><th>收入</th><th>回款</th><th>支付</th><th>应收</th><th>现金（元）</th></tr>${sample.months.map(month=>`<tr><td>${month.month}</td><td>${month.orders}</td><td>${month.delivered}</td><td>${month.backlogUnits}</td><td>${money(month.revenueMinor)}</td><td>${money(month.receiptsMinor)}</td><td>${money(month.paymentsMinor)}</td><td>${money(month.receivablesMinor)}</td><td>${money(month.cashMinor)}</td></tr>`).join('')}</table></details>`).join('')}`).join('')}
    <details><summary>完整外生路径与计算快照（金额以分保存）</summary>${json({paths:record.paths,replays:record.report.replays})}</details>
    <h2>资料来源与限制</h2>${record.analysis?`${json(record.analysis.files)}<p>${e(record.analysis.uncertain.join('、'))}</p><p>file引用为原资料；confirmed为用户确认的模拟条件；calc为确定性算法结果，不是原始经营事实。</p><details><summary>原资料、人工确认与规则计算引用</summary>${record.analysis.sources.map(source=>`<p><strong>${e(source.sourceRef)}</strong> ${e(source.text)}</p>`).join('')}</details>`:'<p>没有上传资料，来源以人工输入及假设说明为准。</p>'}
    <p>样本范围不是置信区间，资金缺口样本占比不是现实失败概率。现金检查期初与月末，不涵盖月内峰值；成本按交付月支付，不含库存、融资、税及折旧。规则计算与模型解释分别呈现。资料引用不是审计认证。</p></html>`;
}
