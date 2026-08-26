import { strict as assert } from "node:assert";
import { createRealConversationsController, shouldUseRealConversations } from "./real-controller";
import type { RealConversationsApi, RealConversationsSnapshot } from "./real-api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function fakeElement() {
  const listeners = new Map<string, (event: Event) => void>();
  return {
    innerHTML: "",
    addEventListener(type: string, listener: (event: Event) => void) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) { listeners.delete(type); },
    contains() { return true; },
    dispatch(type: string, event: Event) { listeners.get(type)?.(event); }
  };
}

const snapshot: RealConversationsSnapshot = {
  generatedAt: "2026-08-26T08:00:00.000Z",
  runsRead: 1,
  receiptAccess: "known_batch_id_only",
  truncatedRunIds: [],
  failedRuns: [],
  interactions: [{
    key: "run-1:candidate-1",
    candidateId: "candidate-1",
    runId: "run-1",
    taskId: "task-1",
    taskName: "展厅公开需求",
    runStatus: "succeeded",
    runUpdatedAt: "2026-08-26T07:50:00.000Z",
    displayName: "公开用户 A",
    candidateStatus: "new",
    excerpt: "公开评论证据",
    sourceUrl: "https://www.douyin.com/video/123"
  }]
};

assert.equal(shouldUseRealConversations("conversations", "real"), true);
assert.equal(shouldUseRealConversations("conversations", "demo"), false);
assert.equal(shouldUseRealConversations("dashboard", "real"), false);

{
  const main = fakeElement();
  const inspector = fakeElement();
  let reads = 0;
  const api: RealConversationsApi = {
    async load() { reads += 1; return snapshot; }
  };
  const controller = createRealConversationsController({
    api,
    main: main as unknown as HTMLElement,
    inspector: inspector as unknown as HTMLElement
  });
  await controller.open();
  assert.equal(reads, 1);
  assert.equal(controller.getState().status, "ready");
  assert.equal(controller.getState().selectedInteractionKey, "run-1:candidate-1");
  assert.match(main.innerHTML, /公开用户 A/);
  assert.match(main.innerHTML + inspector.innerHTML, /发送不可用/);
  controller.destroy();
}

{
  const first = deferred<RealConversationsSnapshot>();
  let reads = 0;
  const api: RealConversationsApi = {
    load() {
      reads += 1;
      return reads === 1
        ? first.promise
        : Promise.resolve({ ...snapshot, interactions: [] });
    }
  };
  const main = fakeElement();
  const inspector = fakeElement();
  const controller = createRealConversationsController({
    api,
    main: main as unknown as HTMLElement,
    inspector: inspector as unknown as HTMLElement
  });
  const oldRequest = controller.open();
  await controller.open();
  first.resolve(snapshot);
  await oldRequest;
  assert.equal(controller.getState().snapshot?.interactions.length, 0);
  controller.destroy();
}

{
  const pending = deferred<RealConversationsSnapshot>();
  const main = fakeElement();
  const inspector = fakeElement();
  const controller = createRealConversationsController({
    api: { load: () => pending.promise },
    main: main as unknown as HTMLElement,
    inspector: inspector as unknown as HTMLElement
  });
  const operation = controller.open();
  controller.deactivate();
  main.innerHTML = "<h2>其他模块</h2>";
  inspector.innerHTML = "<p>其他模块</p>";
  pending.resolve(snapshot);
  await operation;
  assert.equal(main.innerHTML, "<h2>其他模块</h2>");
  assert.equal(inspector.innerHTML, "<p>其他模块</p>");
  controller.destroy();
}

{
  const controller = createRealConversationsController({
    api: { async load() { throw new Error("真实公开互动读取失败"); } }
  });
  await assert.rejects(() => controller.open(), /真实公开互动读取失败/);
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().error, "真实公开互动读取失败");
  controller.destroy();
}
