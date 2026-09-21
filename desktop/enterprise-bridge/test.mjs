import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { parseHTML } = createRequire(new URL('../../frontend/package.json', import.meta.url))('linkedom');
const captureCode = await readFile(new URL('extension/capture.js', import.meta.url), 'utf8');
function capture(origin = 'https://aiqicha.baidu.com', hidden = false) {
  const { document } = parseHTML('<html><body><article class="items"><h3><a>测试企业</a></h3><p>法定代表人：测试 注册资本：100万元 成立时间：2020-01-01 电话：12345 邮箱：暂无 地址：测试地址 999+ 条自身风险 81 条关联风险</p></article><footer><h3>联系我们</h3></footer></body></html>');
  for (const element of document.querySelectorAll('*')) element.getClientRects = () => hidden ? [] : [{}];
  return runInNewContext(captureCode, { document, location: { origin, pathname: '/s', href: origin + '/s' }, URL, getComputedStyle: () => ({ visibility: 'visible' }) });
}
test('advanced result capture excludes status tags from names and separates scope from address',()=>{
  const {document}=parseHTML('<html><body><div class="advancedsearch-result"><div class="items"><h3><a href="/company_detail_123">样本有限公司</a><span>开业</span></h3><div>法定代表人：张三 注册资本：100万 成立时间：2020-01-01 地址：河南省郑州市 经营范围：塑料制品生产。</div></div></div></body></html>');
  for(const el of document.querySelectorAll('*'))el.getClientRects=()=>[{}];
  const result=runInNewContext(captureCode,{document,location:{origin:'https://aiqicha.baidu.com',pathname:'/advancesearch/list',href:'https://aiqicha.baidu.com/advancesearch/list'},URL,getComputedStyle:()=>({visibility:'visible'})});
  assert.equal(result.ok,true);assert.equal(result.capture.items[0].company,'样本有限公司');
  assert.equal(result.capture.items[0].address,'河南省郑州市');assert.equal(result.capture.items[0].businessScope,'塑料制品生产。');
});
test('extracts rendered current-page card fields, not search total', () => {
  const result = capture(); assert.equal(result.ok, true); assert.equal(result.capture.items.length, 1);
  assert.equal(result.capture.items[0].capital, '100万元'); assert.equal(result.capture.items[0].founded, '2020-01-01');
  assert.equal(result.capture.items[0].contactInfo, '12345'); assert.equal('total' in result.capture, false);
  assert.equal(result.capture.items[0].address, '测试地址');
});
test('rejects foreign pages and hidden cards', () => { assert.equal(capture('https://evil.test').ok, false); assert.equal(capture(undefined, true).ok, false); });
test('detail reads only displayed registry table and never masked approval date', () => {
  const { document } = parseHTML('<html><body><section><h1>测试企业</h1><p>统一社会信用代码：914101815686135204 电话：13598819351 更多电话 8 邮箱：public@example.com 注册资本：1,500万(元)</p></section><table><tr><td>统一社会信用代码</td><td>914101815686135204</td><td>注册资本</td><td>1,500万(元)</td></tr><tr><td>法定代表人</td><td>刘俊生</td><td>成立日期</td><td>2011-01-18</td></tr><tr><td>注册地址</td><td>巩义市产业集聚区 查看地图</td></tr><tr><td>经营范围</td><td>生产、销售：电线电缆。</td></tr><tr><td>参保人数</td><td>15人</td><td>核准日期</td><td>****-**-**</td></tr></table></body></html>');
  for (const element of document.querySelectorAll('*')) element.getClientRects = () => [{}];
  document.querySelectorAll('tr')[1].querySelectorAll('td')[1].textContent = '刘 刘俊生 履历 TA有2家企业';
  const result = runInNewContext(captureCode, { document, location: { origin: 'https://aiqicha.baidu.com', pathname: '/company_detail_123', href: 'https://aiqicha.baidu.com/company_detail_123' }, URL, getComputedStyle: () => ({visibility:'visible'}) });
  assert.equal(result.ok, true); const item = result.capture.items[0];
  assert.equal(item.creditCode, '914101815686135204'); assert.equal(item.insuredEmployees, '15人');
  assert.equal(item.address, '巩义市产业集聚区'); assert.equal(item.businessScope, '生产、销售：电线电缆。');
  assert.equal(item.contactInfo, '13598819351'); assert.equal(item.approvalDate, undefined);
  assert.equal(item.legalPerson, '刘俊生');
});
test('manifest has no cookie/history/background or external web messaging access', async () => {
  const manifest = JSON.parse(await readFile(new URL('extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['scripting', 'nativeMessaging']);
  assert.deepEqual(manifest.host_permissions, ['https://aiqicha.baidu.com/*']);
  assert.equal(manifest.background, undefined); assert.equal(manifest.externally_connectable, undefined);
});
test('native host accepts framed capture only from configured extension and writes private preview', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'shensi-bridge-test-'));
  const directory = path.join(home, 'Library/Application Support/ShensiEnterpriseBridge');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = 'a'.repeat(32); await writeFile(path.join(directory, 'config.json'), JSON.stringify({ extensionId: id }));
  const message = Buffer.from(JSON.stringify(capture().capture)); const length = Buffer.alloc(4); length.writeUInt32LE(message.length);
  const code = await readFile(new URL('dist/native-host.cjs', import.meta.url), 'utf8');
  const execute = origin => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('native host did not reply')), 2000);
    runInNewContext(code, { require: name => name === 'node:os' ? { homedir: () => home } : require(name), Buffer, URL, console,
      setTimeout, clearTimeout, process: { argv: ['node', 'host', origin], getuid: () => process.getuid(), stdin: Readable.from([length.subarray(0,2), Buffer.concat([length.subarray(2), message])]), stdout: { write(data) { clearTimeout(timeout); resolve(JSON.parse(data.subarray(4).toString())); } }, exit() { reject(new Error('unexpected exit')); } } });
  });
  assert.equal((await execute(`chrome-extension://${id}/`)).ok, true);
  const saved = JSON.parse(await readFile(path.join(directory, 'preview.json'), 'utf8')); assert.equal(saved.items.length, 1);
  assert.equal((await execute(`chrome-extension://${'b'.repeat(32)}/`)).ok, false);
});
