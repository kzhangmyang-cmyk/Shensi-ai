import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDecisionExport } from './export';
import { operatingExample, type SimulationRecord } from './samples';
test('export preserves report version and sources while escaping uploaded HTML',()=>{
  const record:SimulationRecord={runId:'fixture',createdAt:'2026-09-15T00:00:00Z',recordVersion:'decision-simulation.v1',input:operatingExample('normal'),paths:[],
    report:{modelVersion:'operating-monthly-v1',plans:[],replays:[],sensitivity:[],threshold:{unitsForMonthlyOperatingBreakEven:63,withinBaselineCapacity:true,conditions:'fixed'}},
    analysis:{files:[{fileName:'<script>alert(1)</script>.csv',fileHash:'hash',prefix:'file:1:'}],sources:[{sourceRef:'file:1:cell:1:1:1',text:'<img src=x onerror=alert(1)>'}],agents:[],uncertain:[]}};
  const html=renderDecisionExport(record);
  assert.match(html,/decision-simulation.v1/);
  assert.match(html,/file:1:cell:1:1:1/);
  assert.match(html,/&lt;img/);
  assert.doesNotMatch(html,/<script|<img/);
  assert.match(html,/合成示例/);
  assert.match(html,/seed/);
  assert.match(html,/<title>[^<]*星盘决策模拟/);
});
