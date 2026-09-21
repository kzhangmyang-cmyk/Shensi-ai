import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { DashboardRequestError, type RealDashboardApi } from "./real-api";
import { createRealDashboardController, shouldUseRealDashboard } from "./real-controller";
import { realDashboardFixture } from "./real-view.self-test";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function hosts() {
  const { document, window } = parseHTML("<main id='main'></main><aside id='inspector'></aside>");
  return {
    main: document.querySelector<HTMLElement>("#main")!,
    inspector: document.querySelector<HTMLElement>("#inspector")!,
    window
  };
}

assert.equal(shouldUseRealDashboard("dashboard", "real"), true);
assert.equal(shouldUseRealDashboard("dashboard", "demo"), false);
assert.equal(shouldUseRealDashboard("conversations", "real"), false);

{
  const { main, inspector } = hosts();
  const first = deferred<typeof realDashboardFixture>();
  let calls = 0;
  const api: RealDashboardApi = {
    load() {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve(realDashboardFixture);
    }
  };
  const controller = createRealDashboardController({ api, main, inspector });
  const stale = controller.open();
  await controller.open();
  first.resolve({ ...realDashboardFixture, scope: "stale-scope" });
  await stale;
  assert.match(main.textContent ?? "", /真实经营数据/u);
  assert.doesNotMatch(main.textContent ?? "", /stale-scope/u);
  controller.destroy();
}

{
  const { main, inspector } = hosts();
  let unauthorizedCalls = 0;
  const controller = createRealDashboardController({
    api: {
      async load() {
        throw new DashboardRequestError(401, "unauthorized");
      }
    },
    main,
    inspector,
    onUnauthorized() {
      unauthorizedCalls += 1;
    }
  });

  await controller.open();
  assert.equal(unauthorizedCalls, 1);
  assert.doesNotMatch(main.textContent ?? "", /真实经营数据暂时不可用/u);
  controller.destroy();
}

{
  const { main, inspector } = hosts();
  let unauthorizedCalls = 0;
  const controller = createRealDashboardController({
    api: {
      async load() {
        throw new DashboardRequestError(503, "dashboard_unavailable");
      }
    },
    main,
    inspector,
    onUnauthorized() {
      unauthorizedCalls += 1;
    }
  });

  await assert.rejects(controller.open(), /dashboard_unavailable/u);
  assert.equal(unauthorizedCalls, 0);
  assert.match(main.textContent ?? "", /真实经营数据暂时不可用/u);
  assert.match(main.textContent ?? "", /重试/u);
  controller.destroy();
}

{
  const { main, inspector, window } = hosts();
  let calls = 0;
  const periods: Array<string | undefined> = [];
  const controller = createRealDashboardController({
    api: {
      async load(_signal, period) {
        calls += 1;
        periods.push(period);
        if (calls === 1) throw new Error("dashboard_down");
        return period === "month"
          ? { ...realDashboardFixture, history: { ...realDashboardFixture.history, period: "month", label: "本月" } }
          : realDashboardFixture;
      }
    },
    main,
    inspector
  });
  await assert.rejects(controller.open(), /dashboard_down/u);
  main.querySelector<HTMLElement>('[data-real-dashboard-action="retry"]')!
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  await controller.whenIdle();
  assert.equal(calls, 2);
  assert.match(main.textContent ?? "", /真实经营数据/u);
  main.querySelector<HTMLElement>('[data-real-dashboard-period="month"]')!
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  await controller.whenIdle();
  assert.deepEqual(periods, ["3m", "3m", "month"]);
  assert.equal(controller.getState().period, "month");
  controller.destroy();
}

{
  const { main, inspector } = hosts();
  const pending = deferred<typeof realDashboardFixture>();
  const controller = createRealDashboardController({
    api: { load: () => pending.promise }, main, inspector
  });
  const operation = controller.open();
  controller.deactivate();
  pending.resolve(realDashboardFixture);
  await operation;
  assert.equal(controller.getState().summary, null);
  assert.doesNotMatch(main.textContent ?? "", /本团队业务数据/u,
    "a deactivated controller must ignore its late response");
  controller.destroy();
}
