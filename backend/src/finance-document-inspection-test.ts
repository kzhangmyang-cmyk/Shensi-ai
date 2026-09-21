import assert from 'node:assert/strict';
import test from 'node:test';
import XLSX from 'xlsx-js-style';
import { inspectFinanceDocument } from './finance-document-inspection.js';

const mediaType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function workbook(rows: unknown[][]) {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Table1');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
test('recognizes balance and income regions within one generic sheet without requiring cashflow or ledger commit', () => {
  const rows: unknown[][] = Array.from({ length: 72 }, () => []);
  rows[0] = ['资产负债表']; rows[1] = ['单位：元'];
  rows[2] = ['资产', '行次', '期末余额', '年初余额', '负债', '行次', '期末余额', '年初余额'];
  rows[3] = ['货币资金', 1, 1234.56, 1000]; rows[37] = ['资产总计', 38, 5000];
  rows[38] = ['单位：元']; rows[39] = ['项目', '行次', '本年累计金额'];
  rows[40] = ['营业收入', 1, 2000]; rows[41] = ['营业成本', 2, 1200]; rows[71] = ['净利润', 32, 800];
  const value = inspectFinanceDocument({ content: workbook(rows), mediaType });
  assert.equal(value.classification, 'financial_statements');
  assert.deepEqual(value.regions.map(region => region.kind), ['balance_sheet', 'income_statement']);
  assert.deepEqual(value.missingStatements, ['cash_flow_statement']);
  assert.equal(value.modelStatus, 'not_requested'); assert.deepEqual(value.observations, []);
  assert.equal(value.cells.find(cell => cell.text === '营业收入')?.sourceRef, 'cell:1:41:1');
  assert.equal(value.regions[1].headerRow, 40);
  assert.equal(value.cells.find(cell => cell.sourceRef === 'cell:1:4:3')?.text, '1234.56');
  assert.ok(value.uncertain.includes('currency_not_verified'), 'unit yuan alone must not infer a currency code');
});
test('CSV cells remain exact strings; unknown documents and ambiguous headers stay unknown', () => {
  const value = inspectFinanceDocument({ content: Buffer.from('说明,数值\n不明条目,"1,234.00"\n'), mediaType: 'text/csv' });
  assert.equal(value.classification, 'unknown'); assert.equal(value.regions[0].kind, 'unknown');
  assert.equal(value.cells.find(cell => cell.sourceRef === 'cell:1:2:2')?.text, '1,234.00');
  assert.deepEqual(value.missingStatements, ['balance_sheet', 'income_statement', 'cash_flow_statement']);
  assert.ok(value.uncertain.includes('unit_not_verified'));
});
test('recognizes numbered income and deduction account labels under the physical row 40 header without changing source cells', () => {
  const rows: unknown[][] = Array.from({ length: 72 }, () => []);
  rows[0] = ['资产负债表'];
  rows[2] = ['资产', '行次', '期末余额', '年初余额'];
  rows[34] = ['资产总计', 35, 5000, 4000];
  rows[35] = ['利润表'];
  rows[39] = ['项目', null, null, null, null, '行次', null, '本年累计金额', null, null, '上年金额'];
  rows[40] = ['一、营业收入', null, null, null, null, 1, null, 2000, null, null, 1800];
  rows[41] = ['减：营业成本', null, null, null, null, 2, null, 1200, null, null, 1100];
  rows[71] = ['净利润', null, null, null, null, 32, null, 800, null, null, 700];
  const value = inspectFinanceDocument({ content: workbook(rows), mediaType });
  assert.deepEqual(value.regions.map(({ kind, startRow, endRow, headerRow }) => ({ kind, startRow, endRow, headerRow })), [
    { kind: 'balance_sheet', startRow: 1, endRow: 35, headerRow: 3 },
    { kind: 'income_statement', startRow: 36, endRow: 72, headerRow: 40 },
  ]);
  assert.deepEqual(value.regions[1].uncertain, []);
  assert.ok(value.regions[1].sourceRefs.includes('cell:1:40:8'));
  assert.ok(value.regions[1].sourceRefs.includes('cell:1:40:11'));
  assert.equal(value.cells.find(cell => cell.sourceRef === 'cell:1:41:1')?.text, '一、营业收入');
  assert.equal(value.cells.find(cell => cell.sourceRef === 'cell:1:42:1')?.text, '减：营业成本');
  assert.equal(value.cells.find(cell => cell.sourceRef === 'cell:1:42:8')?.text, '1200');
  assert.equal(value.cells.find(cell => cell.sourceRef === 'cell:1:42:11')?.text, '1100');
  assert.deepEqual(value.missingStatements, ['cash_flow_statement']);
});
test('account-prefix recognition cannot promote remarks or incomplete account labels into income evidence', () => {
  for (const [income, cost] of [
    ['备注：一、营业收入', '减：营业成本'],
    ['一、营业收入待核对', '减：营业成本'],
    ['一、营业收入', '减：营业成本待核对'],
    ['一、营业收入', '减营业成本'],
    ['其他项目', '其他成本'],
  ]) {
    const value = inspectFinanceDocument({ content: workbook([
      ['项目', '本年累计金额', '备注'],
      [income, 2000, '一、营业收入'], [cost, 1200, '减：营业成本'],
    ]), mediaType });
    assert.equal(value.regions[0].kind, 'unknown', `${income} / ${cost} are not exact income and cost accounts`);
    assert.equal(value.regions[0].headerRow, null);
  }
});
test('header classification uses exact account labels, never financial keywords in remarks', () => {
  const content = workbook([['项目', '本年累计金额', '备注'], ['营业收入', 1000, '经营活动回款尚待核对'],
    ['营业成本', 600], ['备注：经营活动回款尚待核对']]);
  const value = inspectFinanceDocument({ content, mediaType });
  assert.equal(value.regions[0].kind, 'income_statement');
  assert.deepEqual(value.missingStatements, ['balance_sheet', 'cash_flow_statement']);
  const cash = inspectFinanceDocument({ content: workbook([['项目', '本期金额', '备注'],
    ['经营活动现金流入', 900, '营业收入和营业成本尚待核对']]), mediaType });
  assert.equal(cash.regions[0].kind, 'cash_flow_statement');
});
test('bound public cells and label formula cache as unverified without recalculating it', () => {
  const book = XLSX.utils.book_new(); const sheet = XLSX.utils.aoa_to_sheet([['资产负债表'], ['项目', '余额'], ['公式缓存', 999], ['长文本', 'x'.repeat(501)]]);
  sheet.B3.f = '1+1'; XLSX.utils.book_append_sheet(book, sheet, 'Table1');
  const value = inspectFinanceDocument({ content: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), mediaType });
  assert.equal(value.cells.find(cell => cell.text === '999')?.valueStatus, 'cached_formula');
  assert.equal(value.cells.some(cell => cell.text.length > 500), false);
  assert.ok(value.uncertain.includes('formula_cache_unverified'));
  assert.ok(value.uncertain.includes('cell_text_omitted'));
});
test('public source inventory is bounded and uncached formula results remain unknown', () => {
  const large = inspectFinanceDocument({ content: Buffer.from(Array.from({ length: 2100 }, (_, i) => `项目${i},${i}`).join('\n')), mediaType: 'text/csv' });
  assert.equal(large.cells.length, 2000); assert.ok(large.uncertain.includes('inspection_truncated'));
  const book = XLSX.utils.book_new(); const sheet = XLSX.utils.aoa_to_sheet([['资料'], ['未缓存公式']]);
  sheet.B2 = { t: 'n', f: '123+456' }; sheet['!ref'] = 'A1:B2'; XLSX.utils.book_append_sheet(book, sheet, 'Table1');
  const value = inspectFinanceDocument({ content: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), mediaType });
  assert.equal(value.cells.some(cell => cell.sourceRef === 'cell:1:2:2'), false);
  assert.ok(value.uncertain.includes('formula_value_unknown'));
  const repeated = inspectFinanceDocument({ content: Buffer.from(Array.from({ length: 201 }, () => '资产负债表').join('\n')), mediaType: 'text/csv' });
  assert.equal(repeated.regions.length, 200); assert.ok(repeated.uncertain.includes('inspection_truncated'));
});
