import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { createAppSessionController, type AppUser } from "./app-session";

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
    <button id="loginButton"></button>
    <input id="loginEmail" />
    <input id="loginPassword" />
    <button class="replica-user"></button>
    <strong data-session-user-name></strong>
    <small data-session-user-role></small>
  </body></html>`).document;
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
  assert.equal(location.hash, "#agents");
  assert.equal(storage.getItem("gj_user")?.includes("admin@goodjob.com"), true);
  assert.equal(document.querySelector("[data-session-user-name]")?.textContent, "Admin");
  assert.equal(document.querySelector("[data-session-user-role]")?.textContent, "管理员");
  assert.deepEqual(events, [true]);
  await controller.logout();
  assert.equal(storage.getItem("gj_user"), null);
  assert.deepEqual(events, [true, false]);
  controller.destroy();
}

{
  const document = createDocument();
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const controller = createAppSessionController({
    document,
    location: { hash: "" } as Location,
    storage: createStorage(),
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
