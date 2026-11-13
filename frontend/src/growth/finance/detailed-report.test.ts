import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { enterpriseReportHtml } from './enterprise-analysis';
import { financeReportFixture } from './report-fixture';
import { validateCouncilReportRequest } from '../../../../desktop/src/shared/council-report';

test('export keeps currencies separate and passes the existing static PDF boundary', () => {
  const input = financeReportFixture();
  input.cells.push(...financeReportFixture('USD').cells.map(cell => ({...cell, sheetName:'USD', sourceRef:cell.sourceRef+'-usd'})));
  const html = enterpriseReportHtml(input, '财务经营');
  validateCouncilReportRequest({html, filename:'synthetic.pdf'});
  const {document} = parseHTML(html);
  const charts = [...document.querySelectorAll('.report-chart')];
  assert.equal(charts.length, 2);
  assert.match(charts[0].textContent!, /2026-09 · CNY/);
  assert.match(charts[1].textContent!, /2026-09 · USD/);
  for (const chart of charts) assert.deepEqual([...chart.querySelectorAll('.report-kpis strong')].map(el=>el.textContent), ['1,200,000','720,000','180,000','96,000']);
});

test('missing amounts do not draw zeros; actual negative and zero amounts remain visible', () => {
  const input=financeReportFixture();
  input.cells=[];
  let {document}=parseHTML(enterpriseReportHtml(input,'财务经营'));
  assert.equal(document.querySelectorAll('.report-chart').length,0);
  assert.ok(document.querySelector('.report-empty'));
  const signed=financeReportFixture();
  signed.cells.find(cell=>'row' in cell && cell.row===4 && cell.column===2)!.text='-180000';
  signed.cells.find(cell=>'row' in cell && cell.row===5 && cell.column===2)!.text='0';
  ({document}=parseHTML(enterpriseReportHtml(signed,'财务经营')));
  assert.equal(document.querySelector('.report-bar-negative')?.getAttribute('style'),'width:15%');
  assert.deepEqual([...document.querySelectorAll('.report-kpis strong')].map(el=>el.textContent),['1,200,000','720,000','-180,000','0']);
});

test('long source and analysis are preserved as text without executable markup', () => {
  const input=financeReportFixture();
  const text='<script>alert("source")</script> & 合成原文'.repeat(100);
  input.cells[0].text=text;
  input.detailedReport!.sections[0].interpretation[0].text=text;
  const html=enterpriseReportHtml(input,'财务经营');
  validateCouncilReportRequest({html,filename:'long.pdf'});
  const {document}=parseHTML(html);
  assert.equal(document.querySelectorAll('script').length,0);
  assert.ok(document.querySelector('.report-appendix')?.textContent?.includes(text));
  assert.ok(document.querySelector('.report-analysis')?.textContent?.includes(text));
});
