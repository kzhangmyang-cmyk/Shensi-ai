import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createKnowledgeReader, knowledgeReaderEnvironment } from './reader-gateway.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syntheticPdf, syntheticDocx, syntheticZip } from '../secure-finance-document-text-test-fixtures.js';

const python = process.env.SHENSI_TEST_KNOWLEDGE_PYTHON;
const script = resolve('../services/knowledge-reader/shensi_knowledge_reader.py');
test('knowledge reader environment never inherits model, DB, account or search credentials', () => {
  const env = knowledgeReaderEnvironment();
  for (const key of ['JWT_SECRET', 'DATABASE_URL', 'AGENT_JOB_ENCRYPTION_KEY', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'PYTHONPATH']) assert.equal(env[key], undefined);
  assert.equal(env.HF_HUB_OFFLINE, '1'); assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
});
test('knowledge reader rejects missing trusted runtime before opening private files', async () => {
  const reader = createKnowledgeReader({});
  await assert.rejects(reader.read({ inputPath: '/not-read', format: 'txt', bytes: 1 }, new AbortController().signal), /knowledge_reader_unavailable/);
});
test('knowledge reader actual formats keep physical page and document coordinates', { skip: !python && 'explicit installed reader Python not configured' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'shensi-knowledge-reader-')); t.after(() => rm(root, { recursive: true, force: true }));
  const reader = createKnowledgeReader({ python, script });
  const formats = [
    ['pdf', syntheticPdf(['Budget page one', 'Budget page two', 'Budget page three'])],
    ['docx', syntheticDocx('<w:p><w:r><w:t>合成预算</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>回款</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')],
    ['csv', Buffer.from('项目,金额\n预算,120\n')], ['txt', Buffer.from('预算现金流\n回款目标')], ['md', Buffer.from('# 全面预算\n现金流与回款')],
    ['xlsx', syntheticZip([
      ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'],
      ['xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="预算" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
      ['xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="3"><c r="B3"><f>SUM(B1:B2)</f><v>120</v></c></row></sheetData></worksheet>'],
    ])],
  ] as const;
  for (const [format, content] of formats) {
    const inputPath = join(root, `original.${format}`); await writeFile(inputPath, content, { mode: 0o600 });
    const parsed = await reader.read({ inputPath, format, bytes: content.length }, new AbortController().signal)
      .catch(error => { error.message = `${format}: ${error.message}`; throw error; });
    assert.ok(parsed.chunks.length); assert.equal(parsed.chunks.every((chunk, index) => chunk.order === index), true);
    if (format === 'pdf') { assert.equal(parsed.coverage.totalPages, 3); assert.deepEqual(parsed.chunks.map(chunk => chunk.locator.page), [1, 2, 3]); }
    if (format === 'docx') assert.deepEqual(parsed.chunks.at(-1)?.locator, { table: 1, row: 1, column: 1 });
    if (format === 'xlsx') { assert.equal(parsed.chunks[0].locator.row, 3); assert.equal(parsed.chunks[0].locator.column, 2); assert.ok(parsed.chunks[0].warnings.includes('formula_cached_unverified')); }
  }
});
test('knowledge malformed ZIP/XML, invalid output and abort are finite and fail closed', { skip: !python && 'explicit installed reader Python not configured' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'shensi-knowledge-reader-invalid-')); t.after(() => rm(root, { recursive: true, force: true }));
  const reader = createKnowledgeReader({ python, script });
  const content = syntheticDocx('<!DOCTYPE bad [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:p>&x;</w:p>');
  const inputPath = join(root, 'original.docx'); await writeFile(inputPath, content, { mode: 0o600 });
  await assert.rejects(reader.read({ inputPath, format: 'docx', bytes: content.length }, new AbortController().signal), /knowledge_artifact_invalid/);
  const fake = join(root, 'fake.py'); await writeFile(fake, 'import time\ntime.sleep(10)\n');
  const interrupted = createKnowledgeReader({ python, script: fake });
  const controller = new AbortController(); const pending = interrupted.read({ inputPath, format: 'docx', bytes: content.length }, controller.signal);
  setTimeout(() => controller.abort(), 30); await assert.rejects(pending, /knowledge_reader_cancelled/);
});
test('macOS reader sandbox blocks unrelated file contents and network without disabling extraction', { skip: !python || process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'shensi-knowledge-sandbox-')); t.after(() => rm(root, { recursive: true, force: true }));
  const secretPath = join(root, 'not-authorized.txt'), inputPath = join(root, 'original.txt'), fake = join(root, 'probe.py');
  await writeFile(secretPath, 'synthetic-private-sentinel', { mode: 0o600 }); await writeFile(inputPath, 'ok', { mode: 0o600 });
  await writeFile(fake, `import json, pathlib, socket\nwarnings=[]\ntry:\n pathlib.Path(${JSON.stringify(secretPath)}).read_text()\nexcept PermissionError:\n warnings.append("other_file_blocked")\ntry:\n socket.create_connection(("127.0.0.1", 1), timeout=1)\nexcept PermissionError:\n warnings.append("network_blocked")\nprint(json.dumps({"ok":True,"result":{"parserVersion":"synthetic","coverage":{"totalPages":None,"extractedPages":None,"missingPages":[]},"warnings":warnings,"chunks":[{"order":0,"text":"synthetic","locator":{},"warnings":[]}]}}))\n`);
  const result = await createKnowledgeReader({ python, script: fake }).read({ inputPath, format: 'txt', bytes: 2 }, new AbortController().signal);
  assert.deepEqual(result.warnings.sort(), ['network_blocked', 'other_file_blocked']);
});
test('actual macOS sandboxed scan, readable encryption marker, password and missing-page provenance', { skip: !python || process.platform !== 'darwin', timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'shensi-knowledge-reader-fixtures-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'native.pdf'), syntheticPdf(['Synthetic BUDGET CASH FLOW reference']), { mode: 0o600 });
  await promisify(execFile)(python!, ['-I', '-B', resolve('../services/knowledge-reader/tests/make_fixtures.py'), root], { env: knowledgeReaderEnvironment(), timeout: 10000 });
  const reader = createKnowledgeReader({ python, script, maxDurationMs: 60_000 });
  const read = async (filename: string) => { const inputPath = join(root, filename); await chmod(inputPath, 0o600);
    return reader.read({ inputPath, format: 'pdf', bytes: (await stat(inputPath)).size }, new AbortController().signal); };
  const readable = await read('readable-marker.pdf'); assert.ok(readable.chunks[0].text.includes('BUDGET'));
  await assert.rejects(read('password.pdf'), /knowledge_password_required/);
  const scan = await read('scanned.pdf'); assert.ok(scan.chunks[0].text.includes('BUDGET'));
  assert.equal(scan.chunks[0].locator.page, 1); assert.ok(scan.chunks[0].warnings.includes('ocr_unverified'));
  const partial = await read('partial.pdf'); assert.deepEqual(partial.coverage, { totalPages: 2, extractedPages: 1, missingPages: [2] });
  assert.ok(partial.warnings.includes('pages_without_reliable_text'));
});
