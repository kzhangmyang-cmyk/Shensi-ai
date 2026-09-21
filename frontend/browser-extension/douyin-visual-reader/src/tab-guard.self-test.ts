import { strict as assert } from "node:assert";
import * as tabGuard from "./tab-guard";
import {
  boundTabNavigationIsTakeover,
  focusLeavesBoundWindow,
  prepareFreshDouyinTab,
  sameWindowActivationIsTakeover,
  validateFreshPopupSelection
} from "./tab-guard";
import type { BoundDouyinTab } from "./tab-guard";

const selected = {
  id: 21,
  windowId: 7,
  url: "https://www.douyin.com/video/123"
};

assert.equal(validateFreshPopupSelection(selected, {
  id: 21,
  windowId: 7,
  url: "https://www.douyin.com/video/123",
  active: false
}), true, "the selected tab may be activated only after fresh identity checks");
assert.equal(validateFreshPopupSelection(selected, {
  id: 21,
  windowId: 7,
  url: "https://www.douyin.com/video/456",
  active: false
}), false, "navigation after popup selection is fail-closed");
assert.equal(validateFreshPopupSelection(selected, {
  id: 21,
  windowId: 8,
  url: "https://www.douyin.com/video/123",
  active: false
}), false, "a moved/replaced tab cannot reuse the popup confirmation");

const binding = { tabId: 21, windowId: 7, url: "https://www.douyin.com/video/123" };
assert.equal(sameWindowActivationIsTakeover(binding, { tabId: 22, windowId: 7 }), true);
assert.equal(sameWindowActivationIsTakeover(binding, { tabId: 99, windowId: 8 }), false,
  "activation in another window does not imply the bound tab became invisible");
assert.equal(sameWindowActivationIsTakeover(binding, { tabId: 21, windowId: 7 }), false);
assert.equal(focusLeavesBoundWindow(binding, 8, -1), true);
assert.equal(focusLeavesBoundWindow(binding, 7, -1), false);
assert.equal(focusLeavesBoundWindow(binding, -1, -1), false,
  "transient Chrome WINDOW_ID_NONE does not abort");
assert.equal(boundTabNavigationIsTakeover(binding, 21, "https://www.douyin.com/video/456"), true);
assert.equal(boundTabNavigationIsTakeover(binding, 21, "https://www.douyin.com/video/123"), false);
assert.equal(boundTabNavigationIsTakeover(binding, 22, "https://www.douyin.com/video/456"), false);

const lifecycleGuard = tabGuard as typeof tabGuard & {
  boundTabDocumentLifecycleIsTakeover?: (
    binding: BoundDouyinTab,
    tabId: number,
    changeInfo: { status?: string; url?: string }
  ) => boolean;
  boundTabReplacementIsTakeover?: (
    binding: BoundDouyinTab,
    addedTabId: number,
    removedTabId: number
  ) => boolean;
};
assert.equal(typeof lifecycleGuard.boundTabDocumentLifecycleIsTakeover, "function",
  "a bound document loading lifecycle has an explicit fail-closed guard");
assert.equal(lifecycleGuard.boundTabDocumentLifecycleIsTakeover?.(binding, 21, { status: "loading" }), true,
  "a same-URL reload aborts before the target document can continue reading");
assert.equal(lifecycleGuard.boundTabDocumentLifecycleIsTakeover?.(binding, 21, {
  status: "loading",
  url: "https://www.douyin.com/video/123"
}), true, "loading remains terminal even when Chrome repeats the same canonical URL");
assert.equal(lifecycleGuard.boundTabDocumentLifecycleIsTakeover?.(binding, 21, {
  url: "https://www.douyin.com/video/456"
}), true, "a URL-only target update remains terminal");
assert.equal(lifecycleGuard.boundTabDocumentLifecycleIsTakeover?.(binding, 22, { status: "loading" }), false,
  "another tab loading cannot stop the bound reader");
assert.equal(lifecycleGuard.boundTabDocumentLifecycleIsTakeover?.(binding, 21, { status: "complete" }), false,
  "non-navigation document updates do not misclassify a target tab as takeover");
assert.equal(typeof lifecycleGuard.boundTabReplacementIsTakeover, "function",
  "a bound tab replacement has an explicit fail-closed guard");
assert.equal(lifecycleGuard.boundTabReplacementIsTakeover?.(binding, 99, 21), true,
  "replacement of the bound tab aborts even before a replacement URL is observable");
assert.equal(lifecycleGuard.boundTabReplacementIsTakeover?.(binding, 21, 99), false,
  "replacement activity for another tab cannot stop the bound reader");

{
  const calls: string[] = [];
  let reads = 0;
  const prepared = await prepareFreshDouyinTab(selected, {
    getTab: async () => {
      calls.push("get");
      reads += 1;
      return { ...selected, active: reads === 2 };
    },
    focusWindow: async (windowId) => { calls.push(`focus:${windowId}`); },
    activateTab: async (tabId) => { calls.push(`activate:${tabId}`); }
  });
  assert.deepEqual(calls, ["get", "focus:7", "activate:21", "get"]);
  assert.deepEqual(prepared, { ...selected, active: true });
}

{
  let reads = 0;
  const prepared = await prepareFreshDouyinTab(selected, {
    getTab: async () => {
      reads += 1;
      return reads === 1 ? { ...selected, active: false } : {
        ...selected,
        url: "https://www.douyin.com/video/456",
        active: true
      };
    },
    focusWindow: async () => undefined,
    activateTab: async () => undefined
  });
  assert.equal(prepared, null, "a navigation race after activation fails closed before injection");
}

console.log("douyin visual reader tab guard self-test passed");
