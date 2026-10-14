import test from 'node:test';
import assert from 'node:assert/strict';
import {renderOperatingRecommendations} from './recommendations';
import {renderDecisionExport} from './export';
import {operatingExample,type SimulationRecord} from './samples';

test('structured saved recommendations share evidence, actions and review in screen and export',()=>{
  const record:SimulationRecord={runId:'fixture',createdAt:'2026-09-18',recordVersion:'decision-simulation.v1',input:operatingExample('normal'),paths:[],report:{modelVersion:'test',plans:[],replays:[],sensitivity:[],threshold:{unitsForMonthlyOperatingBreakEven:1,withinBaselineCapacity:true,conditions:'fixed'},recommendations:[{id:'procurement',title:'采购试点',priority:'normal',evidenceKind:'simulation_signal',evidence:'单位成本来自确认输入',evidenceRefs:['input.baseline.unitCostMinor'],action:'<script>试单</script>',mechanism:'减少合格品成本',costAndPrerequisites:'质量标准不变，先询价',ownerRole:'采购负责人',timeframe:'14日',reviewMetric:'不良率和单位全成本',validation:'pilot_required',scenarioComparison:{label:'条件性10%扰动',baselineProfitRangeMinor:[100,200],changedProfitRangeMinor:[200,300],baselineWorstCashMinor:0,changedWorstCashMinor:100}}]}};
  const screen=renderOperatingRecommendations(record.report.recommendations);
  assert.match(screen,/采购负责人/);assert.match(screen,/质量标准/);assert.match(screen,/不良率/);assert.match(screen,/input.baseline.unitCostMinor/);assert.match(screen,/1.00.*2.00/);
  assert.doesNotMatch(screen,/<script>/);assert.match(screen,/&lt;script&gt;/);
  assert.ok(renderDecisionExport(record).includes(screen));
  assert.match(renderOperatingRecommendations(undefined),/未保存/);
  assert.doesNotMatch(renderOperatingRecommendations(undefined),/采购试点/);
});
