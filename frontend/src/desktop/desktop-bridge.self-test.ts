import { strict as assert } from "node:assert";
import { getDesktopBridge, type ConnectorStatus, type DesktopDiagnostic,
  type DouyinCollectionPage, type DouyinCollectionStatus,
  type DouyinCollectionTask, type DouyinLoginStatus,
  type ShensiDesktopApi } from "./desktop-bridge";
import type {
  ConnectorStatus as CanonicalConnectorStatus,
  DesktopDiagnostic as CanonicalDesktopDiagnostic,
  DouyinCollectionPage as CanonicalDouyinCollectionPage,
  DouyinCollectionStatus as CanonicalDouyinCollectionStatus,
  DouyinCollectionTask as CanonicalDouyinCollectionTask,
  DouyinLoginStatus as CanonicalDouyinLoginStatus
} from "../../../desktop/src/shared/contracts";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type _DiagnosticContract = Assert<Equal<DesktopDiagnostic, CanonicalDesktopDiagnostic>>;
type _ConnectorContract = Assert<Equal<ConnectorStatus, CanonicalConnectorStatus>>;
type _LoginContract = Assert<Equal<DouyinLoginStatus, CanonicalDouyinLoginStatus>>;
type _CollectionTaskContract = Assert<Equal<DouyinCollectionTask, CanonicalDouyinCollectionTask>>;
type _CollectionStatusContract = Assert<Equal<DouyinCollectionStatus, CanonicalDouyinCollectionStatus>>;
type _CollectionPageContract = Assert<Equal<DouyinCollectionPage, CanonicalDouyinCollectionPage>>;

const methods: ShensiDesktopApi = {
  getDesktopInstallationInfo: async () => ({ installationId: "a".repeat(43), protocolVersion: 1, registeredWorkspaceIds: [] }),
  registerDesktopInstallation: async ({ workspaceId }) => ({ workspaceId, registered: true }),
  recordDesktopBinding: async () => ({ recorded: true }),
  setDesktopWorkspace: async () => undefined,
  getDesktopOutreachStatus: async () => ({ state: "disabled", diagnostic: null, currentActionKind: null, updatedAt: null, pendingReconciliationCount: 0, ownership: "unknown" }),
  onDesktopOutreachStatusChanged: () => () => undefined,
  getRuntimeInfo: async () => ({ platform: "darwin", architecture: "arm64", appVersion: "0.1.0", environment: "test", connectorStatus: { state: "ready", protocolVersion: 1, diagnostic: null } }),
  getConnectorStatus: async () => ({ state: "ready" as const, protocolVersion: 1, diagnostic: null }),
  restartConnector: async () => ({ state: "ready" as const, protocolVersion: 1, diagnostic: null }),
  startDouyinLogin: async () => ({} as never),
  checkDouyinLogin: async () => ({} as never),
  getDouyinLoginStatus: async () => ({} as never),
  confirmDouyinLogin: async () => ({} as never),
  cancelDouyinLogin: async () => undefined,
  startDouyinCollection: async () => ({} as never),
  getDouyinCollectionStatus: async () => ({} as never),
  getDouyinCollectionResults: async () => ({} as never),
  acknowledgeDouyinCollection: async () => undefined,
  cancelDouyinCollection: async () => undefined,
  openLogsDirectory: async () => undefined,
  getAppVersion: async () => "0.1.0",
  onConnectorStatus: () => () => undefined
};

const diagnostic: DesktopDiagnostic = {
  code: "connector_ready", message: "ready", recoverable: false,
  occurredAt: "2026-09-03T00:00:00.000Z"
};
assert.equal(diagnostic.occurredAt, "2026-09-03T00:00:00.000Z");

assert.equal(getDesktopBridge({}), null, "ordinary web windows must remain API-backed");
assert.equal(getDesktopBridge({ shensiDesktop: { ...methods, cancelDouyinLogin: undefined } }), null,
  "partial preload objects must fail closed");
assert.equal(getDesktopBridge({ shensiDesktop: methods }), methods,
  "the complete preload allowlist must be accepted without exposing Electron primitives");

console.log(JSON.stringify({ ok: true, suite: "desktop-bridge" }));
