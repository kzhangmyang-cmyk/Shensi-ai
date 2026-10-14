import { strict as assert } from "node:assert";
import { moduleMetaForSession, moduleSurfaceForSession } from "./demo-router";

assert.equal(
  moduleMetaForSession("dashboard", "real").subtitle,
  "本团队经营数据 · 本人待办 · 近三个月趋势"
);
assert.equal(
  moduleMetaForSession("dashboard", "real").searchPlaceholder,
  "搜索客户、商机或待办..."
);
assert.equal(
  moduleMetaForSession("dashboard", "demo").subtitle,
  "本地演示数据概览与今日待办"
);
assert.equal(moduleMetaForSession("acquisition", "real").title, "获客中心");
assert.equal(moduleMetaForSession("agents", "real").primaryAction, "向经营顾问提问");
assert.equal(moduleMetaForSession("agents", "demo").primaryAction, "新建智能体");
assert.deepEqual(moduleSurfaceForSession("acquisition"), {
  mainVisible: false,
  inspectorVisible: false
});
assert.deepEqual(moduleSurfaceForSession("agents"), {
  mainVisible: true,
  inspectorVisible: true
});
assert.deepEqual(moduleSurfaceForSession("settings"), {
  mainVisible: true,
  inspectorVisible: false
});
assert.equal(moduleMetaForSession("settings", "demo").searchPlaceholder,
  "搜索客户、商机或任务...");
assert.equal(moduleMetaForSession("settings", "demo").primaryAction,
  "查看今日待办");
assert.deepEqual(moduleSurfaceForSession("dashboard"), {
  mainVisible: true,
  inspectorVisible: true
});
assert.deepEqual(moduleSurfaceForSession("conversations"), {
  mainVisible: true,
  inspectorVisible: false
});
assert.deepEqual(moduleSurfaceForSession("conversations", "conversations"), {
  mainVisible: true,
  inspectorVisible: false
});
assert.deepEqual(moduleSurfaceForSession("private-domain"), {
  mainVisible: true,
  inspectorVisible: true
});
