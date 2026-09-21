import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { monthFactors, renderReplayExplanation, replayComparison } from './replay-explanation';
import { operatingExample, type SimulationRecord } from './samples';

function record():SimulationRecord {
  const month={month:1,orders:80,delivered:60,backlogUnits:20,revenueMinor:600000,receiptsMinor:1200000,paymentsMinor:1446000,profitMinor:-46000,cashMinor:5754000,receivablesMinor:600000,shock:{demand:.8,procurement:1.1,delivery:.5,collectionDelay:2}};
  return {runId:'12345678-1234-1234-1234-123456789012',createdAt:'2026-09-18T00:00:00Z',recordVersion:'decision-simulation.v1',input:operatingExample('normal'),paths:[[month.shock]],report:{modelVersion:'operating-monthly-v1',plans:[],replays:[{planId:'baseline',modelVersion:'operating-monthly-v1',samples:[{months:[month],minimumCashMinor:5754000,totalProfitMinor:-46000,fundingGapMinor:0}]}],sensitivity:[],threshold:{unitsForMonthlyOperatingBreakEven:63,withinBaselineCapacity:true,conditions:'test'}}};
}
test('saved shocks explain their own month, actual cash flow and profit without allocating causal amounts',()=>{
  const data=record(),month=data.report.replays[0].samples[0].months[0];
  assert.deepEqual(monthFactors(month),['需求-20%','采购成本+10%','交付效率-50%','回款延后2月']);
  const text=parseHTML(`<main>${renderReplayExplanation(data,0,0,0)}</main>`).document.querySelector('main')!.textContent!;
  assert.match(text,/M4回款/);assert.match(text,/-2,460/);assert.match(text,/-460/);
});
test('missing historical shocks show unavailable rather than invent events; input notes are escaped',()=>{
  const data=record();Reflect.deleteProperty(data.report.replays[0].samples[0].months[0],'shock');
  data.input.assumptionNote='<img src=x onerror=alert(1)>';
  assert.equal(monthFactors(data.report.replays[0].samples[0].months[0]),null);
  const html=renderReplayExplanation(data,0,0,0),{document}=parseHTML(html);
  assert.match(html,/未保存完整因素/);assert.equal(document.querySelector('img'),null);
  assert.doesNotMatch(html,/安排在M\d+回款/);
});
test('paired comparisons verify the full saved shock path and show cash and profit differences',()=>{
  const data=record();data.report.replays.push(structuredClone(data.report.replays[0]));
  data.report.replays[1].planId='方案二';
  data.report.replays[1].samples[0].months[0].cashMinor+=10000;
  data.report.replays[1].samples[0].months[0].profitMinor+=5000;
  assert.match(replayComparison(data,1,0,0,0),/相同已保存波动路径/);
  assert.match(replayComparison(data,1,0,0,0),/现金差额 ¥100.*利润差额 ¥50/);
  data.report.replays[1].samples[0].months[0].shock.demand=.7;
  assert.match(replayComparison(data,1,0,0,0),/波动路径不一致或缺失/);
});
test('realized events expose the replaced background value, duration and explicit assumption',()=>{
  const data=record();data.report.replays[0].samples[0].months[0].shock.events=[{template:'staffing_shortage',startMonth:1,durationMonths:2,value:.5,probability:.25,backgroundValue:.9,assumption:'合成缺勤假设'}];
  const {document}=parseHTML(`<main>${renderReplayExplanation(data,0,0,0)}</main>`);
  assert.match(document.querySelector('[data-realized-events]')!.textContent!,/M1–M2.*0.900被0.5替代.*合成缺勤假设/);
});
