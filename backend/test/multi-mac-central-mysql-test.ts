import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";

import { assertDesktopStorageMysqlTestAuthority } from
  "./acquisition-desktop-installation-mysql-test-support.js";

const DATABASE_PATTERN = /^goodjob_multi_mac_[a-f0-9]{32}$/u;

function cookies(response: Response) {
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

async function closeServer(server: import("node:http").Server | undefined) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("two independent sessions for one account share durable central MySQL CRM data", {
  skip: process.env.DESKTOP_ACTION_STORAGE_SUITE !== "multi-mac-crm"
    ? "requires the multi-mac-crm disposable operator" : false
}, async () => {
  const repositoryRoot = new URL("../..", import.meta.url).pathname;
  const authority = await assertDesktopStorageMysqlTestAuthority({
    environment: process.env,
    repositoryRoot: decodeURIComponent(repositoryRoot.replace(/\/$/u, ""))
  });
  const database = `goodjob_multi_mac_${randomBytes(16).toString("hex")}`;
  assert.match(database, DATABASE_PATTERN);
  let admin: mysql.Connection | undefined;
  let store: Awaited<ReturnType<typeof import("../src/mysql-store.js")["createMysqlStore"]>> | undefined;
  let server: import("node:http").Server | undefined;
  let created = false;
  let failure: unknown;
  const originalEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    MYSQL_URL: process.env.MYSQL_URL,
    CRM_STORE: process.env.CRM_STORE,
    JWT_SECRET: process.env.JWT_SECRET,
    SEED_DEMO_DATA: process.env.SEED_DEMO_DATA
  };
  try {
    admin = await mysql.createConnection(authority.adminUrl);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    const databaseUrl = new URL(authority.adminUrl);
    databaseUrl.pathname = `/${database}`;
    process.env.DATABASE_URL = databaseUrl.href;
    delete process.env.MYSQL_URL;
    process.env.CRM_STORE = "mysql";
    process.env.JWT_SECRET = "multi-mac-central-mysql-test-secret-at-least-32-characters";
    process.env.SEED_DEMO_DATA = "false";

    const [{ app }, { createMysqlStore }, { setStore }] = await Promise.all([
      import("../src/server.js"), import("../src/mysql-store.js"), import("../src/store.js")
    ]);
    const start = async () => {
      store = await createMysqlStore({ processRole: "api" });
      setStore(store);
      server = await new Promise<import("node:http").Server>((resolve) => {
        const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      return `http://127.0.0.1:${address.port}`;
    };
    let baseUrl = await start();
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init.headers }
      });
      return { response, json: await response.json().catch(() => ({})) as any };
    };
    const suffix = randomBytes(8).toString("hex");
    const account = `mac${suffix}`;
    const password = "Multi-Mac-123";
    const registered = await request("/api/auth/register", {
      method: "POST", body: JSON.stringify({ account, password })
    });
    assert.equal(registered.response.status, 201);
    const isolated = await request("/api/auth/register", {
      method: "POST", body: JSON.stringify({ account: `isolated${suffix}`, password })
    });
    assert.equal(isolated.response.status, 201);

    const login = async () => {
      const result = await request("/api/auth/login", {
        method: "POST", body: JSON.stringify({ email: account, password })
      });
      assert.equal(result.response.status, 200);
      return { cookie: cookies(result.response), csrf: result.json.csrfToken as string };
    };
    const clientA = await login();
    const clientB = await login();
    assert.notEqual(clientA.cookie, clientB.cookie);
    assert.notEqual(clientA.csrf, clientB.csrf);

    const marker = `Durable multi-Mac ${suffix}`;
    const createdCustomer = await request("/api/customers", {
      method: "POST",
      headers: { cookie: clientA.cookie, "x-csrf-token": clientA.csrf },
      body: JSON.stringify({ company: marker, country: "CN", contact: "Test",
        stage: "询盘", amount: 100 })
    });
    assert.equal(createdCustomer.response.status, 200);
    const customerId = createdCustomer.json.customer.id as string;
    const readByB = await request("/api/customers", { headers: { cookie: clientB.cookie } });
    assert.ok(readByB.json.customers.some((item: any) => item.id === customerId));
    const updatedByB = await request(`/api/customers/${customerId}`, {
      method: "PATCH",
      headers: { cookie: clientB.cookie, "x-csrf-token": clientB.csrf },
      body: JSON.stringify({ stage: "已报价", amount: 250 })
    });
    assert.equal(updatedByB.response.status, 200);

    await closeServer(server); server = undefined;
    await store.close?.(); store = undefined;
    baseUrl = await start();
    const afterRestartA = await request("/api/customers", { headers: { cookie: clientA.cookie } });
    assert.equal(afterRestartA.response.status, 200);
    assert.ok(afterRestartA.json.customers.some((item: any) =>
      item.id === customerId && item.stage === "已报价" && item.amount === 250));
    const isolatedRead = await request("/api/customers", {
      headers: { authorization: `Bearer ${isolated.json.token}` }
    });
    assert.equal(isolatedRead.response.status, 200);
    assert.equal(isolatedRead.json.customers.some((item: any) => item.id === customerId), false);

    const loggedOutB = await request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: clientB.cookie, "x-csrf-token": clientB.csrf },
      body: "{}"
    });
    assert.equal(loggedOutB.response.status, 200);
    const clearedB = await request("/api/customers", {
      headers: { cookie: cookies(loggedOutB.response) }
    });
    assert.equal(clearedB.response.status, 401);
    const survivingA = await request("/api/customers", { headers: { cookie: clientA.cookie } });
    assert.ok(survivingA.json.customers.some((item: any) => item.id === customerId));
  } catch (caught) {
    failure = caught;
  } finally {
    await closeServer(server).catch((caught) => { failure ??= caught; });
    await store?.close?.().catch((caught) => { failure ??= caught; });
    if (created) {
      assert.match(database, DATABASE_PATTERN);
      await admin?.query(`DROP DATABASE \`${database}\``).catch((caught) => { failure ??= caught; });
    }
    await admin?.end().catch((caught) => { failure ??= caught; });
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  if (failure) throw failure;
  console.log("DESKTOP_ACTION_STORAGE_LIVE_TEST_EXECUTED:multi-mac-crm");
});
