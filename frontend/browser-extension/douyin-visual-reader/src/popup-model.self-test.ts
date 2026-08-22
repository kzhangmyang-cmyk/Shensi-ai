import { strict as assert } from "node:assert";
import { createPopupSelectionModel } from "./popup-model";

const tabs = [
  { id: 21, windowId: 7, title: "视频 A", url: "https://www.douyin.com/video/123" },
  { id: 22, windowId: 7, title: "视频 B", url: "https://www.douyin.com/video/456" }
];

{
  const model = createPopupSelectionModel(tabs);
  assert.equal(model.selectedTabId(), null, "ambiguous tabs are never auto-selected");
  assert.equal(model.canStart(), false);
  assert.equal(model.select(99), false);
  assert.equal(model.select(22), true);
  assert.equal(model.selectedTabId(), 22);
  assert.equal(model.canStart(), true);
  assert.deepEqual(model.confirm(), tabs[1]);
}

{
  const model = createPopupSelectionModel([tabs[0]]);
  assert.equal(model.selectedTabId(), null, "even one tab requires explicit user choice");
  assert.equal(model.confirm(), null);
  assert.equal(model.select(21), true);
  assert.deepEqual(model.confirm(), tabs[0]);
}

{
  const model = createPopupSelectionModel([]);
  assert.equal(model.canStart(), false);
  assert.equal(model.confirm(), null);
}

{
  const model = createPopupSelectionModel([{ ...tabs[0], windowId: -1 }]);
  assert.deepEqual(model.tabs(), [], "an invalid or missing window binding is never selectable");
}

console.log("douyin visual reader popup model self-test passed");
