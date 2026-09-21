// Inputs from the pinned modood snapshot; provenance in enterprise-region-data.md.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const [provinceFile,cityFile,areaFile] = process.argv.slice(2);
const [provinces,cities,areas] = await Promise.all([provinceFile,cityFile,areaFile].map(async path=>JSON.parse(await readFile(path,'utf8'))));
const municipalities = new Set(['11','12','31','50']);
const records = provinces.map(p=>[p.code,p.name,'',municipalities.has(p.code)?'municipality':'province']);
// Public province-code facts from Ministry of Transport code table, no invented children.
records.push(['71','台湾省','','province'],['81','香港特别行政区','','special'],['82','澳门特别行政区','','special']);
for(const city of cities) {
  if(municipalities.has(city.provinceCode)) continue;
  if(city.name.includes('直辖县级行政区划')) {
    for(const area of areas.filter(a=>a.cityCode===city.code)) records.push([area.code,area.name,city.provinceCode,'direct']);
  } else records.push([city.code,city.name,city.provinceCode,'prefecture']);
}
assert.equal(records.filter(r=>!r[2]).length,34);
assert.equal(records.filter(r=>r[3]==='prefecture').length,333);
assert.equal(new Set(records.map(r=>r[0])).size,records.length);
assert.ok(records.some(r=>r[0]==='419001' && r[3]==='direct'));
const target=new URL('../frontend/src/enterprise-query/region-data.ts',import.meta.url);
await writeFile(target,'// Derived from modood 2023-06-30 snapshot (WTFPL-2.0); see docs/modules/enterprise-region-data.md.\nexport const regionData: readonly (readonly [string,string,string,string])[] = '+JSON.stringify(records)+';\n');
console.log({nodes:records.length,provinces:34,prefectures:333,direct:records.filter(r=>r[3]==='direct').length});
