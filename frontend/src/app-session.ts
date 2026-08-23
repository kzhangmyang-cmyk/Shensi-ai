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
  logout(): Promise<void>;
  destroy(): void;
}

type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface AppSessionOptions {
  document?: Document;
  location?: Pick<Location, "hash">;
  storage?: SessionStorage;
  fetchImpl?: typeof fetch;
  cookieSource?: () => string;
  demoMode?: boolean;
}

const STORAGE_KEY = "gj_user";

class AppSessionRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AppSessionRequestError";
  }
}

const roleLabels: Record<AppUser["role"], string> = {
  sales: "业务员",
  manager: "销售主管",
  admin: "管理员",
  super_admin: "超级管理员"
};

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
  let started = false;
  let lifecycleGeneration = 0;

  const loginButton = documentRef.querySelector<HTMLButtonElement>("#loginButton");
  const loginError = documentRef.querySelector<HTMLElement>("#loginError");
  const logoutButton = documentRef.querySelector<HTMLButtonElement>("#replicaLogoutButton");

  const clearLoginError = () => {
    if (loginError) loginError.textContent = "";
  };

  const showSafeLoginError = (error: unknown) => {
    if (!loginError) return;
    loginError.textContent = error instanceof AppSessionRequestError
      && error.status === 401
      ? "账号或密码错误，请重试"
      : error instanceof TypeError
        ? "网络连接失败，请检查网络后重试"
        : "登录失败，请稍后重试";
  };

  const beginAuthenticationOperation = () => {
    lifecycleGeneration += 1;
    return lifecycleGeneration;
  };

  const isCurrentOperation = (generation: number) => generation === lifecycleGeneration;

  const publishAuthenticationState = (authenticated: boolean) => {
    const event = documentRef.createEvent("CustomEvent");
    event.initCustomEvent("goodjob:auth-state-changed", false, false, { authenticated });
    documentRef.dispatchEvent(event);
  };

  const updateSidebarUser = (user: AppUser | null) => {
    const name = documentRef.querySelector<HTMLElement>("[data-session-user-name]");
    const role = documentRef.querySelector<HTMLElement>("[data-session-user-role]");
    if (name) name.textContent = user?.name ?? "";
    if (role) role.textContent = user ? roleLabels[user.role] : "";
  };

  const clearLocalSession = () => {
    const hadSession = storage.getItem(STORAGE_KEY) !== null
      || documentRef.body.classList.contains("is-authenticated")
      || documentRef.body.dataset.sessionMode !== undefined;
    storage.removeItem(STORAGE_KEY);
    documentRef.body.classList.remove("is-authenticated");
    delete documentRef.body.dataset.sessionMode;
    updateSidebarUser(null);
    if (hadSession) publishAuthenticationState(false);
  };

  const applyAuthenticatedUser = (user: AppUser) => {
    clearLoginError();
    storage.setItem(STORAGE_KEY, JSON.stringify(user));
    updateSidebarUser(user);
    documentRef.body.classList.add("is-authenticated");
    documentRef.body.dataset.sessionMode = demoMode ? "demo" : "real";
    locationRef.hash = normalizeAppHash(locationRef.hash);
    publishAuthenticationState(true);
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

  const onLoginClick = () => {
    const email = documentRef.querySelector<HTMLInputElement>("#loginEmail")?.value.trim() ?? "";
    const password = documentRef.querySelector<HTMLInputElement>("#loginPassword")?.value ?? "";
    void controller.login(email, password).catch(() => undefined);
  };
  const onLogoutClick = () => {
    void controller.logout().catch(() => undefined);
  };

  const controller: AppSessionController = {
    async start() {
      if (started) return;
      started = true;
      const generation = beginAuthenticationOperation();
      loginButton?.addEventListener("click", onLoginClick);
      logoutButton?.addEventListener("click", onLogoutClick);

      if (!storage.getItem(STORAGE_KEY)) return;
      if (demoMode) {
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

    async login(_email: string, password: string) {
      const generation = beginAuthenticationOperation();
      clearLoginError();
      try {
        if (demoMode) {
          if (_email.trim().toLowerCase() !== "admin@goodjob.com"
            || password !== "goodjob123") {
            throw new AppSessionRequestError(401, "invalid_demo_credentials");
          }
          if (isCurrentOperation(generation)) applyAuthenticatedUser(createDemoAdmin());
          return;
        }
        const result = await request<{ user: AppUser }>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: _email, password })
        }, generation);
        if (isCurrentOperation(generation)) applyAuthenticatedUser(result.user);
      } catch (error) {
        if (isCurrentOperation(generation)) showSafeLoginError(error);
        throw error;
      }
    },

    async logout() {
      const generation = beginAuthenticationOperation();
      try {
        if (!demoMode) await request<void>("/api/auth/logout", { method: "POST" }, generation);
      } finally {
        if (isCurrentOperation(generation)) clearLocalSession();
      }
    },

    destroy() {
      beginAuthenticationOperation();
      if (!started) return;
      loginButton?.removeEventListener("click", onLoginClick);
      logoutButton?.removeEventListener("click", onLogoutClick);
      started = false;
    }
  };

  return controller;
}
