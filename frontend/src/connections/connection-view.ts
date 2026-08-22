import type {
  ConnectionHealth,
  ModelConnection,
  ModelEndpointProfile,
  SearchConnection,
  SearchProvider
} from "./connection-api";

export type ConnectionCenterMode = "search" | "model";
export type ConnectionMutation =
  | "idle"
  | "saving"
  | "testing"
  | "activating"
  | "updating"
  | "deleting";

export interface ConnectionCenterState {
  mode: ConnectionCenterMode;
  status: "loading" | "ready" | "error";
  mutation: ConnectionMutation;
  providers: SearchProvider[];
  searchConnections: SearchConnection[];
  modelProfiles: ModelEndpointProfile[];
  modelConnections: ModelConnection[];
  selectedProviderId: string | null;
  selectedModelProfileId: string | null;
  selectedModelConnectionId: string | null;
  message: string;
  error: string;
  modelHealth: Record<string, ConnectionHealth>;
}

const MODEL_LABELS: Record<string, string> = {
  openai: "OpenAI",
  moonshot: "Kimi",
  minimax: "MiniMax",
  zhipu: "智谱 GLM",
  deepseek: "DeepSeek",
  qwen: "通义千问",
  doubao: "豆包",
  hunyuan: "腾讯混元",
  qianfan: "百度千帆"
};

const MODEL_DEFAULTS: Record<string, string> = {
  moonshot: "kimi-k3",
  minimax: "MiniMax-M3",
  zhipu: "glm-5.2"
};

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character] ?? character);
}

function safeHttpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function modelProviderLabel(provider: string): string {
  return MODEL_LABELS[provider] ?? provider;
}

export function defaultModelForProvider(provider: string): string {
  return MODEL_DEFAULTS[provider] ?? "";
}

function searchStatus(connection: SearchConnection | undefined): string {
  if (!connection) return "未配置";
  if (connection.status === "disabled" || connection.status === "inactive") {
    return "已禁用";
  }
  if (connection.lastHealthStatus === "failed" || connection.status === "error") {
    return "测试失败";
  }
  if (connection.status === "active" && connection.lastHealthStatus === "passed") {
    return "可用于任务";
  }
  return "已保存，待测试";
}

function selectedClass(selected: boolean): string {
  return selected ? " is-selected" : "";
}

function disabled(state: ConnectionCenterState): string {
  return state.mutation === "idle" && state.status === "ready" ? "" : " disabled";
}

function notice(state: ConnectionCenterState): string {
  if (state.error) {
    return `<p class="replica-connection-notice is-error" role="alert">${escapeHtml(state.error)}</p>`;
  }
  if (state.message) {
    return `<p class="replica-connection-notice" role="status" aria-live="polite">${escapeHtml(state.message)}</p>`;
  }
  return "";
}

function searchProviderCards(state: ConnectionCenterState): string {
  const searchProviders = state.providers.filter((provider) => provider.kind === "search");
  if (searchProviders.length === 0) {
    return `<div class="replica-connection-empty"><strong>暂无搜索数据源</strong><span>请检查后端服务和登录状态。</span></div>`;
  }
  return searchProviders.map((provider) => {
    const connection = state.searchConnections.find((item) =>
      item.providerId === provider.id && item.kind === "search");
    return `
      <button type="button" class="replica-connection-card${selectedClass(state.selectedProviderId === provider.id)}" aria-pressed="${state.selectedProviderId === provider.id}" data-connection-action="select-search-provider" data-provider-id="${escapeHtml(provider.id)}">
        <span><strong>${escapeHtml(provider.displayName)}</strong><small>${escapeHtml(provider.costNote || provider.capabilities.join(" / "))}</small></span>
        <em data-status="${escapeHtml(connection?.lastHealthStatus || "unconfigured")}">${escapeHtml(searchStatus(connection))}</em>
      </button>`;
  }).join("");
}

function searchEditor(state: ConnectionCenterState): string {
  const provider = state.providers.find((item) =>
    item.id === state.selectedProviderId && item.kind === "search");
  if (!provider) {
    return `<div class="replica-connection-empty"><strong>选择一个搜索数据源</strong><span>配置自己的官方 API Key。</span></div>`;
  }
  const connection = state.searchConnections.find((item) =>
    item.providerId === provider.id && item.kind === "search");
  const docsUrl = safeHttpsUrl(provider.officialDocsUrl);
  if (!connection) {
    return `
      <form class="replica-connection-editor" data-connection-form="create-search">
        <div class="replica-connection-editor-head">
          <div><span>搜索数据源</span><h3>连接 ${escapeHtml(provider.displayName)}</h3></div>
          ${docsUrl ? `<a href="${escapeHtml(docsUrl)}" target="_blank" rel="noreferrer noopener">官方文档</a>` : ""}
        </div>
        <p>使用你自己的官方密钥。保存后密钥不会再次显示。</p>
        <input type="hidden" name="providerId" value="${escapeHtml(provider.id)}">
        <label><span>官方 API Key</span><input name="apiKey" type="password" required maxlength="4000" autocomplete="new-password" spellcheck="false"><small>${escapeHtml(provider.keyHint || "密钥仅在提交时读取")}</small></label>
        <label><span>Base URL（可选）</span><input name="baseUrl" type="url" maxlength="2000" value="${escapeHtml(provider.defaultBaseUrl || "")}" placeholder="使用官方默认地址"></label>
        <button type="submit" class="replica-connection-primary"${disabled(state)}>${state.mutation === "saving" ? "正在保存" : "保存搜索连接"}</button>
      </form>`;
  }
  const readOnly = connection.ownerId === "system";
  return `
    <section class="replica-connection-editor">
      <div class="replica-connection-editor-head">
        <div><span>搜索数据源</span><h3>${escapeHtml(provider.displayName)}</h3></div>
        <strong class="replica-connection-state">${escapeHtml(searchStatus(connection))}</strong>
      </div>
      <dl class="replica-connection-facts">
        <div><dt>凭证版本</dt><dd>v${escapeHtml(connection.credentialVersion)}</dd></div>
        <div><dt>最近测试</dt><dd>${escapeHtml(connection.lastHealthAt || "尚未测试")}</dd></div>
        <div><dt>测试状态</dt><dd>${escapeHtml(connection.lastHealthMessage || searchStatus(connection))}</dd></div>
      </dl>
      <p class="replica-connection-usage"><i class="ph ph-info" aria-hidden="true"></i>测试搜索连接会产生一次真实 API 调用。</p>
      ${readOnly ? `<p class="replica-connection-notice">系统托管连接为只读。</p>` : `
        <div class="replica-connection-actions">
          <button type="button" data-connection-action="test-search" data-connection-id="${escapeHtml(connection.id)}"${disabled(state)}>${state.mutation === "testing" ? "正在测试" : "测试连接"}</button>
          <button type="button" data-connection-action="toggle-search" data-connection-id="${escapeHtml(connection.id)}" data-next-status="${connection.status === "active" ? "disabled" : "active"}"${disabled(state)}>${connection.status === "active" ? "禁用连接" : "启用连接"}</button>
          <button type="button" class="is-danger" data-connection-action="delete-search" data-connection-id="${escapeHtml(connection.id)}"${disabled(state)}>删除连接</button>
        </div>
        <form class="replica-connection-rotation" data-connection-form="rotate-search" data-connection-id="${escapeHtml(connection.id)}">
          <div><strong>轮换 API Key</strong><span>更换后需重新测试。</span></div>
          <label><span>新 API Key</span><input name="apiKey" type="password" required maxlength="4000" autocomplete="new-password" spellcheck="false"></label>
          <button type="submit"${disabled(state)}>${state.mutation === "updating" ? "正在更新" : "确认轮换"}</button>
        </form>`}
    </section>`;
}

function modelCards(state: ConnectionCenterState): string {
  const connectionCards = state.modelConnections.map((connection) => `
    <button type="button" class="replica-connection-card${selectedClass(state.selectedModelConnectionId === connection.id)}" aria-pressed="${state.selectedModelConnectionId === connection.id}" data-connection-action="select-model-connection" data-connection-id="${escapeHtml(connection.id)}">
      <span><strong>${escapeHtml(modelProviderLabel(connection.provider))}</strong><small>${escapeHtml(connection.model)}</small></span>
      <em data-status="${escapeHtml(connection.status)}">${connection.status === "active" ? "已启用" : "未启用"}</em>
    </button>`).join("");
  const profileCards = state.modelProfiles.map((profile) => {
    const supported = Boolean(profile.baseUrl) && !profile.requiresWorkspaceId;
    return `
    <button type="button" class="replica-connection-card is-new${selectedClass(state.selectedModelProfileId === profile.endpointProfileId && !state.selectedModelConnectionId)}" aria-pressed="${state.selectedModelProfileId === profile.endpointProfileId && !state.selectedModelConnectionId}" data-connection-action="select-model-profile" data-profile-id="${escapeHtml(profile.endpointProfileId)}"${supported ? "" : " disabled"}>
      <span><strong>${escapeHtml(modelProviderLabel(profile.provider))}</strong><small>${escapeHtml(profile.region.toUpperCase())} 官方端点</small></span>
      <em>${supported ? "新增" : "暂不可用"}</em>
    </button>`;
  }).join("");
  return connectionCards + profileCards || `<div class="replica-connection-empty"><strong>暂无模型端点</strong><span>请检查后端模型配置。</span></div>`;
}

function modelEditor(state: ConnectionCenterState): string {
  const connection = state.modelConnections.find((item) =>
    item.id === state.selectedModelConnectionId);
  if (connection) {
    const health = state.modelHealth[connection.id];
    return `
      <section class="replica-connection-editor">
        <div class="replica-connection-editor-head">
          <div><span>AI 模型</span><h3>${escapeHtml(modelProviderLabel(connection.provider))} / ${escapeHtml(connection.model)}</h3></div>
          <strong class="replica-connection-state">${connection.status === "active" ? "已启用" : "待启用"}</strong>
        </div>
        <dl class="replica-connection-facts">
          <div><dt>凭证版本</dt><dd>v${escapeHtml(connection.credentialVersion)}</dd></div>
          <div><dt>工具调用</dt><dd>${connection.capabilitySnapshot.toolCalling ? "支持工具调用" : "不支持"}</dd></div>
          <div><dt>端点认证</dt><dd>${escapeHtml(connection.endpointProfileId || "已由服务端校验")}</dd></div>
        </dl>
        ${health ? `<p class="replica-connection-notice${health.ok ? "" : " is-error"}" role="status" aria-live="polite">${escapeHtml(health.message)}</p>` : ""}
        <p class="replica-connection-usage"><i class="ph ph-info" aria-hidden="true"></i>测试模型会产生一次真实模型调用。</p>
        <div class="replica-connection-actions">
          <button type="button" data-connection-action="test-model" data-connection-id="${escapeHtml(connection.id)}"${disabled(state)}>${state.mutation === "testing" ? "正在测试" : "测试模型"}</button>
          ${connection.status !== "active" && connection.capabilitySnapshot.toolCalling
            ? `<button type="button" class="replica-connection-primary" data-connection-action="activate-model" data-connection-id="${escapeHtml(connection.id)}"${disabled(state)}>${state.mutation === "activating" ? "正在启用" : "启用模型"}</button>`
            : ""}
          ${connection.status === "active"
            ? `<span class="replica-connection-action-note">切换到其他模型后才能删除</span>`
            : `<button type="button" class="is-danger" data-connection-action="delete-model" data-connection-id="${escapeHtml(connection.id)}"${disabled(state)}>删除连接</button>`}
        </div>
        ${connection.status === "active" ? "" : `
          <form class="replica-connection-rotation" data-connection-form="rotate-model" data-connection-id="${escapeHtml(connection.id)}">
            <div><strong>更新模型凭证</strong><span>可同时更新模型名或 API Key。</span></div>
            <label><span>模型名</span><input name="model" maxlength="120" value="${escapeHtml(connection.model)}"></label>
            <label><span>新 API Key（可选）</span><input name="apiKey" type="password" maxlength="400" autocomplete="new-password" spellcheck="false"></label>
            <button type="submit"${disabled(state)}>${state.mutation === "updating" ? "正在更新" : "更新连接"}</button>
          </form>`}
      </section>`;
  }

  const profile = state.modelProfiles.find((item) =>
    item.endpointProfileId === state.selectedModelProfileId)
    ?? state.modelProfiles[0];
  if (!profile) {
    return `<div class="replica-connection-empty"><strong>选择一个 AI 模型</strong><span>支持 Kimi、MiniMax、GLM 及其他官方端点。</span></div>`;
  }
  if (!profile.baseUrl || profile.requiresWorkspaceId) {
    return `<div class="replica-connection-empty"><strong>暂不支持工作空间端点</strong><span>该官方端点需要工作空间级地址，当前后端连接合同尚未提供 Workspace ID。请先选择其他官方端点。</span></div>`;
  }
  const reference = safeHttpsUrl(profile.officialReference);
  return `
    <form class="replica-connection-editor" data-connection-form="create-model">
      <div class="replica-connection-editor-head">
        <div><span>AI 模型</span><h3>连接 ${escapeHtml(modelProviderLabel(profile.provider))}</h3></div>
        ${reference ? `<a href="${escapeHtml(reference)}" target="_blank" rel="noreferrer noopener">官方文档</a>` : ""}
      </div>
      <p>端点和工具调用能力由服务端校验，前端不会自行声明能力。</p>
      <input type="hidden" name="provider" value="${escapeHtml(profile.provider)}">
      <input type="hidden" name="baseUrl" value="${escapeHtml(profile.baseUrl)}">
      <label><span>连接名称</span><input name="name" maxlength="120" value="${escapeHtml(modelProviderLabel(profile.provider))} 获客模型"></label>
      <label><span>模型名</span><input name="model" required maxlength="120" value="${escapeHtml(defaultModelForProvider(profile.provider))}" placeholder="填写服务端已认证的模型名"></label>
      <label><span>官方 API Key</span><input name="apiKey" type="password" required maxlength="400" autocomplete="new-password" spellcheck="false"><small>密钥保存后不会再次显示。</small></label>
      <button type="submit" class="replica-connection-primary"${disabled(state)}>${state.mutation === "saving" ? "正在保存" : "保存 AI 模型"}</button>
    </form>`;
}

export function renderConnectionCenter(state: ConnectionCenterState): string {
  const loading = state.status === "loading"
    ? `<div class="replica-connection-loading" role="status"><span></span><strong>正在读取真实连接</strong></div>`
    : "";
  return `
    <div class="replica-connection-tabs" role="tablist" aria-label="连接类型">
      <button type="button" id="replicaConnectionSearchTab" role="tab" aria-controls="replicaConnectionWorkspace" aria-selected="${state.mode === "search"}" class="${state.mode === "search" ? "active" : ""}" data-connection-action="switch-mode" data-mode="search">搜索数据源</button>
      <button type="button" id="replicaConnectionModelTab" role="tab" aria-controls="replicaConnectionWorkspace" aria-selected="${state.mode === "model"}" class="${state.mode === "model" ? "active" : ""}" data-connection-action="switch-mode" data-mode="model">AI 模型</button>
    </div>
    ${loading}
    ${notice(state)}
    <div id="replicaConnectionWorkspace" class="replica-connection-workspace${state.status === "loading" ? " is-loading" : ""}" role="tabpanel" aria-labelledby="${state.mode === "search" ? "replicaConnectionSearchTab" : "replicaConnectionModelTab"}">
      <aside class="replica-connection-catalog" aria-label="${state.mode === "search" ? "搜索数据源" : "AI 模型"}">
        ${state.mode === "search" ? searchProviderCards(state) : modelCards(state)}
      </aside>
      <div class="replica-connection-detail">
        ${state.mode === "search" ? searchEditor(state) : modelEditor(state)}
      </div>
    </div>`;
}
