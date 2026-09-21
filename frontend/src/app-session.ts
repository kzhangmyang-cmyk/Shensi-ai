import { normalizeAppHash } from "./app-route";

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
        loginError.textContent = "账号或密码错误，请重试";
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
      : authenticationMode === "register" ? "注册并进入工作台" : "登录工作台";
  };

  const setAuthenticationMode = (mode: AuthenticationMode) => {
    authenticationMode = mode;
    clearLoginError();
    const registering = mode === "register";
    if (loginEyebrow) loginEyebrow.textContent = registering ? "开启新的工作区" : "欢迎回来";
    if (loginTitle) loginTitle.textContent = registering ? "注册燊锶" : "登录燊锶";
    if (loginDescription) {
      loginDescription.textContent = registering
        ? "填写账号和密码，将创建属于你的独立工作区。"
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

  const applyAuthenticatedUser = (user: AppUser) => {
    clearLoginError();
    storage.setItem(STORAGE_KEY, JSON.stringify(user));
    updateSidebarUser(documentRef, user);
    documentRef.body.classList.add("is-authenticated");
    documentRef.body.dataset.sessionMode = demoMode ? "demo" : "real";
    documentRef.body.dataset.sessionUserId = user.id;
    documentRef.body.dataset.sessionWorkspaceId = user.teamId;
    locationRef.hash = normalizeAppHash(locationRef.hash);
    publishAuthenticationState(documentRef, true);
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

  const controller: AppSessionController = {
    async start() {
      if (started) return;
      started = true;
      const generation = beginAuthenticationOperation();
      loginForm?.addEventListener("submit", onLoginSubmit);
      loginModeToggle?.addEventListener("click", onLoginModeToggle);
      logoutButton?.addEventListener("click", onLogoutClick);
      if (loginModeToggle) {
        loginModeToggle.hidden = demoMode;
        loginModeToggle.disabled = demoMode;
      }

      if (demoMode) {
        if (!storage.getItem(STORAGE_KEY)) return;
        if (isCurrentOperation(generation)) applyAuthenticatedUser(createDemoAdmin());
        return;
      }
      try {
        const result = await request<{ user: AppUser }>("/api/auth/me", {}, generation);
        if (isCurrentOperation(generation)) applyAuthenticatedUser(result.user);
      } catch {
        // A failed session check must never leave a stale local login active.
        if (isCurrentOperation(generation)) clearLocalSession();
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
        const result = await request<{ user: AppUser }>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: resolveLoginIdentity(email, loginAliases), password })
        }, generation);
        if (isCurrentOperation(generation)) applyAuthenticatedUser(result.user);
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
        const result = await request<{ user: AppUser }>("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({ account: normalizedAccount, password })
        }, generation);
        if (isCurrentOperation(generation)) applyAuthenticatedUser(result.user);
      } catch (error) {
        if (isCurrentOperation(generation)) showSafeLoginError(error, "register");
        throw error;
      } finally {
        if (isCurrentOperation(generation)) setLoginPending(false);
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
      started = false;
    }
  };

  return controller;
}
