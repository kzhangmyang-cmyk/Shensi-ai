import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { installAppUpdate, renderAppUpdateDialog, type AppUpdateBridge } from "./app-update-view";
import type { PublicUpdateState } from "../../../desktop/src/shared/app-update.ts";

const base = (): PublicUpdateState => ({
  phase: "available", installedVersion: "0.2.0", releaseSequence: 1, availableVersion: "0.2.1",
  title: "Shensi 0.2.1", notes: "修复登录提示。", size: 10, progress: null, error: null,
  fileName: null, automaticInstallSupported: false, installMode: "manual-dmg", instructions: null
});

const available = renderAppUpdateDialog(base());
assert.match(available, /下载并校验/);
assert.match(available, /Developer ID/);
assert.match(available, /不会改动正在运行的应用/);
assert.equal(available.includes("data-app-update-action=\"install\""), false);
const progress = renderAppUpdateDialog({ ...base(), phase: "downloading", progress: { received: 4, total: 8 } });
assert.match(progress, /aria-valuenow="50"/);
assert.match(progress, /取消/);
const failed = renderAppUpdateDialog({ ...base(), phase: "failed", error: "安装包校验失败，已删除未完成文件。" });
assert.match(failed, /重试/);
assert.match(failed, /校验失败/);
const verified = renderAppUpdateDialog({
  ...base(), phase: "verified", fileName: "Shensi-0.2.1-arm64.dmg",
  instructions: "已校验 Shensi-0.2.1-arm64.dmg。请退出 Shensi，打开这个 DMG。"
});
assert.match(verified, /在访达中显示/);
assert.match(verified, /打开这个 DMG/);
assert.equal(renderAppUpdateDialog({ ...base(), notes: `<img src=x onerror=alert(1)>` }).includes("<img"), false);

const { document, window } = parseHTML("<html><body><aside class='replica-sidebar-bottom'><button class='replica-user'>账户</button></aside></body></html>");
const calls: string[] = [];
let state = base();
const bridge: AppUpdateBridge = {
  getState: async () => state,
  check: async () => { calls.push("check"); return state; },
  download: async () => { calls.push("download"); state = { ...state, phase: "downloading", progress: { received: 1, total: 2 } }; return state; },
  cancel: async () => { calls.push("cancel"); return state; },
  retry: async () => { calls.push("retry"); return { ...state, phase: "failed", error: "下载中断，请重试。" }; },
  reveal: async () => { calls.push("reveal"); return state; },
  onChange(listener) { listener(state); return () => undefined; }
};
const installed = installAppUpdate(document, bridge);
assert.ok(document.querySelector("[data-app-update-open]"));
document.querySelector<HTMLButtonElement>("[data-app-update-open]")!.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(calls, ["check"]);
assert.match(document.querySelector(".replica-app-update-dialog")?.textContent ?? "", /可以更新/);
document.querySelector<HTMLButtonElement>("[data-app-update-action=download]")!.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(calls.at(-1), "download");
assert.match(document.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow") ?? "", /50/);
installed.dispose();
assert.equal(document.querySelector("[data-app-update-open]"), null);
console.log(JSON.stringify({ ok: true, suite: "app-update-view" }));
