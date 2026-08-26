import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import {
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
      <button id="loginButton"></button>
      <input id="loginEmail" />
      <input id="loginPassword" />
      <p id="loginError" role="alert" aria-live="polite"></p>
    </form>
    <button class="replica-user" id="replicaLogoutButton"></button>
    <strong data-session-user-name></strong>
    <small data-session-user-role></small>
  </body></html>`).document;
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
    loginAlias: "test",
    loginEmail: "test@shensi.local",
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
  assert.equal(resolveLoginIdentity(" TEST ", { test: "test@shensi.local" }), "test@shensi.local");
  assert.equal(resolveLoginIdentity("owner@example.com", { test: "test@shensi.local" }), "owner@example.com");
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
  assert.deepEqual(events, [true]);
  await controller.logout();
  assert.equal(storage.getItem("gj_user"), null);
  assert.equal(document.body.dataset.sessionMode, undefined);
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
  assert.equal(storage.getItem("gj_user")?.includes("demo-admin"), false);
  await controller.logout();
  assert.equal(document.body.dataset.sessionMode, undefined);
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
