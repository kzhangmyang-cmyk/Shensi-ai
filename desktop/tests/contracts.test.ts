import assert from "node:assert/strict";
import test from "node:test";
import { DESKTOP_CHANNELS, type ConnectorStatus, type DouyinCollectionRecord,
  type DouyinLoginStatus } from "../src/shared/contracts.ts";
import { validateInvoke } from "../src/shared/validation.ts";

const expectedChannels = {
  getDesktopInstallationInfo: "shensi:desktop:get-installation-info",
  registerDesktopInstallation: "shensi:desktop:register-installation",
  recordDesktopBinding: "shensi:desktop:record-binding",
  setDesktopWorkspace: "shensi:desktop:set-workspace",
  getDesktopOutreachStatus: "shensi:desktop:get-outreach-status",
  desktopOutreachStatusChanged: "shensi:desktop:outreach-status-changed",
  getRuntimeInfo: "shensi:desktop:get-runtime-info",
  getConnectorStatus: "shensi:desktop:get-connector-status",
  restartConnector: "shensi:desktop:restart-connector",
  startDouyinLogin: "shensi:desktop:start-douyin-login",
  checkDouyinLogin: "shensi:desktop:check-douyin-login",
  getDouyinLoginStatus: "shensi:desktop:get-douyin-login-status",
  confirmDouyinLogin: "shensi:desktop:confirm-douyin-login",
  cancelDouyinLogin: "shensi:desktop:cancel-douyin-login",
  startDouyinCollection: "shensi:desktop:start-douyin-collection",
  getDouyinCollectionStatus: "shensi:desktop:get-douyin-collection-status",
  getDouyinCollectionResults: "shensi:desktop:get-douyin-collection-results",
  acknowledgeDouyinCollection: "shensi:desktop:acknowledge-douyin-collection",
  cancelDouyinCollection: "shensi:desktop:cancel-douyin-collection",
  controlDouyinCollection: "shensi:desktop:control-douyin-collection",
  openLogsDirectory: "shensi:desktop:open-logs-directory",
  getAppVersion: "shensi:desktop:get-app-version",
  connectorStatusChanged: "shensi:desktop:connector-status-changed"
} as const;

test("enrollment/status invoke schemas are closed and binding generations are positive safe integers", () => {
  const registration = { workspaceId: "workspace/中国", enrollmentToken: "A".repeat(43) };
  assert.deepEqual(validateInvoke(expectedChannels.registerDesktopInstallation, registration), registration);
  const binding = { workspaceId: "workspace/中国", accountId: "account-one", bindingGeneration: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(validateInvoke(expectedChannels.recordDesktopBinding, binding), binding);
  assert.deepEqual(validateInvoke(expectedChannels.setDesktopWorkspace, { workspaceId: null }), { workspaceId: null });
  for (const channel of [expectedChannels.getDesktopInstallationInfo, expectedChannels.getDesktopOutreachStatus]) {
    assert.equal(validateInvoke(channel, undefined), undefined);
    assert.throws(() => validateInvoke(channel, {}));
  }
  for (const bindingGeneration of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => validateInvoke(expectedChannels.recordDesktopBinding, { ...binding, bindingGeneration }));
  for (const value of [{ ...registration, deviceToken: "secret" }, { ...registration, enrollmentToken: "short" },
    { ...registration, workspaceId: "bad\nworkspace" }, { ...registration, workspaceId: "x".repeat(256) }])
    assert.throws(() => validateInvoke(expectedChannels.registerDesktopInstallation, value));
  assert.throws(() => validateInvoke(expectedChannels.recordDesktopBinding, { ...binding, accountHandle: "secret" }));
  assert.throws(() => validateInvoke(expectedChannels.desktopOutreachStatusChanged, undefined));
  for (const operation of ["claim", "start", "execute", "complete", "reconcile", "acknowledge"])
    assert.throws(() => validateInvoke(`shensi:desktop:${operation}-outreach-action`, {}));
});

test("desktop exposes only the specified IPC channel allowlist", () => {
  assert.deepEqual(DESKTOP_CHANNELS, expectedChannels);
  assert.ok(Object.isFrozen(DESKTOP_CHANNELS));
});

test("normalized desktop status contracts retain renderer and projection semantics", () => {
  const diagnostic = { code: "connector_unavailable", message: "retry", recoverable: true,
    occurredAt: new Date().toISOString() };
  const connector = { state: "crashed", protocolVersion: 1, diagnostic } satisfies ConnectorStatus;
  const login = { sessionId: "session-1", state: "awaiting_scan",
    interactionSurface: "external_window", runtimeState: "running",
    authState: "waiting_for_user", taskState: "idle", diagnostic: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), accountHandle: null,
    accountDisplayName: null, loginStateVersion: null, failureCode: null } satisfies DouyinLoginStatus;
  const record = { recordId: "record-1", kind: "comment", actorKind: "commenter",
    canonicalUrl: "https://www.douyin.com/video/1", publicDisplayName: "candidate",
    publicProfileUrl: null, textExcerpt: "need", sourceKeyword: "dust",
    observedAt: new Date().toISOString(), contentHash: "sha256:value" } satisfies DouyinCollectionRecord;
  assert.deepEqual(connector.diagnostic, diagnostic);
  assert.equal(login.interactionSurface, "external_window");
  assert.equal(record.actorKind, "commenter");
  assert.equal("recoverable" in connector, false);
});

test("desktop invoke validation accepts bounded collection input", () => {
  const deadlineAt = new Date(Date.now() + 60_000).toISOString();
  const input = { accountId: "workspace_01", task: {
    taskId: "task-01", loginStateVersion: 1, keywords: ["工业除尘"],
    maxVideos: 200, maxCommentsPerVideo: 200, maxPagesPerVideo: 20,
    collectCreators: true, collectDemandComments: true, deadlineAt
  } };
  assert.deepEqual(validateInvoke(DESKTOP_CHANNELS.startDouyinCollection, input), input);
});

test("account identifiers are bounded opaque values rather than local path segments", () => {
  assert.deepEqual(validateInvoke(DESKTOP_CHANNELS.startDouyinLogin, {
    accountId: "workspace/中国 customer"
  }), { accountId: "workspace/中国 customer" });
});

test("saved login checks accept only an account identifier, never browser or session controls", () => {
  assert.deepEqual(validateInvoke(DESKTOP_CHANNELS.checkDouyinLogin, {
    accountId: "workspace/中国 customer"
  }), { accountId: "workspace/中国 customer" });
  for (const value of [{ accountId: "" }, { accountId: "a", sessionId: "session-a" },
    { accountId: "a", url: "https://www.douyin.com" }, { accountId: "a", loginStateVersion: 7 }]) {
    assert.throws(() => validateInvoke(DESKTOP_CHANNELS.checkDouyinLogin, value));
  }
});

test("desktop invoke validation rejects unknown channels, capabilities and bad bounds", () => {
  const baseTask = { taskId: "task-1", loginStateVersion: 1, keywords: ["x"],
    maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1,
    collectCreators: true, collectDemandComments: true,
    deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  const invalidInputs: ReadonlyArray<readonly [string, unknown]> = [
    ["shensi:desktop:exec", {}],
    [DESKTOP_CHANNELS.startDouyinLogin, { accountId: "ok", executable: "/bin/sh" }],
    [DESKTOP_CHANNELS.startDouyinLogin, { accountId: "ok", path: "/tmp" }],
    [DESKTOP_CHANNELS.startDouyinLogin, { accountId: "ok", url: "https://example.com" }],
    [DESKTOP_CHANNELS.startDouyinLogin, { accountId: "ok", argv: ["--no-sandbox"] }],
    [DESKTOP_CHANNELS.startDouyinLogin, { accountId: "" }],
    [DESKTOP_CHANNELS.getDouyinLoginStatus, { sessionId: "bad/id" }],
    [DESKTOP_CHANNELS.startDouyinCollection, { accountId: "ok", task: { ...baseTask, keywords: [] } }],
    [DESKTOP_CHANNELS.startDouyinCollection, { accountId: "ok", task: { ...baseTask, maxVideos: 201 } }],
    [DESKTOP_CHANNELS.startDouyinCollection, { accountId: "ok", task: {
      ...baseTask, deadlineAt: new Date(Date.now() - 1).toISOString() } }]
  ];
  for (const [channel, value] of invalidInputs) assert.throws(() => validateInvoke(channel, value));
});

test("no-argument and identifier calls remain closed", () => {
  assert.equal(validateInvoke(DESKTOP_CHANNELS.getRuntimeInfo, undefined), undefined);
  assert.deepEqual(validateInvoke(DESKTOP_CHANNELS.getDouyinCollectionResults,
    { taskId: "task_01", cursor: "cursor-01" }), { taskId: "task_01", cursor: "cursor-01" });
  assert.deepEqual(validateInvoke(DESKTOP_CHANNELS.acknowledgeDouyinCollection,
    { taskId: "task_01" }), { taskId: "task_01" });
  assert.throws(() => validateInvoke(DESKTOP_CHANNELS.getRuntimeInfo, {}));
  assert.throws(() => validateInvoke(DESKTOP_CHANNELS.getDouyinCollectionResults,
    { taskId: "task_01", cursor: "cursor-01", token: "secret" }));
});

test("Sidecar URL-safe identifiers round-trip through every matching IPC boundary", () => {
  const deadlineAt = new Date(Date.now() + 60_000).toISOString();
  const tokens = [
    "_6NYK8JUrP5FTmGHATnkQsFI8oBhjR6V",
    "-6NYK8JUrP5FTmGHATnkQsFI8oBhjR6V",
  ];
  for (const token of tokens) {
    for (const channel of [
      DESKTOP_CHANNELS.getDouyinLoginStatus,
      DESKTOP_CHANNELS.confirmDouyinLogin,
      DESKTOP_CHANNELS.cancelDouyinLogin,
    ]) assert.deepEqual(validateInvoke(channel, { sessionId: token }), { sessionId: token });
    for (const channel of [
      DESKTOP_CHANNELS.getDouyinCollectionStatus,
      DESKTOP_CHANNELS.acknowledgeDouyinCollection,
      DESKTOP_CHANNELS.cancelDouyinCollection,
    ]) assert.deepEqual(validateInvoke(channel, { taskId: token }), { taskId: token });
    assert.deepEqual(validateInvoke(DESKTOP_CHANNELS.getDouyinCollectionResults,
      { taskId: token, cursor: token }), { taskId: token, cursor: token });
    assert.equal((validateInvoke(DESKTOP_CHANNELS.startDouyinCollection, {
      accountId: "workspace", task: {
        taskId: token, loginStateVersion: 1, keywords: ["x"], maxVideos: 1,
        maxCommentsPerVideo: 1, maxPagesPerVideo: 1, collectCreators: true,
        collectDemandComments: true, deadlineAt,
      },
    }) as { task: { taskId: string } }).task.taskId, token);
  }
});

test("opaque identifiers still reject empty, whitespace, path separators and overlong values", () => {
  const invalid = ["", " white-space", "bad/id", "bad\\id", "x".repeat(201)];
  for (const value of invalid) {
    assert.throws(() => validateInvoke(DESKTOP_CHANNELS.getDouyinLoginStatus,
      { sessionId: value }), /sessionId is invalid/u);
    assert.throws(() => validateInvoke(DESKTOP_CHANNELS.cancelDouyinCollection,
      { taskId: value }), /taskId is invalid/u);
  }
});

test("collection keywords are trimmed, bounded by Unicode code points, and numbers are finite", () => {
  const baseTask = { taskId: "task-1", loginStateVersion: 1, keywords: ["  工业除尘  "],
    maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1,
    collectCreators: true, collectDemandComments: true,
    deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  const result = validateInvoke(DESKTOP_CHANNELS.startDouyinCollection,
    { accountId: "ok", task: baseTask }) as { task: { keywords: string[] } };
  assert.deepEqual(result.task.keywords, ["工业除尘"]);
  assert.throws(() => validateInvoke(DESKTOP_CHANNELS.startDouyinCollection,
    { accountId: "ok", task: { ...baseTask, keywords: ["   "] } }));
  assert.doesNotThrow(() => validateInvoke(DESKTOP_CHANNELS.startDouyinCollection,
    { accountId: "ok", task: { ...baseTask, keywords: ["😀".repeat(100)] } }));
  assert.throws(() => validateInvoke(DESKTOP_CHANNELS.startDouyinCollection,
    { accountId: "ok", task: { ...baseTask, keywords: ["😀".repeat(101)] } }));
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
    assert.throws(() => validateInvoke(DESKTOP_CHANNELS.startDouyinCollection,
      { accountId: "ok", task: { ...baseTask, maxVideos: value } }));
});
