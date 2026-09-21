import { strict as assert } from "node:assert";
import test from "node:test";
import { exposeDesktopApi } from "../src/preload/desktop-api.ts";
import { DESKTOP_CHANNELS } from "../src/shared/contracts.ts";

test("preload exposes only the documented bridge and returns an event unsubscribe", async () => {
  let exposed: Record<string, unknown> | null = null;
  const listeners = new Set<(event: unknown, status: unknown) => void>();
  const invoked: string[] = [];
  const api = exposeDesktopApi({
    contextBridge: { exposeInMainWorld(key, value) { assert.equal(key, "shensiDesktop"); exposed = value as Record<string, unknown>; } },
    ipcRenderer: {
      invoke(channel: string) { invoked.push(channel); return Promise.resolve("ok"); },
      on(_channel: string, listener: (event: unknown, status: unknown) => void) { listeners.add(listener); },
      removeListener(_channel: string, listener: (event: unknown, status: unknown) => void) { listeners.delete(listener); }
    }
  });
  assert.equal(api, exposed);
  assert.deepEqual(Object.keys(exposed!).sort(), [
    "acknowledgeDouyinCollection", "cancelDouyinCollection", "cancelDouyinLogin", "checkDouyinLogin", "confirmDouyinLogin", "controlDouyinCollection", "getAppVersion",
    "getConnectorStatus", "getDouyinCollectionResults", "getDouyinCollectionStatus",
    "getDouyinLoginStatus", "getRuntimeInfo", "onConnectorStatus", "openLogsDirectory",
    "restartConnector", "startDouyinCollection", "startDouyinLogin",
    "getDesktopInstallationInfo", "registerDesktopInstallation", "recordDesktopBinding", "setDesktopWorkspace",
    "getDesktopOutreachStatus", "onDesktopOutreachStatusChanged"
  ].sort());
  await (exposed!.startDouyinLogin as (value: string) => Promise<unknown>)("workspace-a");
  assert.equal(invoked[0], DESKTOP_CHANNELS.startDouyinLogin);
  const unsubscribe = (exposed!.onConnectorStatus as (listener: (value: unknown) => void) => () => void)(() => undefined);
  assert.equal(listeners.size, 1);
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test("preload saved-login check invokes only the read-only channel with a validated account", async () => {
  const invoked: unknown[][] = [];
  const identity = { accountHandle: `dyacct_${"a".repeat(64)}`,
    accountDisplayName: "hkko", loginStateVersion: 7 };
  const api = exposeDesktopApi({ contextBridge: { exposeInMainWorld() {} }, ipcRenderer: {
    async invoke(...args) { invoked.push(args); return identity; },
    on() {}, removeListener() {}
  } });
  assert.deepEqual(await api.checkDouyinLogin("workspace-a"), identity);
  assert.deepEqual(invoked, [[DESKTOP_CHANNELS.checkDouyinLogin, { accountId: "workspace-a" }]]);
  assert.throws(() => api.checkDouyinLogin(""));
  assert.equal(invoked.length, 1);
});

test("preload exposes five status/enrollment invokes and one disposable status event without an Electron event", async () => {
  const invoked: unknown[] = [];
  const listeners = new Map<string, (event: unknown, value: unknown) => void>();
  const api = exposeDesktopApi({ contextBridge: { exposeInMainWorld() {} }, ipcRenderer: {
    invoke: async (...args) => { invoked.push(args); return args[0] === DESKTOP_CHANNELS.getDesktopOutreachStatus ? view : undefined; },
    on: (channel, listener) => { listeners.set(channel, listener); },
    removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel); }
  } });
  const received: unknown[] = [];
  const unsubscribe = api.onDesktopOutreachStatusChanged((value) => received.push(value));
  const listener = listeners.get(DESKTOP_CHANNELS.desktopOutreachStatusChanged)!;
  const view = { state: "executing", diagnostic: null, currentActionKind: "direct_message", updatedAt: null,
    pendingReconciliationCount: 0, ownership: "this_device" };
  listener({ secret: "electron-event" }, view);
  assert.deepEqual(received, [view]);
  listener({}, { ...view, deviceToken: "secret" });
  listener({}, { ...view, diagnostic: "SECRET" });
  assert.equal(received.length, 1);
  unsubscribe(); unsubscribe();
  listener({}, view);
  assert.equal(received.length, 1);
  assert.equal(listeners.size, 0);
  await api.getDesktopInstallationInfo();
  await api.registerDesktopInstallation({ workspaceId: "workspace-one", enrollmentToken: "E".repeat(43) });
  await api.recordDesktopBinding({ workspaceId: "workspace-one", accountId: "account-one", bindingGeneration: 1 });
  await api.setDesktopWorkspace({ workspaceId: null });
  await api.getDesktopOutreachStatus();
  assert.deepEqual(invoked, [
    [DESKTOP_CHANNELS.getDesktopInstallationInfo, undefined],
    [DESKTOP_CHANNELS.registerDesktopInstallation, { workspaceId: "workspace-one", enrollmentToken: "E".repeat(43) }],
    [DESKTOP_CHANNELS.recordDesktopBinding, { workspaceId: "workspace-one", accountId: "account-one", bindingGeneration: 1 }],
    [DESKTOP_CHANNELS.setDesktopWorkspace, { workspaceId: null }],
    [DESKTOP_CHANNELS.getDesktopOutreachStatus, undefined]
  ]);
});
