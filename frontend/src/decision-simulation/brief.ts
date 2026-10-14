import { escapeHtml as e } from '../demo/demo-ui';
import type { SimulationRecord } from './samples';

const money = (value: number) => (value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Rec = NonNullable<SimulationRecord['report']['recommendations']>[number];

function timelineFrom(record: SimulationRecord, rec: Rec) {
  const baseline = record.report.plans[0];
  const worst = baseline?.worstMinimumCashMinor ?? 0;
  const gap = baseline?.samplesWithFundingGap ?? 0;
  const cashTarget = worst < 0 ? Math.abs(worst) : Math.round((baseline?.worst5PctMeanCashMinor ?? worst) * 0.05);
  return [
    { when: '第1月', goal: `把现金红线盯住：账上不低于 ¥${money(Math.max(0, worst < 0 ? 0 : worst * 0.8))}`, owner: rec.ownerRole || '财务', cost: '内部工时为主', cash: worst < 0 ? `优先回笼约 ¥${money(cashTarget)}` : '维持安全垫', review: '月末复盘现金与回款' },
    { when: '第2–3月', goal: rec.action, owner: rec.ownerRole || '经营负责人', cost: rec.costAndPrerequisites, cash: gap > 0 ? `把缺口情景占比从 ${gap}/${baseline?.sampleCount ?? 0} 往下压` : '巩固正现金情景', review: rec.reviewMetric },
    { when: '第4–6月', goal: '验证试点是否达到目标数字，再决定扩产/提价/收缩', owner: '经营负责人 + 财务', cost: '试点投入按方案单列', cash: '对比试点前后最差5%现金', review: '季度经营会' },
    { when: '下半年', goal: '按达标路径放大，或在岔路口切换备用方案', owner: '经营负责人', cost: '按放大节奏追加', cash: '以现金红线为硬约束', review: '半年度复盘' },
  ];
}

export function renderDecisionBrief(record: SimulationRecord): string {
  const plans = record.report.plans;
  const baseline = plans[0];
  const best = [...plans].sort((a, b) => b.worstMinimumCashMinor - a.worstMinimumCashMinor)[0];
  const worst = [...plans].sort((a, b) => a.worstMinimumCashMinor - b.worstMinimumCashMinor)[0];
  const conclusion = worst.worstMinimumCashMinor < 0
    ? `在当前假设下，「${worst.planId === 'baseline' ? '维持现状' : worst.planId}」最坏现金可能为负；更稳的是「${best.planId === 'baseline' ? '维持现状' : best.planId}」。先守住回款与现金，再谈扩张。`
    : `在当前假设下各方案最坏现金仍为正；可优先推进「${best.planId === 'baseline' ? '维持现状' : best.planId}」，并盯住最差5%现金。`;
  const external = record.report.externalFactorImpact ?? [];
  const recommendations = record.report.recommendations ?? [];
  const redLine = baseline?.worst5PctMeanCashMinor ?? baseline?.worstMinimumCashMinor ?? 0;
  const forks = [
    { if: '信贷收紧 / 续贷失败', then: '暂停扩产与大促，优先缩短账期、砍低毛利SKU，动用现金红线预案' },
    { if: '大客户拖欠 / 坏账抬头', then: '切换预收款或分批发货，下调该客户敞口，启动备选渠道订单' },
  ];

  const timelineHtml = recommendations.length
    ? recommendations.map(rec => {
        const steps = timelineFrom(record, rec);
        return `<section class="brief-path"><h3>${e(rec.title)}</h3><p>${e(rec.evidence)}</p><ol>${steps.map(step => `<li><strong>${e(step.when)}</strong><div>目标：${e(step.goal)}</div><div>负责人：${e(step.owner)} · 成本：${e(step.cost)}</div><div>现金影响：${e(step.cash)}</div><div>复盘：${e(step.review)}</div></li>`).join('')}</ol>
          <p><strong>前进条件：</strong>${e(rec.reviewMetric)} 达预期，且最差5%现金不低于红线。</p></section>`;
      }).join('')
    : `<section class="brief-path"><h3>通用稳健路径</h3><ol>
        <li><strong>第1月</strong><div>目标：摸清回款与现金红线</div><div>负责人：财务</div></li>
        <li><strong>第2–3月</strong><div>目标：压缺口情景、清积压</div><div>负责人：经营负责人</div></li>
        <li><strong>第4–6月</strong><div>目标：小范围试点后再放大</div><div>负责人：经营负责人 + 财务</div></li>
        <li><strong>下半年</strong><div>目标：按达标路径扩张或收缩</div><div>负责人：经营负责人</div></li>
      </ol></section>`;

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${e(record.input.title)} · 星盘简报</title>
<style>
  body{font:14px/1.6 system-ui,-apple-system,sans-serif;max-width:900px;margin:32px auto;padding:24px;color:#14261c;background:#fff}
  h1{font-size:22px;margin:0 0 8px} h2{font-size:16px;margin:28px 0 10px;border-bottom:1px solid #d7e3db;padding-bottom:6px} h3{font-size:15px;margin:0 0 8px}
  .banner{padding:14px 16px;border-left:4px solid #1bbf7a;background:#f2fbf6;margin:16px 0;border-radius:6px}
  table{width:100%;border-collapse:collapse;font-size:12px;margin:12px 0} th,td{border:1px solid #d0ddd5;padding:8px;text-align:left}
  .redline{padding:12px 14px;background:#fff5f3;border:1px solid #f0c2b8;border-radius:6px;margin:12px 0}
  .brief-path{border:1px solid #d7e3db;border-radius:8px;padding:14px;margin:12px 0}
  .brief-path ol{margin:8px 0 0;padding-left:18px} .brief-path li{margin:10px 0}
  .meta{color:#5b7264;font-size:12px} @media print{body{margin:0;padding:12px} .no-print{display:none}}
</style>
<p class="meta">星盘决策模拟 · 一页简报 · ${e(record.input.dataKind === 'synthetic' ? '示例数据' : '本人数据')} · ${e(record.report.modelVersion)} · seed ${record.input.options.seed}</p>
<h1>${e(record.input.title)}</h1>
<div class="banner"><strong>一句话结论：</strong>${e(conclusion)}</div>
${external.length ? `<p><strong>外部环境里影响较大：</strong>${external.map(item => e(item.label)).join('、')}</p>` : ''}
<h2>方案对比</h2>
<table><thead><tr><th>方案</th><th>最坏现金</th><th>最差5%平均现金</th><th>利润区间</th><th>缺钱情景</th></tr></thead>
<tbody>${plans.map(plan => `<tr><td>${e(plan.planId === 'baseline' ? '维持现状' : plan.planId)}</td><td>¥ ${money(plan.worstMinimumCashMinor)}</td><td>¥ ${money(plan.worst5PctMeanCashMinor ?? plan.worstMinimumCashMinor)}</td><td>¥ ${money(plan.profitRangeMinor[0])}–${money(plan.profitRangeMinor[1])}</td><td>${plan.samplesWithFundingGap}/${plan.sampleCount}</td></tr>`).join('')}</tbody></table>
<div class="redline"><strong>现金红线：</strong>建议把「最差5%平均现金」¥ ${money(redLine)} 作为盯盘线；跌破则触发岔路口预案。</div>
<h2>详细建议路径</h2>
${timelineHtml}
<h2>岔路口</h2>
<ul>${forks.map(item => `<li><strong>若 ${e(item.if)}</strong> → ${e(item.then)}</li>`).join('')}</ul>
<p class="meta no-print">可直接打印或导出为 PDF（浏览器/桌面打印 → 存储为 PDF）。本简报由规则从模拟结果生成，不依赖模型。</p>
<script>window.addEventListener('load',()=>{document.title=${JSON.stringify('星盘简报')}+' · '+${JSON.stringify('')};});</script>
</html>`;
}
