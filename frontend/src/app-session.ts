import { normalizeAppHash } from "./app-route";
import type { components } from "./generated/platform-admin";

type CustomerAccess = components["schemas"]["CustomerAccess"];
type SessionResponse = { user: AppUser; access?: CustomerAccess };

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: "sales" | "manager" | "admin" | "super_admin";
  teamId: string;
  avatar: string;
}

export interface AppSessionController {
  start(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  register(account: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refreshAccess(): Promise<void>;
  destroy(): void;
}

export type AppSessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface AppSessionOptions {
  document?: Document;
  location?: Pick<Location, "hash">;
  storage?: AppSessionStorage;
  fetchImpl?: typeof fetch;
  cookieSource?: () => string;
  demoMode?: boolean;
  realTrial?: boolean;
  loginAlias?: string;
  loginEmail?: string;
}

const STORAGE_KEY = "gj_user";
type AuthenticationMode = "login" | "register";
const REGISTRATION_ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/u;

export interface ClearAppSessionOptions {
  document?: Document;
  storage?: AppSessionStorage;
}

class AppSessionRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AppSessionRequestError";
  }
}

class TrialLoginConfigurationError extends Error {
  constructor() {
    super("trial_login_configuration_incomplete");
    this.name = "TrialLoginConfigurationError";
  }
}

export function resolveLoginIdentity(
  value: string,
  aliases: Readonly<Record<string, string>>
): string {
  const normalized = value.trim().toLowerCase();
  const hasOwn = (Object as typeof Object & {
    hasOwn(object: object, property: PropertyKey): boolean;
  }).hasOwn;
  return hasOwn(aliases, normalized) ? aliases[normalized] : value;
}

const roleLabels: Record<AppUser["role"], string> = {
  sales: "业务员",
  manager: "销售主管",
  admin: "管理员",
  super_admin: "超级管理员"
};

function publishAuthenticationState(documentRef: Document, authenticated: boolean): void {
  const event = documentRef.createEvent("CustomEvent");
  event.initCustomEvent("goodjob:auth-state-changed", false, false, { authenticated });
  documentRef.dispatchEvent(event);
}

function updateSidebarUser(documentRef: Document, user: AppUser | null): void {
  const name = documentRef.querySelector<HTMLElement>("[data-session-user-name]");
  const role = documentRef.querySelector<HTMLElement>("[data-session-user-role]");
  if (name) name.textContent = user?.name ?? "";
  if (role) role.textContent = user ? roleLabels[user.role] : "";
}

/**
 * Removes the renderer's cached identity after the server has rejected its
 * session. The server cookie remains the source of authority; this only
 * prevents the shell from continuing to look authenticated after expiry.
 */
export function clearAppSession(options: ClearAppSessionOptions = {}): boolean {
  const documentRef = options.document ?? document;
  const storage = options.storage ?? localStorage;
  const hadSession = storage.getItem(STORAGE_KEY) !== null
    || documentRef.body.classList.contains("is-authenticated")
    || documentRef.body.dataset.sessionMode !== undefined
    || documentRef.body.dataset.sessionUserId !== undefined
    || documentRef.body.dataset.sessionWorkspaceId !== undefined;
  storage.removeItem(STORAGE_KEY);
  documentRef.body.classList.remove("is-authenticated");
  delete documentRef.body.dataset.sessionMode;
  delete documentRef.body.dataset.sessionUserId;
  delete documentRef.body.dataset.sessionWorkspaceId;
  delete documentRef.body.dataset.accountAccess;
  documentRef.querySelector("[data-account-access-panel]")?.remove();
  updateSidebarUser(documentRef, null);
  if (hadSession) publishAuthenticationState(documentRef, false);
  return hadSession;
}

function isWriteRequest(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method);
}

function readCookie(cookieSource: () => string, name: string): string {
  const encoded = (cookieSource() || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!encoded) return "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function createDemoAdmin(): AppUser {
  return {
    id: "demo-admin",
    name: "Admin",
    email: "admin@goodjob.com",
    role: "admin",
    teamId: "demo-team",
    avatar: "AD"
  };
}

export function createAppSessionController(options: AppSessionOptions = {}): AppSessionController {
  const documentRef = options.document ?? document;
  const locationRef = options.location ?? window.location;
  const storage = options.storage ?? localStorage;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cookieSource = options.cookieSource ?? (() => documentRef.cookie);
  const demoMode = options.demoMode ?? (import.meta.env.DEV && !import.meta.env.VITE_API_TARGET?.trim());
  const realTrial = options.realTrial ?? import.meta.env?.VITE_REAL_TRIAL === "true";
  const trialLoginAlias: string = options.loginAlias ?? import.meta.env?.VITE_TRIAL_LOGIN_ALIAS ?? "";
  const trialLoginEmail: string = options.loginEmail ?? import.meta.env?.VITE_TRIAL_LOGIN_EMAIL ?? "";
  const normalizedTrialAliases = trialLoginAlias
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const normalizedTrialEmails = trialLoginEmail
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const trialConfigurationIncomplete = realTrial
    && (!normalizedTrialAliases.length
      || normalizedTrialAliases.length !== normalizedTrialEmails.length);
  const loginAliases = realTrial && !trialConfigurationIncomplete
    ? Object.fromEntries(normalizedTrialAliases.map((alias, index) => [
        alias,
        normalizedTrialEmails[index]
      ]))
    : {};
  let started = false;
  let lifecycleGeneration = 0;
  let authenticationMode: AuthenticationMode = "login";
  let refreshingAccess = false;

  const loginForm = documentRef.querySelector<HTMLFormElement>("#loginForm");
  const loginButton = documentRef.querySelector<HTMLButtonElement>("#loginButton");
  const loginError = documentRef.querySelector<HTMLElement>("#loginError");
  const loginEyebrow = documentRef.querySelector<HTMLElement>("#loginEyebrow");
  const loginTitle = documentRef.querySelector<HTMLElement>("#loginTitle");
  const loginDescription = documentRef.querySelector<HTMLElement>("#loginDescription");
  const loginAccount = documentRef.querySelector<HTMLInputElement>("#loginEmail");
  const loginPassword = documentRef.querySelector<HTMLInputElement>("#loginPassword");
  const loginModeToggle = documentRef.querySelector<HTMLButtonElement>("#loginModeToggle");
  const logoutButton = documentRef.querySelector<HTMLButtonElement>("#replicaLogoutButton");

  const clearLoginError = () => {
    if (loginError) loginError.textContent = "";
  };

  const showSafeLoginError = (error: unknown, mode: AuthenticationMode = "login") => {
    if (!loginError) return;
    if (error instanceof TypeError) {
      loginError.textContent = "网络连接失败，请检查网络后重试";
      return;
    }
    if (error instanceof AppSessionRequestError) {
      if (mode === "register" && error.status === 409) {
        loginError.textContent = "账号已存在，请直接登录";
        return;
      }
      if (mode === "register" && error.status === 400) {
        loginError.textContent = "账号或密码格式不正确，请检查后重试";
        return;
      }
      if (mode === "register" && error.status === 429) {
        loginError.textContent = "注册过于频繁，请稍后重试";
        return;
      }
      if (mode === "login" && error.status === 401) {
        loginError.textContent = "账号或密码错误，或账号已停用，请联系运营确认。";
        return;
      }
    }
    loginError.textContent = mode === "register"
      ? "注册失败，请稍后重试"
      : "登录失败，请稍后重试";
  };

  const setLoginPending = (pending: boolean) => {
    loginForm?.setAttribute("aria-busy", String(pending));
    if (loginModeToggle) loginModeToggle.disabled = demoMode || pending;
    if (!loginButton) return;
    loginButton.disabled = pending;
    loginButton.textContent = pending
      ? authenticationMode === "register" ? "正在创建" : "正在验证"
      : authenticationMode === "register" ? "注册账号" : "登录工作台";
  };

  const setAuthenticationMode = (mode: AuthenticationMode) => {
    authenticationMode = mode;
    clearLoginError();
    const registering = mode === "register";
    if (loginEyebrow) loginEyebrow.textContent = registering ? "开启新的工作区" : "欢迎回来";
    if (loginTitle) loginTitle.textContent = registering ? "注册燊锶" : "登录燊锶";
    if (loginDescription) {
      loginDescription.textContent = registering
        ? "填写账号和密码创建独立工作区，注册后查看开通状态。"
        : "进入你的经营工作台";
    }
    if (loginModeToggle) {
      loginModeToggle.textContent = registering ? "已有账号？返回登录" : "还没有账号？注册账号";
    }
    if (loginAccount) {
      if (registering) loginAccount.setAttribute("pattern", "[A-Za-z0-9][A-Za-z0-9_-]{2,31}");
      else loginAccount.removeAttribute("pattern");
    }
    if (loginPassword) {
      loginPassword.setAttribute("autocomplete", registering ? "new-password" : "current-password");
      if (registering) loginPassword.setAttribute("minlength", "8");
      else loginPassword.removeAttribute("minlength");
    }
    setLoginPending(false);
  };

  const beginAuthenticationOperation = () => {
    lifecycleGeneration += 1;
    return lifecycleGeneration;
  };

  const isCurrentOperation = (generation: number) => generation === lifecycleGeneration;

  const clearLocalSession = () => clearAppSession({ document: documentRef, storage });

  const renderAccess = (user: AppUser, access?: CustomerAccess) => {
    documentRef.querySelector("[data-account-access-panel]")?.remove();
    delete documentRef.body.dataset.accountAccess;
    if (!access || access.status === "unmanaged" || access.status === "active") return;
    const blocked = !access.canRead;
    documentRef.body.dataset.accountAccess = blocked ? "blocked" : "readonly";
    if (!documentRef.querySelector("[data-account-access-style]")) {
      const style = documentRef.createElement("style"); style.dataset.accountAccessStyle = "";
      style.textContent = `body[data-account-access=blocked] .login-screen,body[data-account-access=blocked] #loginForm,body[data-account-access=blocked] .replica-shell{display:none!important}.account-access-panel{font:15px/1.7 system-ui,sans-serif;color:#e8efeb;background:#16231e;border:1px solid #344e40;border-radius:16px;padding:28px;box-sizing:border-box;overflow-wrap:anywhere}.account-access-panel h1{font-size:24px;line-height:1.4}.account-access-panel p{margin:12px 0}.account-access-panel button{font:inherit;padding:9px 16px;margin:8px 10px 0 0;background:#b9edcf;color:#14231c;border:0;border-radius:8px;cursor:pointer}.account-access-panel button:disabled{opacity:.5}.account-access-panel button:focus-visible{outline:3px solid #fff;outline-offset:3px}body[data-account-access=blocked] .account-access-panel{max-width:640px;margin:clamp(24px,12vh,160px) auto;position:relative;z-index:10}body[data-account-access=readonly] .account-access-panel{position:fixed;z-index:10000;bottom:16px;left:50%;transform:translateX(-50%);width:min(760px,calc(100% - 32px));padding:14px 20px;max-height:35vh;overflow:auto}body[data-account-access=readonly] .account-access-panel h1{font-size:17px;margin:0}@media(max-width:680px){body[data-account-access=blocked] .account-access-panel{margin:24px 16px;padding:22px}}`;
      documentRef.head.append(style);
    }
    const panel = documentRef.createElement("section"); panel.dataset.accountAccessPanel = ""; panel.className = "account-access-panel"; panel.setAttribute("aria-label", "账号授权状态");
    const copy: Record<CustomerAccess["status"], [string, string]> = {
      pending: ["账号已注册，等待运营开通", "请将下方企业与账号信息提供给运营人员。开通后刷新状态并按提示重新登录。"],
      suspended: ["企业使用权限已暂停", "请联系运营人员恢复企业权限。"],
      unconfigured: ["企业授权尚未配置完成", "请联系运营人员配置套餐和有效期。"],
      scheduled: ["企业授权尚未生效", "请在授权生效后刷新状态。"],
      expired: ["企业授权已到期，当前仅可查看", "新的任务与修改已暂停，请联系运营人员续期。"],
      active: ["企业授权有效", ""], unmanaged: ["", ""]
    };
    const heading = documentRef.createElement("h1"); heading.textContent = copy[access.status][0];
    const description = documentRef.createElement("p"); description.textContent = copy[access.status][1];
    const identity = documentRef.createElement("p"); identity.textContent = `企业：${access.workspaceName || user.teamId} ｜ 企业编号：${access.workspaceId || user.teamId} ｜ 账号：${user.email}`;
    const status = documentRef.createElement("p"); status.dataset.accountAccessFeedback = ""; status.setAttribute("role", "status");
    if (access.startsAt && access.status === "scheduled") status.textContent = `生效时间：${new Date(access.startsAt).toLocaleString("zh-CN")}`;
    if (access.expiresAt && access.status === "expired") status.textContent = `到期时间：${new Date(access.expiresAt).toLocaleString("zh-CN")}`;
    const refresh = documentRef.createElement("button"); refresh.type = "button"; refresh.dataset.accountAccessAction = "refresh"; refresh.textContent = "刷新授权状态";
    const logout = documentRef.createElement("button"); logout.type = "button"; logout.dataset.accountAccessAction = "logout"; logout.textContent = "退出登录";
    panel.append(heading, description, identity, status, refresh, logout); documentRef.body.append(panel);
  };

  const applyAuthenticatedUser = (user: AppUser, access?: CustomerAccess) => {
    clearLoginError();
    storage.setItem(STORAGE_KEY, JSON.stringify(user));
    updateSidebarUser(documentRef, user);
    const businessAllowed = !access || access.canRead;
    documentRef.body.classList.toggle("is-authenticated", businessAllowed);
    documentRef.body.dataset.sessionMode = demoMode ? "demo" : "real";
    documentRef.body.dataset.sessionUserId = user.id;
    documentRef.body.dataset.sessionWorkspaceId = user.teamId;
    locationRef.hash = normalizeAppHash(locationRef.hash);
    renderAccess(user, access);
    publishAuthenticationState(documentRef, businessAllowed);
  };

  const request = async <T>(
    path: string,
    init: RequestInit = {},
    generation = lifecycleGeneration
  ): Promise<T> => {
    const method = (init.method ?? "GET").toUpperCase();
    const csrfToken = readCookie(cookieSource, "gj_csrf");
    const response = await fetchImpl(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(isWriteRequest(method) && csrfToken ? { "x-csrf-token": csrfToken } : {}),
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) {
      if (response.status === 401 && isCurrentOperation(generation)) clearLocalSession();
      const body = await response.json().catch(() => ({ message: "请求失败" }));
      throw new AppSessionRequestError(
        response.status,
        typeof body?.message === "string" ? body.message : "请求失败"
      );
    }
    return response.json() as Promise<T>;
  };

  const onLoginSubmit = (event: Event) => {
    event.preventDefault();
    const account = loginAccount?.value ?? "";
    const password = loginPassword?.value ?? "";
    const operation = authenticationMode === "register"
      ? controller.register(account, password)
      : controller.login(account, password);
    void operation.catch(() => undefined);
  };
  const onLoginModeToggle = () => {
    if (demoMode || loginButton?.disabled) return;
    setAuthenticationMode(authenticationMode === "login" ? "register" : "login");
    loginAccount?.focus();
  };
  const onLogoutClick = () => {
    void controller.logout().catch(() => undefined);
  };
  const onAccessClick = (event: Event) => {
    const target = event.target as Element | null;
    const action = target?.closest?.("[data-account-access-action]")?.getAttribute("data-account-access-action");
    if (action === "refresh") void controller.refreshAccess();
    if (action === "logout") onLogoutClick();
  };
  let lastFocusRefresh = 0;
  const onFocus = () => {
    if (demoMode || !storage.getItem(STORAGE_KEY) || Date.now() - lastFocusRefresh < 15000 || loginButton?.disabled) return;
    lastFocusRefresh = Date.now(); void controller.refreshAccess();
  };

  const controller: AppSessionController = {
    async start() {
      if (started) return;
      started = true;
      const generation = beginAuthenticationOperation();
      loginForm?.addEventListener("submit", onLoginSubmit);
      loginModeToggle?.addEventListener("click", onLoginModeToggle);
      logoutButton?.addEventListener("click", onLogoutClick);
      documentRef.addEventListener("click", onAccessClick);
      documentRef.defaultView?.addEventListener("focus", onFocus);
      if (loginModeToggle) {
        loginModeToggle.hidden = demoMode;
        loginModeToggle.disabled = demoMode;
      }

      if (demoMode) {
        if (!storage.getItem(STORAGE_KEY)) return;
        if (isCurrentOperation(generation)) applyAuthenticatedUser(createDemoAdmin());
        return;
      }
      const hadCachedIdentity = storage.getItem(STORAGE_KEY) !== null;
      try {
        const result = await request<SessionResponse>("/api/auth/me", {}, generation);
        if (isCurrentOperation(generation)) applyAuthenticatedUser(result.user, result.access);
      } catch (error) {
        // A failed session check must never leave a stale local login active.
        if (isCurrentOperation(generation)) {
          clearLocalSession();
          if (hadCachedIdentity && error instanceof AppSessionRequestError && error.status === 401 && loginError) loginError.textContent = "登录状态已失效，授权可能已变更，请重新登录。";
        }
      }
    },

    async login(email: string, password: string) {
      const generation = beginAuthenticationOperation();
      clearLoginError();
      setLoginPending(true);
      try {
        if (demoMode) {
          if (resolveLoginIdentity(email, {}) !== "admin@goodjob.com"
            || password !== "goodjob123") {
            throw new AppSessionRequestError(401, "invalid_demo_credentials");
          }
          if (isCurrentOperation(generation)) applyAuthenticatedUser(createDemoAdmin());
          return;
        }
        if (trialConfigurationIncomplete) throw new TrialLoginConfigurationError();
        const result = await request<SessionResponse>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: resolveLoginIdentity(email, loginAliases), password })
        }, generation);
        if (isCurrentOperation(generation)) applyAuthenticatedUser(result.user, result.access);
      } catch (error) {
        if (isCurrentOperation(generation)) showSafeLoginError(error, "login");
        throw error;
      } finally {
        if (isCurrentOperation(generation)) setLoginPending(false);
      }
    },

    async register(account: string, password: string) {
      const generation = beginAuthenticationOperation();
      clearLoginError();
      setLoginPending(true);
      try {
        if (demoMode) throw new AppSessionRequestError(403, "registration_unavailable_in_demo");
        const normalizedAccount = account.trim();
        if (!REGISTRATION_ACCOUNT_PATTERN.test(normalizedAccount) || password.length < 8) {
          throw new AppSessionRequestError(400, "invalid_registration_credentials");
        }
        const result = await request<SessionResponse>("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({ account: normalizedAccount, password })
        }, generation);
        if (isCurrentOperation(generation)) applyAuthenticatedUser(result.user, result.access);
      } catch (error) {
        if (isCurrentOperation(generation)) showSafeLoginError(error, "register");
        throw error;
      } finally {
        if (isCurrentOperation(generation)) setLoginPending(false);
      }
    },

    async refreshAccess() {
      if (!started || demoMode || refreshingAccess || !storage.getItem(STORAGE_KEY)) return;
      refreshingAccess = true;
      const generation = lifecycleGeneration;
      const cachedIdentity = storage.getItem(STORAGE_KEY);
      const refresh = documentRef.querySelector<HTMLButtonElement>("[data-account-access-action=refresh]");
      if (refresh) refresh.disabled = true;
      try {
        const result = await request<SessionResponse>("/api/auth/me", {}, generation);
        if (isCurrentOperation(generation) && storage.getItem(STORAGE_KEY) === cachedIdentity) applyAuthenticatedUser(result.user, result.access);
      } catch (error) {
        if (!isCurrentOperation(generation)) return;
        if (error instanceof AppSessionRequestError && error.status === 401) {
          setAuthenticationMode("login");
          if (loginError) loginError.textContent = "登录状态已失效，授权可能已变更，请重新登录。";
        } else {
          const feedback = documentRef.querySelector<HTMLElement>("[data-account-access-feedback]");
          if (feedback) feedback.textContent = "授权状态刷新失败，请检查网络后重试。";
        }
      } finally {
        refreshingAccess = false;
        if (isCurrentOperation(generation) && refresh?.isConnected) refresh.disabled = false;
      }
    },

    async logout() {
      const generation = beginAuthenticationOperation();
      try {
        if (!demoMode) await request<void>("/api/auth/logout", { method: "POST" }, generation);
      } finally {
        if (isCurrentOperation(generation)) {
          clearLocalSession();
          setLoginPending(false);
        }
      }
    },

    destroy() {
      beginAuthenticationOperation();
      setLoginPending(false);
      if (!started) return;
      loginForm?.removeEventListener("submit", onLoginSubmit);
      loginModeToggle?.removeEventListener("click", onLoginModeToggle);
      logoutButton?.removeEventListener("click", onLogoutClick);
      documentRef.removeEventListener("click", onAccessClick);
      documentRef.defaultView?.removeEventListener("focus", onFocus);
      documentRef.querySelector("[data-account-access-panel]")?.remove();
      documentRef.querySelector("[data-account-access-style]")?.remove();
      delete documentRef.body.dataset.accountAccess;
      started = false;
    }
  };

  return controller;
}
