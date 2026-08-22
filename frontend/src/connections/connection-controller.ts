import {
  createConnectionSettingsApi,
  type ModelConnectionCreateInput,
  type ModelConnectionUpdateInput,
  type SearchConnectionCreateInput
} from "./connection-api";
import {
  renderConnectionCenter,
  type ConnectionCenterMode,
  type ConnectionCenterState,
  type ConnectionMutation
} from "./connection-view";

export type ConnectionCenterApi = ReturnType<typeof createConnectionSettingsApi>;

export interface ConnectionCenterControllerOptions {
  api?: ConnectionCenterApi;
  eventTarget?: EventTarget;
  root?: HTMLElement | null;
  body?: HTMLElement | null;
  keyFactory?: () => string;
  confirm?: (message: string) => boolean;
}

export interface ConnectionCenterController {
  getState(): Readonly<ConnectionCenterState>;
  whenIdle(): Promise<void>;
  open(mode?: ConnectionCenterMode): Promise<void>;
  close(): void;
  switchMode(mode: ConnectionCenterMode): void;
  selectSearchProvider(providerId: string): void;
  selectModelProfile(profileId: string): void;
  selectModelConnection(connectionId: string): void;
  createSearch(input: SearchConnectionCreateInput): Promise<void>;
  testSearch(connectionId: string): Promise<void>;
  toggleSearch(connectionId: string): Promise<void>;
  rotateSearch(connectionId: string, apiKey: string): Promise<void>;
  deleteSearch(connectionId: string): Promise<void>;
  createModel(input: ModelConnectionCreateInput): Promise<void>;
  testModel(connectionId: string): Promise<void>;
  activateModel(connectionId: string): Promise<void>;
  rotateModel(
    connectionId: string,
    input: ModelConnectionUpdateInput
  ): Promise<void>;
  deleteModel(connectionId: string): Promise<void>;
  destroy(): void;
}

interface ConnectionOpenDetail {
  mode?: unknown;
  kind?: unknown;
}

let singleton: ConnectionCenterController | null = null;

function defaultEventTarget(): EventTarget {
  return typeof document === "undefined" ? new EventTarget() : document;
}

function defaultKey(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return `connection-ui-${random ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function defaultConfirm(message: string): boolean {
  return typeof window === "undefined" ? true : window.confirm(message);
}

function initialState(): ConnectionCenterState {
  return {
    mode: "search",
    status: "ready",
    mutation: "idle",
    providers: [],
    searchConnections: [],
    modelProfiles: [],
    modelConnections: [],
    selectedProviderId: null,
    selectedModelProfileId: null,
    selectedModelConnectionId: null,
    message: "",
    error: "",
    modelHealth: {}
  };
}

function validMode(value: unknown): ConnectionCenterMode | null {
  return value === "search" || value === "model" ? value : null;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "连接操作失败，请稍后重试";
}

function normalizedRequired(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${label}不能为空`);
  return result;
}

function optional(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function fingerprint(value: unknown): string {
  const serialized = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function customEvent<T>(name: string, detail: T): Event {
  if (typeof CustomEvent === "function") {
    return new CustomEvent<T>(name, { detail });
  }
  const event = new Event(name);
  Object.defineProperty(event, "detail", { value: detail });
  return event;
}

export function isConnectionCenterCloseControl(id: string): boolean {
  return id === "replicaConnectionCenterClose"
    || id === "replicaConnectionCenterDone"
    || id === "replicaConnectionCenterCancel";
}

function field(form: HTMLFormElement, name: string): string {
  const control = form.elements.namedItem(name);
  if (!control || !("value" in control)) return "";
  return String(control.value ?? "").trim();
}

export function createConnectionCenterController(
  options: ConnectionCenterControllerOptions = {}
): ConnectionCenterController {
  const api = options.api ?? createConnectionSettingsApi();
  const eventTarget = options.eventTarget ?? defaultEventTarget();
  const keyFactory = options.keyFactory ?? defaultKey;
  const ask = options.confirm ?? defaultConfirm;
  const pendingIdempotencyKeys = new Map<string, string>();
  const state = initialState();
  let root = options.root
    ?? (typeof document === "undefined"
      ? null
      : document.getElementById("replicaConnectionCenter"));
  let body = options.body
    ?? (root?.querySelector<HTMLElement>("#replicaConnectionCenterBody") ?? null);
  let disposed = false;
  let loadSerial = 0;
  let idlePromise = Promise.resolve();

  function remember<T>(promise: Promise<T>): Promise<T> {
    idlePromise = promise.then(() => undefined, () => undefined);
    return promise;
  }

  function render(): void {
    if (body) body.innerHTML = renderConnectionCenter(state);
  }

  function resolveDom(): void {
    if (typeof document === "undefined") return;
    root ??= document.getElementById("replicaConnectionCenter");
    body ??= root?.querySelector<HTMLElement>("#replicaConnectionCenterBody") ?? null;
  }

  function showRoot(): void {
    resolveDom();
    if (!root) return;
    root.hidden = false;
    root.classList.add("is-open");
    root.setAttribute("aria-hidden", "false");
    const dialog = root as HTMLDialogElement;
    if (typeof dialog.showModal === "function" && !dialog.open) {
      dialog.showModal();
    }
  }

  function hideRoot(): void {
    if (!root) return;
    const dialog = root as HTMLDialogElement;
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    root.hidden = true;
    root.classList.remove("is-open");
    root.setAttribute("aria-hidden", "true");
  }

  function ensureSelections(): void {
    const searchProviders = state.providers.filter((item) => item.kind === "search");
    if (!searchProviders.some((item) => item.id === state.selectedProviderId)) {
      state.selectedProviderId = searchProviders[0]?.id ?? null;
    }

    if (state.selectedModelConnectionId
      && !state.modelConnections.some((item) => item.id === state.selectedModelConnectionId)) {
      state.selectedModelConnectionId = null;
    }
    if (state.selectedModelProfileId
      && !state.modelProfiles.some((item) =>
        item.endpointProfileId === state.selectedModelProfileId)) {
      state.selectedModelProfileId = null;
    }
    if (!state.selectedModelConnectionId && !state.selectedModelProfileId) {
      if (state.modelConnections[0]) {
        state.selectedModelConnectionId = state.modelConnections[0].id;
      } else {
        const connectableProfile = state.modelProfiles.find((profile) =>
          Boolean(profile.baseUrl) && !profile.requiresWorkspaceId);
        state.selectedModelProfileId =
          (connectableProfile ?? state.modelProfiles[0])?.endpointProfileId ?? null;
      }
    }
  }

  async function load(message = ""): Promise<void> {
    const serial = ++loadSerial;
    state.status = "loading";
    state.error = "";
    state.message = message;
    render();
    try {
      const [providers, searchConnections, modelProfiles, modelConnections] =
        await Promise.all([
          api.listSearchProviders(),
          api.listSearchConnections(),
          api.listModelEndpointProfiles(),
          api.listModelConnections()
        ]);
      if (disposed || serial !== loadSerial) return;
      state.providers = providers;
      state.searchConnections = searchConnections;
      state.modelProfiles = modelProfiles;
      state.modelConnections = modelConnections;
      state.status = "ready";
      ensureSelections();
    } catch (error) {
      if (disposed || serial !== loadSerial) return;
      state.status = "error";
      state.error = errorText(error);
    }
    render();
  }

  function stableKey(operation: string, payload: unknown): {
    id: string;
    value: string;
  } {
    const id = `${operation}:${fingerprint(payload)}`;
    let value = pendingIdempotencyKeys.get(id);
    if (!value) {
      value = keyFactory();
      pendingIdempotencyKeys.set(id, value);
    }
    return { id, value };
  }

  async function idempotent<T>(
    operation: string,
    payload: unknown,
    execute: (key: string) => Promise<T>
  ): Promise<T> {
    const key = stableKey(operation, payload);
    const result = await execute(key.value);
    pendingIdempotencyKeys.delete(key.id);
    return result;
  }

  function notifyChanged(
    kind: ConnectionCenterMode,
    connectionId: string
  ): void {
    eventTarget.dispatchEvent(customEvent("goodjob:connections-changed", {
      kind,
      connectionId
    }));
  }

  async function mutate<T>(
    mutation: Exclude<ConnectionMutation, "idle">,
    execute: () => Promise<T>,
    success: (result: T) => {
      kind: ConnectionCenterMode;
      connectionId: string;
      message: string;
    }
  ): Promise<void> {
    if (state.mutation !== "idle") {
      throw new Error("另一项连接操作正在进行，请稍候");
    }
    state.mutation = mutation;
    state.error = "";
    state.message = "";
    render();
    let result: T;
    try {
      result = await execute();
    } catch (error) {
      state.mutation = "idle";
      state.error = errorText(error);
      render();
      throw error;
    }
    const outcome = success(result);
    state.mutation = "idle";
    notifyChanged(outcome.kind, outcome.connectionId);
    await load(outcome.message);
  }

  const controller: ConnectionCenterController = {
    getState() {
      return state;
    },

    whenIdle() {
      return idlePromise;
    },

    open(mode = state.mode) {
      state.mode = mode;
      showRoot();
      return remember(load());
    },

    close() {
      if (state.mutation !== "idle") return;
      hideRoot();
    },

    switchMode(mode) {
      state.mode = mode;
      state.error = "";
      state.message = "";
      ensureSelections();
      render();
    },

    selectSearchProvider(providerId) {
      if (!state.providers.some((item) =>
        item.id === providerId && item.kind === "search")) return;
      state.selectedProviderId = providerId;
      state.error = "";
      state.message = "";
      render();
    },

    selectModelProfile(profileId) {
      if (!state.modelProfiles.some((item) =>
        item.endpointProfileId === profileId)) return;
      state.selectedModelProfileId = profileId;
      state.selectedModelConnectionId = null;
      state.error = "";
      state.message = "";
      render();
    },

    selectModelConnection(connectionId) {
      if (!state.modelConnections.some((item) => item.id === connectionId)) return;
      state.selectedModelConnectionId = connectionId;
      state.selectedModelProfileId = null;
      state.error = "";
      state.message = "";
      render();
    },

    createSearch(input) {
      const normalized: SearchConnectionCreateInput = {
        providerId: normalizedRequired(input.providerId, "搜索数据源"),
        apiKey: normalizedRequired(input.apiKey, "API Key"),
        ...(optional(input.baseUrl) ? { baseUrl: optional(input.baseUrl) } : {}),
        status: "disabled"
      };
      return remember(mutate(
        "saving",
        () => idempotent("create-search", normalized, (key) =>
          api.createSearchConnection(normalized, key)),
        (connection) => {
          state.selectedProviderId = connection.providerId;
          return {
            kind: "search",
            connectionId: connection.id,
            message: "搜索连接已保存，请测试通过后再启用。"
          };
        }
      ));
    },

    testSearch(connectionId) {
      const id = normalizedRequired(connectionId, "搜索连接 ID");
      return remember(mutate(
        "testing",
        async () => {
          const health = await api.testSearchConnection(id);
          if (!health.ok) throw new Error(health.message || "搜索连接测试未通过");
          return health;
        },
        (health) => ({
          kind: "search",
          connectionId: id,
          message: health.message || "搜索连接测试通过"
        })
      ));
    },

    toggleSearch(connectionId) {
      const connection = state.searchConnections.find((item) =>
        item.id === connectionId);
      if (!connection) return Promise.reject(new Error("搜索连接不存在"));
      const nextStatus = connection.status === "active" ? "disabled" : "active";
      if (nextStatus === "active" && connection.lastHealthStatus !== "passed") {
        const error = new Error("请先测试搜索连接，通过后才能启用");
        state.error = error.message;
        render();
        return Promise.reject(error);
      }
      return remember(mutate(
        "updating",
        () => api.updateSearchConnection(connection.id, { status: nextStatus }),
        (updated) => ({
          kind: "search",
          connectionId: updated.id,
          message: nextStatus === "active" ? "搜索连接已启用" : "搜索连接已禁用"
        })
      ));
    },

    rotateSearch(connectionId, apiKey) {
      const id = normalizedRequired(connectionId, "搜索连接 ID");
      const nextKey = normalizedRequired(apiKey, "新 API Key");
      return remember(mutate(
        "updating",
        () => api.updateSearchConnection(id, {
          apiKey: nextKey,
          status: "disabled"
        }),
        (connection) => ({
          kind: "search",
          connectionId: connection.id,
          message: "搜索密钥已轮换，连接已禁用，请重新测试。"
        })
      ));
    },

    deleteSearch(connectionId) {
      const id = normalizedRequired(connectionId, "搜索连接 ID");
      if (!ask("确认删除这个搜索连接？删除后任务将不再使用它。")) {
        return Promise.resolve();
      }
      return remember(mutate(
        "deleting",
        () => api.deleteSearchConnection(id),
        () => ({
          kind: "search",
          connectionId: id,
          message: "搜索连接已删除"
        })
      ));
    },

    createModel(input) {
      const normalized: ModelConnectionCreateInput = {
        provider: normalizedRequired(input.provider, "模型厂商"),
        name: optional(input.name),
        baseUrl: normalizedRequired(input.baseUrl, "官方 Base URL"),
        model: normalizedRequired(input.model, "模型名"),
        apiKey: normalizedRequired(input.apiKey, "API Key"),
        active: false
      };
      return remember(mutate(
        "saving",
        () => idempotent("create-model", normalized, (key) =>
          api.createModelConnection(normalized, key)),
        (connection) => {
          state.selectedModelConnectionId = connection.id;
          state.selectedModelProfileId = null;
          return {
            kind: "model",
            connectionId: connection.id,
            message: connection.capabilitySnapshot.toolCalling
              ? "AI 模型已保存，请测试通过后再启用。"
              : "AI 模型已保存，但服务端认证为不支持工具调用。"
          };
        }
      ));
    },

    testModel(connectionId) {
      const id = normalizedRequired(connectionId, "模型连接 ID");
      return remember(mutate(
        "testing",
        async () => {
          const health = await api.testModelConnection(id);
          state.modelHealth[id] = health;
          if (!health.ok) throw new Error(health.message || "模型连接测试未通过");
          return health;
        },
        (health) => ({
          kind: "model",
          connectionId: id,
          message: health.message || "模型连接测试通过"
        })
      ));
    },

    activateModel(connectionId) {
      const id = normalizedRequired(connectionId, "模型连接 ID");
      const connection = state.modelConnections.find((item) => item.id === id);
      if (!connection) return Promise.reject(new Error("模型连接不存在"));
      if (!connection.capabilitySnapshot.toolCalling) {
        return Promise.reject(new Error("该模型未通过工具调用能力认证，不能用于获客任务"));
      }
      if (!state.modelHealth[id]?.ok) {
        const error = new Error("请先测试模型连接，通过后才能启用");
        state.error = error.message;
        render();
        return Promise.reject(error);
      }
      const reason = "已人工测试，启用为获客任务工具调用模型";
      return remember(mutate(
        "activating",
        () => idempotent("activate-model", { id, reason }, (key) =>
          api.activateModelConnection(id, reason, key)),
        (activated) => ({
          kind: "model",
          connectionId: activated.id,
          message: "AI 模型已启用，可用于真实获客任务。"
        })
      ));
    },

    rotateModel(connectionId, input) {
      const id = normalizedRequired(connectionId, "模型连接 ID");
      const existing = state.modelConnections.find((item) => item.id === id);
      if (existing?.status === "active") {
        return Promise.reject(new Error(
          "正在启用的模型不能直接修改，请先启用另一模型后再更新"
        ));
      }
      const normalized: ModelConnectionUpdateInput = {
        ...(optional(input.name) ? { name: optional(input.name) } : {}),
        ...(optional(input.baseUrl) ? { baseUrl: optional(input.baseUrl) } : {}),
        ...(optional(input.model) ? { model: optional(input.model) } : {}),
        ...(optional(input.apiKey) ? { apiKey: optional(input.apiKey) } : {})
      };
      if (Object.keys(normalized).length === 0) {
        return Promise.reject(new Error("请填写需要更新的模型名或 API Key"));
      }
      return remember(mutate(
        "updating",
        () => idempotent("rotate-model", { id, ...normalized }, (key) =>
          api.updateModelConnection(id, normalized, key)),
        (connection) => {
          delete state.modelHealth[id];
          return {
            kind: "model",
            connectionId: connection.id,
            message: "AI 模型连接已更新，请重新测试后再启用。"
          };
        }
      ));
    },

    deleteModel(connectionId) {
      const id = normalizedRequired(connectionId, "模型连接 ID");
      const existing = state.modelConnections.find((item) => item.id === id);
      if (existing?.status === "active") {
        return Promise.reject(new Error(
          "正在启用的模型不能删除，请先启用另一模型"
        ));
      }
      if (!ask("确认删除这个 AI 模型连接？正在使用的连接可能会被服务端拒绝删除。")) {
        return Promise.resolve();
      }
      return remember(mutate(
        "deleting",
        () => idempotent("delete-model", { id }, (key) =>
          api.deleteModelConnection(id, key)),
        () => {
          delete state.modelHealth[id];
          return {
            kind: "model",
            connectionId: id,
            message: "AI 模型连接已删除"
          };
        }
      ));
    },

    destroy() {
      if (disposed) return;
      disposed = true;
      loadSerial += 1;
      pendingIdempotencyKeys.clear();
      eventTarget.removeEventListener(
        "goodjob:connections-open-requested",
        onOpenRequested as EventListener
      );
      root?.removeEventListener("click", onRootClick);
      root?.removeEventListener("submit", onRootSubmit);
      root?.removeEventListener("cancel", onRootCancel);
    }
  };

  function consume(promise: Promise<void>): void {
    void promise.catch(() => undefined);
  }

  function onOpenRequested(event: Event): void {
    const detail = (event as CustomEvent<ConnectionOpenDetail>).detail;
    const mode = validMode(detail?.mode) ?? validMode(detail?.kind) ?? state.mode;
    consume(controller.open(mode));
  }

  function actionTarget(event: Event): HTMLElement | null {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    const action = target.closest<HTMLElement>("[data-connection-action]");
    return action && root?.contains(action) ? action : null;
  }

  function onRootClick(event: Event): void {
    const target = actionTarget(event);
    const fallbackClose = event.target instanceof Element
      ? event.target.closest<HTMLElement>("button[id]")
      : null;
    if (fallbackClose
      && isConnectionCenterCloseControl(fallbackClose.id)
      && root?.contains(fallbackClose)) {
      controller.close();
      return;
    }
    if (!target) return;
    const action = target.dataset.connectionAction;
    if (action === "close") {
      controller.close();
    } else if (action === "switch-mode") {
      const mode = validMode(target.dataset.mode);
      if (mode) controller.switchMode(mode);
    } else if (action === "select-search-provider") {
      controller.selectSearchProvider(target.dataset.providerId ?? "");
    } else if (action === "select-model-profile") {
      controller.selectModelProfile(target.dataset.profileId ?? "");
    } else if (action === "select-model-connection") {
      controller.selectModelConnection(target.dataset.connectionId ?? "");
    } else if (action === "test-search") {
      consume(controller.testSearch(target.dataset.connectionId ?? ""));
    } else if (action === "toggle-search") {
      consume(controller.toggleSearch(target.dataset.connectionId ?? ""));
    } else if (action === "delete-search") {
      consume(controller.deleteSearch(target.dataset.connectionId ?? ""));
    } else if (action === "test-model") {
      consume(controller.testModel(target.dataset.connectionId ?? ""));
    } else if (action === "activate-model") {
      consume(controller.activateModel(target.dataset.connectionId ?? ""));
    } else if (action === "delete-model") {
      consume(controller.deleteModel(target.dataset.connectionId ?? ""));
    }
  }

  function onRootSubmit(event: Event): void {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.connectionForm) return;
    event.preventDefault();
    if (!form.reportValidity()) return;
    const formType = form.dataset.connectionForm;
    if (formType === "create-search") {
      consume(controller.createSearch({
        providerId: field(form, "providerId"),
        apiKey: field(form, "apiKey"),
        baseUrl: field(form, "baseUrl")
      }));
    } else if (formType === "rotate-search") {
      consume(controller.rotateSearch(
        form.dataset.connectionId ?? "",
        field(form, "apiKey")
      ));
    } else if (formType === "create-model") {
      consume(controller.createModel({
        provider: field(form, "provider"),
        name: field(form, "name"),
        baseUrl: field(form, "baseUrl"),
        model: field(form, "model"),
        apiKey: field(form, "apiKey"),
        active: false
      }));
    } else if (formType === "rotate-model") {
      consume(controller.rotateModel(
        form.dataset.connectionId ?? "",
        {
          model: field(form, "model"),
          apiKey: field(form, "apiKey")
        }
      ));
    }
  }

  function onRootCancel(event: Event): void {
    event.preventDefault();
    controller.close();
  }

  eventTarget.addEventListener(
    "goodjob:connections-open-requested",
    onOpenRequested as EventListener
  );
  resolveDom();
  root?.addEventListener("click", onRootClick);
  root?.addEventListener("submit", onRootSubmit);
  root?.addEventListener("cancel", onRootCancel);
  render();

  return controller;
}

export function startConnectionCenter(): ConnectionCenterController {
  singleton ??= createConnectionCenterController();
  return singleton;
}
