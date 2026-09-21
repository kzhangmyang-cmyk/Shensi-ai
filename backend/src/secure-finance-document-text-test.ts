import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectFinanceTextDocument } from './secure-finance-document-text.js';
import { syntheticPdf, syntheticDocx, syntheticChinesePdf, syntheticZip } from './secure-finance-document-text-test-fixtures.js';

test('PDF preserves page and item source references, including skipped empty pages', async () => {
  const result = await inspectFinanceTextDocument({ content: syntheticPdf(['Revenue 123.45', '', 'Cost 67.89']), mediaType: 'application/pdf' });
  assert.deepEqual(result.cells, [
    { sourceRef: 'pdf:1:1', page: 1, item: 1, text: 'Revenue 123.45' },
    { sourceRef: 'pdf:3:1', page: 3, item: 1, text: 'Cost 67.89' }
  ]);
  assert.ok(result.uncertain.includes('pdf_pages_without_text'));
  assert.match(result.fileHash, /^sha256:[a-f0-9]{64}$/);
});

test('DOCX keeps paragraph positions and real table row/cell positions', async () => {
  const content = syntheticDocx('<w:p><w:r><w:t>合成利润说明</w:t></w:r></w:p><w:p/>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>收入</w:t></w:r></w:p></w:tc>'
    + '<w:tc><w:p><w:r><w:t>123.45 元</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '<w:p><w:r><w:t>仅供核对</w:t></w:r></w:p>');
  const result = await inspectFinanceTextDocument({ content, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.deepEqual(result.cells, [
    { sourceRef: 'docx:p:1', paragraph: 1, text: '合成利润说明' },
    { sourceRef: 'docx:t:1:1:1', table: 1, row: 1, column: 1, text: '收入' },
    { sourceRef: 'docx:t:1:1:2', table: 1, row: 1, column: 2, text: '123.45 元' },
    { sourceRef: 'docx:p:3', paragraph: 3, text: '仅供核对' }
  ]);
});

test('Chinese PDF resolves deployed CID CMaps without external fonts or network', async () => {
  const result = await inspectFinanceTextDocument({ content: syntheticChinesePdf(), mediaType: 'application/pdf' });
  assert.equal(result.cells.map(cell => cell.text).join(''), '营业收入');
  assert.equal(result.cells[0].sourceRef, 'pdf:1:1');
});

test('long source text is losslessly segmented with UTF16 offsets, never misreported as scanned', async () => {
  const text = '财务原文😀 含空格 '.repeat(70);
  const result = await inspectFinanceTextDocument({ content: syntheticDocx(`<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.equal(result.cells.map(cell => cell.text).join(''), text);
  result.cells.forEach((cell, index) => {
    assert.equal(cell.sourceRef, `docx:p:1:s:${index + 1}`);
    assert.equal(cell.segment, index + 1);
    assert.equal(cell.startOffset, index ? result.cells[index - 1].endOffset : 0);
    assert.equal(cell.text, text.slice(cell.startOffset, cell.endOffset));
    assert.ok(cell.text.length <= 500);
    assert.ok(!/[\uD800-\uDBFF]$/u.test(cell.text));
  });
  assert.ok(result.uncertain.includes('document_text_segmented'));
});

test('DOCX text accepts XML CDATA and keeps the visible cached field result only', async () => {
  const result = await inspectFinanceTextDocument({ content: syntheticDocx('<w:p><w:r><w:instrText>DO NOT EXECUTE</w:instrText><w:t><![CDATA[原值 12.34]]></w:t></w:r></w:p>'), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.equal(result.cells[0].text, '原值 12.34');
});

test('rejects missing text, format spoofing, legacy DOC, unsafe XML and fixed resource limits', async () => {
  const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const cases: Array<[Buffer, string, string]> = [
    [Buffer.from('not a pdf'), 'application/pdf', 'finance_document_artifact_invalid'],
    [Buffer.from('%PDF-1.7 broken'), 'application/pdf', 'finance_document_artifact_invalid'],
    [syntheticPdf(['']), 'application/pdf', 'finance_document_text_unavailable'],
    [syntheticPdf(Array.from({ length: 101 }, () => 'x')), 'application/pdf', 'finance_document_limit_exceeded'],
    [Buffer.alloc(5 * 1024 * 1024 + 1), 'application/pdf', 'finance_document_limit_exceeded'],
    [Buffer.from('legacy'), 'application/msword', 'finance_document_format_unsupported'],
    [syntheticDocx('<w:p><w:r><w:drawing/></w:r></w:p>'), docx, 'finance_document_text_unavailable'],
    [syntheticDocx('<w:p><w:r><w:t>broken</w:p>'), docx, 'finance_document_artifact_invalid'],
    [syntheticZip([['word/document.xml', '<w:document/>']]), docx, 'finance_document_artifact_invalid'],
    [syntheticDocx('<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><w:p><w:r><w:t>&y;</w:t></w:r></w:p>'), docx, 'finance_document_artifact_invalid'],
    [syntheticDocx('<w:p/>', [['word/media/oversized.bin', 'x'.repeat(21 * 1024 * 1024)]]), docx, 'finance_document_limit_exceeded'],
    [syntheticDocx('<w:p/>', Array.from({ length: 1001 }, (_, i) => [`extra-${i}`, ''])), docx, 'finance_document_limit_exceeded']
  ];
  for (const [content, mediaType, code] of cases) await assert.rejects(inspectFinanceTextDocument({ content, mediaType }), { code });
});

test('PDF long item offsets rejoin original text and source budget discloses truncation', async () => {
  const text = 'A'.repeat(639);
  const result = await inspectFinanceTextDocument({ content: syntheticPdf([text]), mediaType: 'application/pdf' });
  assert.equal(result.cells.map(cell => cell.text).join(''), text);
  assert.equal(result.cells[1].sourceRef, 'pdf:1:1:s:2');
  assert.equal(result.cells[1].startOffset, 500);
  assert.equal(result.cells[1].endOffset, 639);
  const limited = await inspectFinanceTextDocument({ content: syntheticDocx('<w:p><w:r><w:t>原值</w:t></w:r></w:p>'.repeat(2001)), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.equal(limited.cells.length, 2000);
  assert.ok(limited.uncertain.includes('inspection_truncated'));
});

test('caller cancellation terminates an in-flight parser without returning a result', async () => {
  const controller = new AbortController();
  const pending = inspectFinanceTextDocument({ content: syntheticPdf(['x']), mediaType: 'application/pdf', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('Word field cached display remains readable but is explicitly unverified, never recalculated', async () => {
  const result = await inspectFinanceTextDocument({ content: syntheticDocx('<w:p><w:fldSimple w:instr="=1+1"><w:r><w:t>999</w:t></w:r></w:fldSimple></w:p>'), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.equal(result.cells[0].text, '999');
  assert.ok(result.uncertain.includes('docx_field_cache_unverified'));
});

test('hard worker deadline rejects and terminates parsing even without cooperative cancellation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = inspectFinanceTextDocument({ content: syntheticPdf(['x']), mediaType: 'application/pdf' });
  const check = assert.rejects(pending, { code: 'finance_document_limit_exceeded' });
  context.mock.timers.tick(10_000);
  await check;
});
