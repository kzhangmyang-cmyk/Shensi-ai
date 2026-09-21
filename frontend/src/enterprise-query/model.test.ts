import { strict as assert } from "node:assert";
import { test } from "node:test";
import { filterEnterprises, type Enterprise } from "./model";
import { normalizeAppHash } from "../app-route";
import { moduleSurfaceForSession } from "../demo/demo-router";
const item: Enterprise = { id: "fixture-only", company: "测试制造", business: "制造业", country: "上海", website: "", contact: "", contactInfo: "", description: "精密设备", status: "preview" };
const empty = { keyword: "", region: "", industry: "", size: "" };
test("enterprise route owns a single main surface, not a stale inspector", () => {
  assert.equal(normalizeAppHash("#enterprise-query"), "#enterprise-query");
  assert.deepEqual(moduleSurfaceForSession("enterprise-query"), { mainVisible: true, inspectorVisible: false });
});
test("keyword, region and industry intersect; excluded records never appear", () => {
  assert.equal(filterEnterprises([item, { ...item, id: "excluded", status: "excluded" }], { ...empty, keyword: "精密", region: "上海", industry: "制造" }).length, 1);
  assert.equal(filterEnterprises([item], { ...empty, region: "北京" }).length, 0);
});
test("missing size is not fabricated and empty source stays empty", () => {
  assert.equal(filterEnterprises([item], { ...empty, size: "100–499人" }).length, 0);
  assert.deepEqual(filterEnterprises([], empty), []);
});
test('official parent industry intersects the real region without guessing missing details', () => {
  const records = [{...item, business:'塑料薄膜制造'}, {...item, id:'other', country:'北京', business:'塑料薄膜制造'}, {...item, id:'unknown', business:'为塑料厂家提供咨询'}];
  assert.deepEqual(filterEnterprises(records,{...empty,region:'31',industry:'29'}).map(x => x.id),['fixture-only']);
  assert.equal(filterEnterprises(records,{...empty,industry:'9999'}).length,0);
});
