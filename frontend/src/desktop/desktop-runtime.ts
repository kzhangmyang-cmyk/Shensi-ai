import { getDesktopBridge, type ConnectorStatus, type ShensiDesktopApi, type DesktopOutreachCoordinatorView } from "./desktop-bridge";
import { createDesktopEnrollmentApi, type DesktopEnrollmentApi, type DesktopBindingStatus } from "./desktop-enrollment-api";
import type { DouyinAccount } from "../acquisition/douyin-automation-api";
import type { OutreachAction } from "../acquisition/outreach-batch-api";
import { desktopAdmissionMessage } from "./desktop-admission-error";

export interface DesktopRuntimeState {
  bridge: ShensiDesktopApi | null;
  accountId(): string | null;
  connectorStatus(): ConnectorStatus | null;
  subscribe(listener: (status: ConnectorStatus) => void): () => void;
  restartConnector(): Promise<ConnectorStatus>;
  synchronizeWorkspace(workspaceId: string | null): Promise<void>;
  outreachStatus(): DesktopOutreachCoordinatorView | null;
  enrollmentError(): string | null;
  subscribeOutreach(listener: () => void): () => void;
  bindingStatus(): DesktopBindingStatus | null;
  bindingError(): string | null;
  bindingPending(): boolean;
  prepareLocalAccountBinding(account: Pick<DouyinAccount, "id" | "workspaceId" | "state" | "loginStateVersion">,
    local: { accountHandle: string | null; loginStateVersion: number | null }): Promise<void>;
  acceptLocalAccount(account: Pick<DouyinAccount, "id" | "workspaceId" | "state" | "loginStateVersion">,
    local: { accountHandle: string | null; loginStateVersion: number | null }): Promise<void>;
  bindDesktopAccount(handoff: boolean): Promise<void>;
  start(): void;
  dispose(): void;
}

export function createDesktopRuntimeState(
  bridge: ShensiDesktopApi | null,
  documentLike: { body: { dataset: DOMStringMap }; addEventListener?: Document["addEventListener"]; removeEventListener?: Document["removeEventListener"] },
  enrollmentApi: DesktopEnrollmentApi = createDesktopEnrollmentApi()
): DesktopRuntimeState {
  let status: ConnectorStatus | null = null;
  let unsubscribeBridge: (() => void) | null = null;
  let started = false;
  let disposed = false;
  let lifecycleGeneration = 0;
  let observationSequence = 0;
  let outreach: DesktopOutreachCoordinatorView | null = null;
  let outreachSequence = 0;
  let unsubscribeOutreach: (() => void) | null = null;
  let workspace: string | null | undefined;
  let workspaceGeneration = 0;
  let workspaceFlight: Promise<void> | null = null;
  let enrollmentError: string | null = null;
  let binding: DesktopBindingStatus | null = null;
  let bindingError: string | null = null;
  let bindingFlight: Promise<void> | null = null;
  let localAccount: { accountId: string; workspaceId: string; accountHandle: string; loginStateVersion: number } | null = null;
  const outreachListeners = new Set<() => void>();
  const notifyOutreach = () => outreachListeners.forEach((listener) => listener());
  const listeners = new Set<(value: ConnectorStatus) => void>();
  const publish = (value: ConnectorStatus) => {
    status = value;
    listeners.forEach((listener) => listener(value));
  };
  const bindBridgeEvents = (ownGeneration: number) => {
    unsubscribeBridge?.();
    unsubscribeBridge = bridge?.onConnectorStatus((value) => {
      if (disposed || ownGeneration !== lifecycleGeneration) return;
      observationSequence += 1;
      publish(value);
    }) ?? null;
  };
  const onAuthentication = (event: Event) => {
    const authenticated = (event as CustomEvent<{ authenticated: boolean }>).detail?.authenticated;
    if (typeof authenticated !== "boolean") return;
    const workspaceId = authenticated ? documentLike.body.dataset.sessionWorkspaceId?.trim() || null : null;
    void runtime.synchronizeWorkspace(workspaceId).catch(() => undefined);
  };
  const rememberLocalAccount = (account: Pick<DouyinAccount, "id" | "workspaceId" | "state" | "loginStateVersion">,
    local: { accountHandle: string | null; loginStateVersion: number | null }) => {
    if (!bridge || disposed || account.workspaceId !== workspace || account.state !== "active"
      || !local.accountHandle || local.loginStateVersion !== account.loginStateVersion
      || !local.loginStateVersion) throw new Error("desktop_login_cloud_binding_mismatch");
    if (!localAccount || localAccount.accountId !== account.id || localAccount.workspaceId !== account.workspaceId
      || localAccount.accountHandle !== local.accountHandle || localAccount.loginStateVersion !== local.loginStateVersion) {
      localAccount = { accountId: account.id, workspaceId: account.workspaceId,
        accountHandle: local.accountHandle, loginStateVersion: local.loginStateVersion };
      bindingFlight = null;
    }
    return localAccount;
  };
  const runtime: DesktopRuntimeState = Object.freeze({
    bridge,
    accountId() {
      if (!bridge) return null;
      return documentLike.body.dataset.sessionWorkspaceId?.trim() || null;
    },
    connectorStatus: () => status,
    outreachStatus: () => outreach,
    enrollmentError: () => enrollmentError,
    bindingStatus: () => binding,
    bindingError: () => bindingError,
    bindingPending: () => bindingFlight !== null,
    async prepareLocalAccountBinding(account: Pick<DouyinAccount, "id" | "workspaceId" | "state" | "loginStateVersion">,
      identity: { accountHandle: string | null; loginStateVersion: number | null }) {
      const local = rememberLocalAccount(account, identity);
      const own = workspaceGeneration;
      const info = await bridge!.getDesktopInstallationInfo();
      if (disposed || own !== workspaceGeneration || localAccount !== local) return;
      const next = await enrollmentApi.getBinding(local.accountId, info.installationId);
      if (disposed || own !== workspaceGeneration || localAccount !== local) return;
      if (next.accountId !== local.accountId || !Number.isSafeInteger(next.bindingGeneration)
        || next.bindingGeneration < 0) throw new Error("desktop_executor_binding_unavailable");
      binding = next;
      bindingError = null;
      notifyOutreach();
    },
    async acceptLocalAccount(account: Pick<DouyinAccount, "id" | "workspaceId" | "state" | "loginStateVersion">,
      local: { accountHandle: string | null; loginStateVersion: number | null }) {
      rememberLocalAccount(account, local);
      await runtime.bindDesktopAccount(false);
    },
    bindDesktopAccount(handoff: boolean) {
      if (bindingFlight) return bindingFlight;
      const local = localAccount;
      if (!bridge || !local || disposed || local.workspaceId !== workspace) return Promise.reject(new Error("desktop_local_login_required"));
      const own = workspaceGeneration;
      const current = () => !disposed && own === workspaceGeneration && localAccount === local;
      bindingError = null;
      const flight = (async () => {
        await runtime.synchronizeWorkspace(local.workspaceId);
        const info = await bridge.getDesktopInstallationInfo();
        const next = await enrollmentApi.getBinding(local.accountId, info.installationId);
        if (!current()) return;
        if (next.accountId !== local.accountId || !Number.isSafeInteger(next.bindingGeneration) || next.bindingGeneration < 0) throw new Error("desktop_executor_binding_unavailable");
        binding = next;
        if (next.executorMode !== null && !next.ownedByInstallation && next.hasUnresolvedActions) {
          bindingError = next.executorMode === "server" ? "存在旧版服务器待执行动作，切换前需先处理" : "仍有未解决动作，暂不可切换设备";
          return;
        }
        const conflict = next.executorMode === "desktop" && !next.ownedByInstallation;
        if (conflict && (!handoff || next.hasUnresolvedActions)) {
          bindingError = next.hasUnresolvedActions ? "仍有未解决动作，暂不可切换设备" : "该账号已绑定其他设备，请明确确认交接";
          return;
        }
        const result = await enrollmentApi.bind(local.accountId, {
          installationId: info.installationId, accountHandle: local.accountHandle,
          loginStateVersion: local.loginStateVersion,
          expectedBindingGeneration: next.bindingGeneration, handoff: conflict && handoff
        }, `desktop-bind-${crypto.randomUUID()}`);
        if (!current()) return;
        if (result.accountId !== local.accountId || result.executorMode !== "desktop"
          || result.ownedByInstallation !== true || !Number.isSafeInteger(result.bindingGeneration)
          || result.bindingGeneration < 1 || result.bindingGeneration > 2147483647) throw new Error("desktop_executor_binding_unavailable");
        await bridge.recordDesktopBinding({ workspaceId: local.workspaceId,
          accountId: result.accountId, bindingGeneration: result.bindingGeneration });
        if (current()) binding = { ...result, hasUnresolvedActions: next.hasUnresolvedActions };
      })().catch(() => {
        if (current()) bindingError = "本机账号绑定失败，请重新核对后重试";
      }).finally(() => {
        if (bindingFlight === flight) bindingFlight = null;
        if (current()) notifyOutreach();
      });
      bindingFlight = flight;
      notifyOutreach();
      return flight;
    },
    subscribeOutreach(listener: () => void) {
      outreachListeners.add(listener);
      return () => { outreachListeners.delete(listener); };
    },
    synchronizeWorkspace(workspaceId: string | null): Promise<void> {
      if (!bridge || disposed) return Promise.resolve();
      if (workspace === workspaceId && !enrollmentError) return workspaceFlight ?? Promise.resolve();
      workspace = workspaceId;
      localAccount = null;
      bindingFlight = null;
      binding = null;
      bindingError = null;
      enrollmentError = null;
      outreach = null;
      const own = ++workspaceGeneration;
      notifyOutreach();
      const current = () => !disposed && own === workspaceGeneration;
      const flight = (async () => {
        await bridge.setDesktopWorkspace({ workspaceId });
        if (!workspaceId || !current()) return;
        const ownSequence = outreachSequence;
        const snapshot = await bridge.getDesktopOutreachStatus();
        if (!current()) return;
        if (ownSequence === outreachSequence) { outreach = snapshot; notifyOutreach(); }
        const info = await bridge.getDesktopInstallationInfo();
        if (!current()) return;
        if (!info.registeredWorkspaceIds.includes(workspaceId)) {
          const enrollment = await enrollmentApi.enroll({ protocolVersion: 1, installationId: info.installationId });
          if (!current()) return;
          const expiry = Date.parse(enrollment.expiresAt);
          if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 61_000) {
            throw new Error("desktop_enrollment_expired");
          }
          const result = await bridge.registerDesktopInstallation({ workspaceId, enrollmentToken: enrollment.enrollmentToken });
          if (!current()) return;
          if (result.workspaceId !== workspaceId || result.registered !== true) {
            throw new Error("desktop_registration_workspace_mismatch");
          }
        }
      })().catch((error: unknown) => {
        if (current()) { enrollmentError = desktopAdmissionMessage(error) ?? "未注册此设备，请重试注册"; notifyOutreach(); }
        throw error;
      });
      workspaceFlight = flight;
      return flight;
    },
    subscribe(listener: (value: ConnectorStatus) => void) {
      listeners.add(listener);
      if (status) listener(status);
      return () => listeners.delete(listener);
    },
    async restartConnector() {
      if (!bridge) throw new Error("desktop_bridge_unavailable");
      if (disposed) throw new Error("desktop_runtime_disposed");
      const ownGeneration = ++lifecycleGeneration;
      const ownSequence = observationSequence;
      bindBridgeEvents(ownGeneration);
      const next = await bridge.restartConnector();
      if (ownGeneration === lifecycleGeneration && ownSequence === observationSequence) publish(next);
      return next;
    },
    start() {
      if (!bridge || started || disposed) return;
      started = true;
      documentLike.addEventListener?.("goodjob:auth-state-changed", onAuthentication);
      const ownOutreachSequence = outreachSequence;
      const ownWorkspaceGeneration = workspaceGeneration;
      unsubscribeOutreach = bridge.onDesktopOutreachStatusChanged?.((value) => {
        if (disposed) return;
        outreachSequence += 1;
        outreach = value;
        notifyOutreach();
      }) ?? null;
      void bridge.getDesktopOutreachStatus?.().then((value) => {
        if (disposed || ownWorkspaceGeneration !== workspaceGeneration || ownOutreachSequence !== outreachSequence) return;
        outreach = value;
        notifyOutreach();
      }, () => undefined);
      const ownGeneration = ++lifecycleGeneration;
      const ownSequence = observationSequence;
      bindBridgeEvents(ownGeneration);
      void bridge.getConnectorStatus().then((value) => {
        if (ownGeneration === lifecycleGeneration && ownSequence === observationSequence) publish(value);
      }, () => {
        if (ownGeneration !== lifecycleGeneration || ownSequence !== observationSequence) return;
        publish({
        state: "crashed", protocolVersion: null,
        diagnostic: { code: "connector_status_unavailable", message: "无法读取本地连接器状态", recoverable: true, occurredAt: new Date().toISOString() }
        });
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifecycleGeneration += 1;
      unsubscribeBridge?.();
      unsubscribeBridge = null;
      unsubscribeOutreach?.();
      unsubscribeOutreach = null;
      outreachListeners.clear();
      documentLike.removeEventListener?.("goodjob:auth-state-changed", onAuthentication);
      listeners.clear();
    }
  });
  return runtime;
}

let installedDesktopRuntime: DesktopRuntimeState | null = null;

export function installDesktopRuntime(
  windowLike: unknown,
  documentLike: { body: { dataset: DOMStringMap }; addEventListener?: Document["addEventListener"]; removeEventListener?: Document["removeEventListener"] }
): DesktopRuntimeState {
  installedDesktopRuntime?.dispose();
  installedDesktopRuntime = createDesktopRuntimeState(getDesktopBridge(windowLike), documentLike);
  installedDesktopRuntime.start();
  return installedDesktopRuntime;
}

export function getInstalledDesktopRuntime(): DesktopRuntimeState | null {
  return installedDesktopRuntime?.bridge ? installedDesktopRuntime : null;
}

export function connectorCopy(status: ConnectorStatus): {
  title: string;
  action: string | null;
} {
  switch (status.state) {
    case "starting": return { title: "正在启动本地连接器", action: null };
    case "ready": return { title: "本地连接器已就绪", action: null };
    case "crashed": return { title: "本地连接器已停止", action: "重新启动" };
    case "stopped": return { title: "本地连接器未运行", action: "启动连接器" };
  }
}

export function desktopOutreachCopy(view: DesktopOutreachCoordinatorView | null): string {
  if (!view) return "桌面执行状态待确认";
  if (view.diagnostic === "binding_unavailable") return "设备授权或绑定不可用，请重新检测本机登录后重新绑定";
  if (view.diagnostic === "connector_unavailable") return "本地连接器不可用，未执行新动作";
  if (view.diagnostic === "central_unreachable") return "中心服务离线，未领取新动作";
  if (view.pendingReconciliationCount > 0 || view.state === "reconciling") return "等待只读对账，绝不会自动重发";
  const labels: Record<DesktopOutreachCoordinatorView["state"], string> = {
    disabled: "桌面执行尚未启用", unenrolled: "未注册此设备", unbound: "本机尚未绑定该抖音账号",
    offline: "中心服务离线，未领取新动作", idle: "桌面执行器已就绪", claiming: "正在检查待执行动作",
    claimed: "桌面应用已领取", executing: "正在通过本机抖音执行", reconciling: "等待只读对账，绝不会自动重发",
    risk_paused: "风险暂停", error: "桌面执行状态异常，未执行新动作", stopping: "桌面应用正在停止领取"
  };
  return labels[view.state];
}

export function outreachActionCopy(action: Pick<OutreachAction, "executionTarget" | "status" | "failureCode"> & Partial<Pick<OutreachAction, "kind">>): string {
  if (action.status === "succeeded" && action.kind === "comment") return "平台回执已确认";
  if (action.executionTarget === "desktop") {
    if (action.status === "reconciliation_required") return "等待只读对账，绝不会自动重发";
    if (action.status === "queued") return "等待桌面应用领取";
    if (action.status === "claimed") return "桌面应用已领取";
    if (action.status === "executing") return "正在通过本机抖音执行";
    if (action.status === "succeeded") return "已完成";
  }
  return { queued: "已排队", claimed: "已领取", blocked_by_predecessor: "等待评论回执", executing: "执行中", succeeded: "已送达", failed: "执行失败", risk_paused: "风险暂停", reconciliation_required: "等待只读对账，绝不会自动重发" }[action.status];
}
