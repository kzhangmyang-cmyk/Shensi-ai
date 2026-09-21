import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import {
  clearAppSession,
  createAppSessionController,
  resolveLoginIdentity,
  type AppUser
} from "./app-session";

type MemoryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const admin: AppUser = {
  id: "admin-1",
  name: "Admin",
  email: "admin@goodjob.com",
  role: "admin",
  teamId: "team-1",
  avatar: "AD"
};

function createStorage(initial: Record<string, string> = {}): MemoryStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
}

function createDocument() {
  return parseHTML(`<!doctype html><html><body>
    <form id="loginForm" aria-busy="false">
      <p id="loginEyebrow">欢迎回来</p>
      <h2 id="loginTitle">登录燊锶</h2>
      <p id="loginDescription">进入你的经营工作台</p>
      <input id="loginEmail" autocomplete="username" />
      <input id="loginPassword" autocomplete="current-password" />
      <button id="loginButton">登录工作台</button>
      <p id="loginError" role="alert" aria-live="polite"></p>
      <button id="loginModeToggle" type="button">还没有账号？注册账号</button>
    </form>
    <button class="replica-user" id="replicaLogoutButton"></button>
    <strong data-session-user-name></strong>
    <small data-session-user-role></small>
  </body></html>`).document;
}

{
  const document = createDocument();
  const storage = createStorage();
  const requests: Array<{ path: string; credentials: RequestCredentials | undefined }> = [];
  const response = createDeferred<Response>();
  const controller = createAppSessionController({
    document, storage, location: { hash: "#agents" } as Location, demoMode: false,
    fetchImpl: async (path, init) => {
      requests.push({ path: String(path), credentials: init?.credentials });
      return response.promise;
    }
  });
  const restoring = controller.start();
  await controller.start();
  assert.deepEqual(requests, [{ path: "/api/auth/me", credentials: "same-origin" }],
    "real startup must check the server session even when this origin has no cached user");
  assert.equal(document.body.classList.contains("is-authenticated"), false);
  response.resolve(new Response(JSON.stringify({ user: admin }), { status: 200 }));
  await restoring;
  assert.equal(document.body.classList.contains("is-authenticated"), true);
  assert.equal(document.body.dataset.sessionUserId, admin.id);
  assert.equal(document.body.dataset.sessionWorkspaceId, admin.teamId);
  assert.deepEqual(JSON.parse(storage.getItem("gj_user")!), admin);
  controller.destroy();
}

for (const outcome of ["unauthorized", "network-failure"] as const) {
  const document = createDocument();
  const storage = createStorage();
  let requests = 0;
  const controller = createAppSessionController({
    document, storage, location: { hash: "#agents" } as Location, demoMode: false,
    fetchImpl: async () => {
      requests++;
      if (outcome === "network-failure") throw new TypeError("isolated network failure");
      return new Response(JSON.stringify({ message: "未登录" }), { status: 401 });
    }
  });
  await controller.start();
  assert.equal(requests, 1);
  assert.equal(document.body.classList.contains("is-authenticated"), false, outcome);
  assert.equal(storage.getItem("gj_user"), null, outcome);
  controller.destroy();
}

for (const ending of ["logout", "destroy"] as const) {
  const document = createDocument();
  const storage = createStorage();
  const response = createDeferred<Response>();
  let meRequests = 0;
  const controller = createAppSessionController({
    document, storage, location: { hash: "#agents" } as Location, demoMode: false,
    fetchImpl: async path => {
      if (String(path) === "/api/auth/me") { meRequests++; return response.promise; }
      assert.equal(String(path), "/api/auth/logout");
      return new Response(JSON.stringify({}), { status: 200 });
    }
  });
  const restoring = controller.start();
  assert.equal(meRequests, 1);
  if (ending === "logout") await controller.logout();
  else controller.destroy();
  response.resolve(new Response(JSON.stringify({ user: admin }), { status: 200 }));
  await restoring;
  assert.equal(document.body.classList.contains("is-authenticated"), false,
    `a late cacheless startup must not restore authentication after ${ending}`);
  assert.equal(storage.getItem("gj_user"), null);
  controller.destroy();
}

for (const cached of [false, true]) {
  const document = createDocument();
  let requests = 0;
  const controller = createAppSessionController({
    document, storage: createStorage(cached ? { gj_user: JSON.stringify(admin) } : {}),
    location: { hash: "#agents" } as Location, demoMode: true,
    fetchImpl: async () => { requests++; throw new Error("demo must not check server sessions"); }
  });
  await controller.start();
  assert.equal(requests, 0);
  assert.equal(document.body.classList.contains("is-authenticated"), cached);
  controller.destroy();
}

{
  const document = createDocument();
  const storage = createStorage({ gj_user: JSON.stringify(admin) });
  const events: boolean[] = [];
  document.body.classList.add("is-authenticated");
  document.body.dataset.sessionMode = "real";
  document.body.dataset.sessionUserId = admin.id;
  document.body.dataset.sessionWorkspaceId = admin.teamId;
  document.querySelector<HTMLElement>("[data-session-user-name]")!.textContent = admin.name;
  document.querySelector<HTMLElement>("[data-session-user-role]")!.textContent = "管理员";
  document.addEventListener("goodjob:auth-state-changed", (event) => {
    events.push((event as CustomEvent<{ authenticated: boolean }>).detail.authenticated);
  });

  assert.equal(clearAppSession({ document, storage }), true);
  assert.equal(storage.getItem("gj_user"), null);
  assert.equal(document.body.classList.contains("is-authenticated"), false);
  assert.equal(document.body.dataset.sessionMode, undefined);
  assert.equal(document.body.dataset.sessionUserId, undefined);
  assert.equal(document.body.dataset.sessionWorkspaceId, undefined);
  assert.equal(document.querySelector("[data-session-user-name]")?.textContent, "");
  assert.equal(document.querySelector("[data-session-user-role]")?.textContent, "");
  assert.deepEqual(events, [false]);
  assert.equal(clearAppSession({ document, storage }), false);
  assert.deepEqual(events, [false]);
}

{
  const document = createDocument();
  const requests: Array<{ path: string; body: string }> = [];
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage: createStorage(),
    demoMode: false,
    realTrial: true,
    loginAlias: "test,test2",
    loginEmail: "test@shensi.local,test2@shensi.local",
    fetchImpl: async (path, init = {}) => {
      requests.push({ path: String(path), body: String(init.body) });
      return new Response(JSON.stringify({ user: admin }), { status: 200 });
    }
  });

  await controller.login("test", "trial-password");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/auth/login");
  assert.deepEqual(JSON.parse(requests[0].body), {
    email: "test@shensi.local",
    password: "trial-password"
  });
  await controller.login(" TEST2 ", "second-password");
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1].body), {
    email: "test2@shensi.local",
    password: "second-password"
  });
  await controller.login(" Other.Account@Example.com ", "unmatched-password");
  assert.equal(requests.length, 3);
  assert.deepEqual(JSON.parse(requests[2].body), {
    email: " Other.Account@Example.com ",
    password: "unmatched-password"
  });
  assert.equal(resolveLoginIdentity(" TEST ", { test: "test@shensi.local" }), "test@shensi.local");
  assert.equal(resolveLoginIdentity("owner@example.com", { test: "test@shensi.local" }), "owner@example.com");
  assert.equal(
    resolveLoginIdentity(" Other.Account@Example.com ", { test: "test@shensi.local" }),
    " Other.Account@Example.com "
  );
  assert.equal(resolveLoginIdentity("constructor", { test: "test@shensi.local" }), "constructor");
  assert.equal(resolveLoginIdentity("test1", { test: "test@shensi.local" }), "test1");
  assert.equal(resolveLoginIdentity("tester", { test: "test@shensi.local" }), "tester");
  controller.destroy();
}

{
  const document = createDocument();
  const requests: string[] = [];
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage: createStorage(),
    demoMode: false,
    realTrial: false,
    loginAlias: "test",
    loginEmail: "test@shensi.local",
    fetchImpl: async (_path, init = {}) => {
      requests.push(String(init.body));
      return new Response(JSON.stringify({ user: admin }), { status: 200 });
    }
  });

  await controller.login("test", "trial-password");
  assert.equal(JSON.parse(requests[0]).email, "test");
  controller.destroy();
}

{
  const document = createDocument();
  let requests = 0;
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage: createStorage(),
    demoMode: false,
    realTrial: true,
    loginAlias: "test",
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({ user: admin }), { status: 200 });
    }
  });

  await assert.rejects(controller.login("test", "trial-password"));
  assert.equal(requests, 0);
  controller.destroy();
}

{
  const document = createDocument();
  const nextLogin = createDeferred<Response>();
  let attempts = 0;
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage: createStorage(),
    demoMode: false,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({
          message: "wrong password; database=postgres://internal-secret"
        }), { status: 401 });
      }
      return nextLogin.promise;
    }
  });

  await assert.rejects(controller.login(admin.email, "wrong"));
  assert.equal(
    document.querySelector("#loginError")?.textContent,
    "账号或密码错误，请重试"
  );
  const retry = controller.login(admin.email, "goodjob123");
  assert.equal(document.querySelector("#loginError")?.textContent, "");
  nextLogin.resolve(new Response(JSON.stringify({ user: admin }), { status: 200 }));
  await retry;
  assert.equal(document.querySelector("#loginError")?.textContent, "");
  controller.destroy();
}

{
  const document = createDocument();
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage: createStorage(),
    demoMode: false,
    fetchImpl: async () => {
      throw new TypeError("network secret: internal-api-token");
    }
  });

  await assert.rejects(controller.login(admin.email, "goodjob123"));
  assert.equal(
    document.querySelector("#loginError")?.textContent,
    "网络连接失败，请检查网络后重试"
  );
  controller.destroy();
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfil) => {
    resolve = fulfil;
  });
  return { promise, resolve };
}

function click(document: Document, selector: string) {
  const event = document.createEvent("Event");
  event.initEvent("click", true, true);
  document.querySelector<HTMLElement>(selector)?.dispatchEvent(event);
}

function submit(document: Document, selector: string) {
  const event = document.createEvent("Event");
  event.initEvent("submit", true, true);
  document.querySelector<HTMLFormElement>(selector)?.dispatchEvent(event);
}

{
  const document = createDocument();
  const storage = createStorage();
  const location = { hash: "#agents" } as Location;
  const requests: Array<{ path: string; body: unknown }> = [];
  const controller = createAppSessionController({
    document,
    location,
    storage,
    demoMode: false,
    fetchImpl: async (path, init = {}) => {
      if (String(path) === "/api/auth/me") {
        return new Response(JSON.stringify({ message: "未登录" }), { status: 401 });
      }
      requests.push({ path: String(path), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ user: admin }), { status: 201 });
    }
  });

  await controller.start();
  click(document, "#loginModeToggle");
  assert.equal(document.querySelector("#loginTitle")?.textContent, "注册燊锶");
  assert.match(document.querySelector("#loginDescription")?.textContent ?? "", /独立工作区/u);
  assert.equal(document.querySelector("#loginButton")?.textContent, "注册并进入工作台");
  assert.equal(document.querySelector("#loginModeToggle")?.textContent, "已有账号？返回登录");
  assert.equal(
    document.querySelector<HTMLInputElement>("#loginEmail")?.getAttribute("pattern"),
    "[A-Za-z0-9][A-Za-z0-9_-]{2,31}"
  );
  assert.equal(
    document.querySelector<HTMLInputElement>("#loginPassword")?.getAttribute("minlength"),
    "8"
  );
  assert.equal(
    document.querySelector<HTMLInputElement>("#loginPassword")?.getAttribute("autocomplete"),
    "new-password"
  );

  const account = document.querySelector<HTMLInputElement>("#loginEmail");
  const password = document.querySelector<HTMLInputElement>("#loginPassword");
  if (account) account.value = "new_account";
  if (password) password.value = "12345678";
  submit(document, "#loginForm");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(requests, [{
    path: "/api/auth/register",
    body: { account: "new_account", password: "12345678" }
  }]);
  assert.equal(document.body.classList.contains("is-authenticated"), true);
  assert.equal(document.body.dataset.sessionMode, "real");
  assert.equal(document.body.dataset.sessionUserId, admin.id);
  assert.equal(document.body.dataset.sessionWorkspaceId, admin.teamId);
  assert.equal(storage.getItem("gj_user")?.includes(admin.id), true);
  controller.destroy();
}

for (const scenario of [
  { status: 409, expected: "账号已存在，请直接登录" },
  { status: 400, expected: "账号或密码格式不正确，请检查后重试" },
  { status: 429, expected: "注册过于频繁，请稍后重试" }
] as const) {
  const document = createDocument();
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage: createStorage(),
    demoMode: false,
    fetchImpl: async () => new Response(JSON.stringify({
      message: `internal registration detail database=password status=${scenario.status}`
    }), { status: scenario.status })
  });

  await assert.rejects(controller.register("new_account", "12345678"));
  assert.equal(document.querySelector("#loginError")?.textContent, scenario.expected);
  assert.doesNotMatch(document.querySelector("#loginError")?.textContent ?? "", /database|password/u);
  controller.destroy();
}

for (const credentials of [
  { account: "new.account", password: "12345678" },
  { account: "new_account", password: "1234567" }
]) {
  const document = createDocument();
  let requests = 0;
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage: createStorage(),
    demoMode: false,
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({ user: admin }), { status: 201 });
    }
  });

  await assert.rejects(controller.register(credentials.account, credentials.password));
  assert.equal(requests, 0);
  assert.equal(
    document.querySelector("#loginError")?.textContent,
    "账号或密码格式不正确，请检查后重试"
  );
  controller.destroy();
}

{
  const document = createDocument();
  let requests = 0;
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage: createStorage(),
    demoMode: true,
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({ user: admin }), { status: 201 });
    }
  });

  await controller.start();
  assert.equal(document.querySelector<HTMLButtonElement>("#loginModeToggle")?.hidden, true);
  assert.equal(document.querySelector<HTMLButtonElement>("#loginModeToggle")?.disabled, true);
  await assert.rejects(controller.register("demo_account", "12345678"));
  assert.equal(requests, 0);
  assert.equal(document.body.classList.contains("is-authenticated"), false);
  controller.destroy();
}

{
  const document = createDocument();
  const pending = createDeferred<Response>();
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage: createStorage(),
    demoMode: false,
    fetchImpl: async path => String(path) === "/api/auth/me"
      ? new Response(JSON.stringify({ message: "未登录" }), { status: 401 })
      : pending.promise
  });

  await controller.start();
  click(document, "#loginModeToggle");
  const account = document.querySelector<HTMLInputElement>("#loginEmail");
  const password = document.querySelector<HTMLInputElement>("#loginPassword");
  if (account) account.value = "pending_account";
  if (password) password.value = "12345678";
  submit(document, "#loginForm");
  await Promise.resolve();

  assert.equal(document.querySelector<HTMLButtonElement>("#loginButton")?.disabled, true);
  assert.equal(document.querySelector("#loginButton")?.textContent, "正在创建");
  assert.equal(document.querySelector<HTMLButtonElement>("#loginModeToggle")?.disabled, true);
  assert.equal(document.querySelector("#loginForm")?.getAttribute("aria-busy"), "true");

  pending.resolve(new Response(JSON.stringify({ user: admin }), { status: 201 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.querySelector<HTMLButtonElement>("#loginModeToggle")?.disabled, false);
  controller.destroy();
}

{
  const document = createDocument();
  const pending = createDeferred<Response>();
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage: createStorage(),
    demoMode: false,
    fetchImpl: async () => pending.promise
  });

  const login = controller.login("owner@example.com", "correct-password");
  assert.equal(document.querySelector<HTMLButtonElement>("#loginButton")?.disabled, true);
  assert.equal(document.querySelector("#loginForm")?.getAttribute("aria-busy"), "true");
  pending.resolve(new Response(JSON.stringify({ user: admin }), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
  await login;
  assert.equal(document.querySelector<HTMLButtonElement>("#loginButton")?.disabled, false);
  assert.equal(document.querySelector("#loginForm")?.getAttribute("aria-busy"), "false");
  controller.destroy();
}

{
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(html.includes("Shensi"), true);
  assert.equal(html.includes('value="admin@goodjob.com"'), false);
  assert.equal(html.includes('value="goodjob123"'), false);
}

{
  const document = createDocument();
  const first = createDeferred<Response>();
  const second = createDeferred<Response>();
  let requestCount = 0;
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage: createStorage(),
    demoMode: false,
    fetchImpl: async () => requestCount++ === 0 ? first.promise : second.promise
  });

  const staleLogin = controller.login("first@example.com", "first-password");
  const currentLogin = controller.login("second@example.com", "second-password");
  first.resolve(new Response(JSON.stringify({ user: admin }), { status: 200 }));
  await staleLogin;
  assert.equal(document.querySelector<HTMLButtonElement>("#loginButton")?.disabled, true);
  assert.equal(document.querySelector("#loginForm")?.getAttribute("aria-busy"), "true");
  second.resolve(new Response(JSON.stringify({ user: admin }), { status: 200 }));
  await currentLogin;
  assert.equal(document.querySelector<HTMLButtonElement>("#loginButton")?.disabled, false);
  assert.equal(document.querySelector("#loginForm")?.getAttribute("aria-busy"), "false");
  controller.destroy();
}

{
  const document = createDocument();
  const storage = createStorage();
  const location = { hash: "#dashboard" } as Location;
  const events: boolean[] = [];
  document.addEventListener("goodjob:auth-state-changed", (event) => {
    events.push((event as CustomEvent<{ authenticated: boolean }>).detail.authenticated);
  });
  const controller = createAppSessionController({
    document,
    location,
    storage,
    demoMode: true,
    fetchImpl: async () => {
      throw new Error("demo mode must not request an API");
    }
  });

  await controller.start();
  assert.equal(document.body.classList.contains("is-authenticated"), false);
  await controller.login("admin@goodjob.com", "goodjob123");
  assert.equal(document.body.classList.contains("is-authenticated"), true);
  assert.equal(location.hash, "#dashboard");
  assert.equal(storage.getItem("gj_user")?.includes("admin@goodjob.com"), true);
  assert.equal(document.querySelector("[data-session-user-name]")?.textContent, "Admin");
  assert.equal(document.querySelector("[data-session-user-role]")?.textContent, "管理员");
  assert.equal(document.body.dataset.sessionMode, "demo");
  assert.equal(document.body.dataset.sessionUserId, "demo-admin");
  assert.equal(document.body.dataset.sessionWorkspaceId, "demo-team");
  assert.deepEqual(events, [true]);
  await controller.logout();
  assert.equal(storage.getItem("gj_user"), null);
  assert.equal(document.body.dataset.sessionMode, undefined);
  assert.equal(document.body.dataset.sessionUserId, undefined);
  assert.equal(document.body.dataset.sessionWorkspaceId, undefined);
  assert.deepEqual(events, [true, false]);
  controller.destroy();
}

{
  const document = createDocument();
  const storage = createStorage();
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const controller = createAppSessionController({
    document,
    location: { hash: "" } as Location,
    storage,
    cookieSource: () => "other=value; gj_csrf=csrf-token",
    demoMode: false,
    fetchImpl: async (path, init = {}) => {
      requests.push({ path: String(path), init });
      return new Response(JSON.stringify({ user: admin }), { status: 200 });
    }
  });

  await controller.login(admin.email, "goodjob123");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/auth/login");
  assert.equal(requests[0].init.credentials, "same-origin");
  assert.equal(new Headers(requests[0].init.headers).get("x-csrf-token"), "csrf-token");
  assert.equal(document.body.dataset.sessionMode, "real");
  assert.equal(document.body.dataset.sessionUserId, "admin-1");
  assert.equal(document.body.dataset.sessionWorkspaceId, "team-1");
  assert.equal(storage.getItem("gj_user")?.includes("demo-admin"), false);
  await controller.logout();
  assert.equal(document.body.dataset.sessionMode, undefined);
  assert.equal(document.body.dataset.sessionUserId, undefined);
  assert.equal(document.body.dataset.sessionWorkspaceId, undefined);
  controller.destroy();
}

{
  const document = createDocument();
  const storage = createStorage({ gj_user: JSON.stringify(admin) });
  const events: boolean[] = [];
  document.addEventListener("goodjob:auth-state-changed", (event) => {
    events.push((event as CustomEvent<{ authenticated: boolean }>).detail.authenticated);
  });
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage,
    demoMode: false,
    fetchImpl: async () => new Response(JSON.stringify({ message: "未登录" }), { status: 401 })
  });

  await controller.start();
  assert.equal(storage.getItem("gj_user"), null);
  assert.equal(document.body.classList.contains("is-authenticated"), false);
  assert.deepEqual(events, [false]);
  controller.destroy();
}

{
  const document = createDocument();
  const storage = createStorage({ gj_user: JSON.stringify(admin) });
  const events: boolean[] = [];
  const meResponse = createDeferred<Response>();
  let requestCount = 0;
  document.addEventListener("goodjob:auth-state-changed", (event) => {
    events.push((event as CustomEvent<{ authenticated: boolean }>).detail.authenticated);
  });
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage,
    demoMode: false,
    fetchImpl: async () => {
      requestCount += 1;
      return meResponse.promise;
    }
  });

  const firstStart = controller.start();
  const repeatedStart = controller.start();
  assert.equal(requestCount, 1);
  meResponse.resolve(new Response(JSON.stringify({ user: admin }), { status: 200 }));
  await Promise.all([firstStart, repeatedStart]);
  assert.equal(document.body.classList.contains("is-authenticated"), true);
  assert.deepEqual(events, [true]);
  controller.destroy();
}

{
  const document = createDocument();
  const storage = createStorage();
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage,
    demoMode: true
  });

  await controller.start();
  controller.destroy();
  click(document, "#loginButton");
  await Promise.resolve();
  assert.equal(document.body.classList.contains("is-authenticated"), false);
  assert.equal(storage.getItem("gj_user"), null);
}

{
  const document = createDocument();
  const storage = createStorage({ gj_user: JSON.stringify(admin) });
  const events: boolean[] = [];
  const meResponse = createDeferred<Response>();
  document.addEventListener("goodjob:auth-state-changed", (event) => {
    events.push((event as CustomEvent<{ authenticated: boolean }>).detail.authenticated);
  });
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage,
    demoMode: false,
    fetchImpl: async (path) => String(path) === "/api/auth/me"
      ? meResponse.promise
      : new Response(JSON.stringify({}), { status: 200 })
  });

  const restoring = controller.start();
  await controller.logout();
  meResponse.resolve(new Response(JSON.stringify({ user: admin }), { status: 200 }));
  await restoring;
  assert.equal(storage.getItem("gj_user"), null);
  assert.equal(document.body.classList.contains("is-authenticated"), false);
  assert.deepEqual(events, [false]);
  controller.destroy();
}

{
  const document = createDocument();
  const storedSession = JSON.stringify({ ...admin, name: "Stored user" });
  const storage = createStorage({ gj_user: storedSession });
  const events: boolean[] = [];
  const meResponse = createDeferred<Response>();
  document.addEventListener("goodjob:auth-state-changed", (event) => {
    events.push((event as CustomEvent<{ authenticated: boolean }>).detail.authenticated);
  });
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage,
    demoMode: false,
    fetchImpl: async () => meResponse.promise
  });

  const restoring = controller.start();
  controller.destroy();
  meResponse.resolve(new Response(JSON.stringify({ user: admin }), { status: 200 }));
  await restoring;
  assert.equal(storage.getItem("gj_user"), storedSession);
  assert.equal(document.body.classList.contains("is-authenticated"), false);
  assert.deepEqual(events, []);
}

{
  const document = createDocument();
  const storage = createStorage({ gj_user: JSON.stringify(admin) });
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage,
    demoMode: false,
    fetchImpl: async (path) => String(path) === "/api/auth/me"
      ? new Response(JSON.stringify({ user: admin }), { status: 200 })
      : new Response(JSON.stringify({ message: "服务暂不可用" }), { status: 503 })
  });

  await controller.start();
  click(document, "#replicaLogoutButton");
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off("unhandledRejection", onUnhandledRejection);
  assert.equal(storage.getItem("gj_user"), null);
  assert.equal(document.body.classList.contains("is-authenticated"), false);
  assert.deepEqual(unhandled, []);
  controller.destroy();
}

{
  const document = createDocument();
  const storage = createStorage({ gj_user: JSON.stringify(admin) });
  const events: boolean[] = [];
  document.addEventListener("goodjob:auth-state-changed", (event) => {
    events.push((event as CustomEvent<{ authenticated: boolean }>).detail.authenticated);
  });
  const controller = createAppSessionController({
    document,
    location: { hash: "#agents" } as Location,
    storage,
    demoMode: false,
    fetchImpl: async () => new Response(JSON.stringify({ message: "服务暂不可用" }), { status: 503 })
  });

  await controller.start();
  assert.equal(storage.getItem("gj_user"), null);
  assert.equal(document.body.classList.contains("is-authenticated"), false);
  assert.deepEqual(events, [false]);
  controller.destroy();
}
