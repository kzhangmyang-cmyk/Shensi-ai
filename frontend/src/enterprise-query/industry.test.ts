import test from 'node:test';
import assert from 'node:assert/strict';
import { industryNodes, industryPath, searchIndustries, matchesIndustry } from './industry';

test('official taxonomy covers four levels without missing or duplicate codes', () => {
  assert.deepEqual([1,2,3,4].map(level => industryNodes.filter(n => n.code.length === level).length), [20,97,473,1382]);
  assert.equal(new Set(industryNodes.map(n => n.code)).size, 1972);
  assert.deepEqual(industryPath('2921').map(n => n.name), ['制造业','橡胶和塑料制品业','塑料制品业','塑料薄膜制造']);
  assert.equal(industryPath('9700').length, 4);
});
test('name/code search finds detailed categories and invalid inputs never infer a category', () => {
  assert.ok(searchIndustries('塑料薄膜').some(n => n.code === '2921'));
  assert.ok(searchIndustries('2921').some(n => n.name === '塑料薄膜制造'));
  assert.deepEqual(searchIndustries('不存在的分类xyz'), []);
  assert.equal(matchesIndustry('塑料薄膜制造','C'), true);
  assert.equal(matchesIndustry('2921','29'), true);
  assert.equal(matchesIndustry('橡胶和塑料制品业','2921'), false);
  assert.equal(matchesIndustry('可能生产塑料薄膜','2921'), false);
  assert.equal(matchesIndustry('', 'C'), false);
  assert.equal(matchesIndustry('', ''), true);
});
