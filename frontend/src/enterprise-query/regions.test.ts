import test from 'node:test';
import assert from 'node:assert/strict';
import {regionNodes,regionChildren,regionPath,searchRegions,matchesRegion} from './regions';
test('national directory distinguishes prefectures, municipalities and direct county units',()=>{
  assert.equal(regionNodes.filter(n=>!n.parent).length,34);
  assert.equal(regionNodes.filter(n=>n.kind==='prefecture').length,333);
  assert.equal(regionChildren('11').length,0);
  assert.equal(regionChildren('50').length,0);
  assert.equal(regionChildren('81').length,0);
  assert.equal(regionChildren('41').find(n=>n.name==='济源市')?.kind,'direct');
  assert.equal(regionChildren('42').find(n=>n.name==='仙桃市')?.kind,'direct');
  assert.equal(regionChildren('65').find(n=>n.name==='白杨市')?.kind,'direct');
  assert.deepEqual(regionPath('4101').map(n=>n.name),['河南省','郑州市']);
  assert.equal(searchRegions('郑州')[0]?.code,'4101');
});
test('province includes known cities, exact names and explicit paths without guessing country fields',()=>{
  assert.equal(matchesRegion('郑州市','41'),true);
  assert.equal(matchesRegion('河南省郑州市','4101'),true);
  assert.equal(matchesRegion('上海','31'),true);
  assert.equal(matchesRegion('410100','4101'),true);
  assert.equal(matchesRegion('河南省','4101'),false);
  assert.equal(matchesRegion('河北省郑州市','4101'),false);
  assert.equal(matchesRegion('中国','41'),false);
  assert.equal(matchesRegion('','41'),false);
  assert.equal(matchesRegion('',''),true);
});
