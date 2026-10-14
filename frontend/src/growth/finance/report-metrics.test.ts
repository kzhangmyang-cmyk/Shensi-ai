import assert from 'node:assert/strict';
import test from 'node:test';
import {financeReportFixture} from './report-fixture';
import {reportMetrics} from './report-metrics';
test('explicit amounts retain currency and period, without invented growth',()=>{
  for(const currency of ['CNY','USD']) {
    const metrics=reportMetrics(financeReportFixture(currency));
    assert.deepEqual(metrics.map(m=>m.amount),[1200000,720000,180000,96000]);
    assert.ok(metrics.every(m=>m.currency===currency && m.period==='2026-09' && m.sourceRefs.length===5));
  }
});
test('missing values, unit, period and cached formulas are not zeros',()=>{
  for(const [column,text] of [[2,''],[2,'未知'],[3,''],[4,'待确认'],[5,'万元']] as const){
    const source=financeReportFixture();
    source.cells.find(c=>'row' in c&&c.row===2&&c.column===column)!.text=text;
    assert.equal(reportMetrics(source).some(m=>m.label==='营业收入'),false);
  }
  const source=financeReportFixture();source.cells=[];assert.deepEqual(reportMetrics(source),[]);
  const cached=financeReportFixture();const cell=cached.cells.find(c=>'row' in c&&c.row===2&&c.column===2)!;
  if('sheetName' in cell)cell.valueStatus='cached_formula';assert.equal(reportMetrics(cached).length,3);
});
test('conflicts disappear and currencies are never combined',()=>{
  const source=financeReportFixture();
  source.cells.push(...source.cells.filter(c=>'row' in c&&c.row===2).map(c=>({...c,row:8,sourceRef:c.sourceRef+'-copy',text:'column' in c&&c.column===2?'999':c.text})));
  assert.equal(reportMetrics(source).some(m=>m.label==='营业收入'),false);
  const mixed=financeReportFixture();mixed.cells.push(...financeReportFixture('USD').cells.map(c=>({...c,sheetName:'USD',sourceRef:c.sourceRef+'-usd'})));
  assert.equal(reportMetrics(mixed).length,8);
});
