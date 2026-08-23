import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import {
  createAuthoritativeDealCreateApi,
  createDealCreateController,
  type AuthoritativeDealCreateInput
} from "./deal-create-controller";

const customer = {
  id: "customer-deal-test",
  company: "测试客户",
  country: "中国",
  contact: "王总",
  ownerId: "owner-1",
  teamId: "team-1",
  stage: "待首次跟进",
  amount: 18_000,
  health: 80,
  nextReminder: "2026-08-25T08:00:00.000Z",
  wecomBound: false,
  activities: [],
  acquisitionBindings: [{
    handoffId: "handoff-1",
    leadId: "lead-1",
    candidateId: "candidate-1",
    createdAt: "2026-08-23T08:00:00.000Z"
  }]
};

const input: AuthoritativeDealCreateInput = {
  title: "测试商机",
  customerId: customer.id,
  product: "测试产品",
  quantity: 30,
  unitPrice: 600,
  amount: 18_000,
  currency: "USD",
  nextAction: "确认采购清单并安排报价",
  nextActionAt: "2026-08-25",
  expectedCloseAt: "2026-09-13",
  acquisitionBinding: { handoffId: "handoff-1", leadId: "lead-1" }
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfil, fail) => {
    resolve = fulfil;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function assertPendingExitCanStartAnotherDeal(
  exitButtonId: "replicaDealCreateCancel" | "replicaDealCreateClose",
  settleOld: (operation: ReturnType<typeof deferred<{ deal: { id: string } }>>) => void
): Promise<void> {
  const { document } = parseHTML(`<!doctype html><html><body class="is-authenticated">
    <div id="replicaToast"><span></span></div>
    <dialog id="replicaDealCreateDialog">
      <form id="replicaDealCreateForm">
        <input id="dealCustomerIdInput" />
        <input id="dealCustomerInput" />
        <input id="dealTitleInput" />
        <input id="dealProductInput" />
        <select id="dealAcquisitionBindingInput"></select>
        <select id="dealCurrencyInput"><option value="USD" selected>USD</option></select>
        <input id="dealQuantityInput" value="30" />
        <input id="dealUnitPriceInput" value="600" />
        <input id="dealAmountInput" value="18000" />
        <input id="dealNextActionAtInput" />
        <input id="dealExpectedCloseAtInput" />
        <input id="dealNextActionInput" value="确认采购清单并安排报价" />
        <div id="replicaDealCreateStatus"></div>
        <button id="saveDealButton" type="submit">保存商机</button>
        <button id="replicaDealCreateCancel" type="button">取消</button>
        <button id="replicaDealCreateClose" type="button">关闭</button>
      </form>
    </dialog>
  </body></html>`);
  const dialog = document.querySelector<HTMLDialogElement>("#replicaDealCreateDialog")!;
  const form = document.querySelector<HTMLFormElement>("#replicaDealCreateForm")!;
  const save = document.querySelector<HTMLButtonElement>("#saveDealButton")!;
  Object.assign(dialog, {
    showModal() {
      dialog.setAttribute("open", "");
    },
    close() {
      dialog.removeAttribute("open");
    }
  });
  Object.assign(form, {
    reset() {
      form.querySelectorAll<HTMLInputElement>("input").forEach((field) => {
        field.value = field.getAttribute("value") ?? "";
      });
      form.querySelectorAll<HTMLSelectElement>("select").forEach((field) => {
        field.selectedIndex = field.options.length > 0 ? 0 : -1;
      });
    }
  });
  const oldOperation = deferred<{ deal: { id: string } }>();
  const newOperation = deferred<{ deal: { id: string } }>();
  let createRequests = 0;
  const location = { hash: "#private-domain" };
  const controller = createDealCreateController({
    document,
    location,
    api: {
      async getCustomer() {
        return customer;
      },
      createDeal() {
        createRequests += 1;
        return createRequests === 1
          ? oldOperation.promise
          : newOperation.promise;
      }
    }
  });

  const openDeal = async () => {
    dispatchCustomEvent(document, "goodjob:deal-create-requested", {
      customerId: customer.id
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(dialog.hasAttribute("open"), true);
  };
  const fillAndSubmit = async (title: string) => {
    document.querySelector<HTMLInputElement>("#dealTitleInput")!.value = title;
    document.querySelector<HTMLInputElement>("#dealProductInput")!.value = "测试产品";
    document.querySelector<HTMLInputElement>("#dealNextActionInput")!.value = "确认采购清单并安排报价";
    document.querySelector<HTMLInputElement>("#dealNextActionAtInput")!.value = "2026-08-25";
    const binding = document.querySelector<HTMLSelectElement>(
      "#dealAcquisitionBindingInput"
    )!;
    binding.querySelector("option")!.setAttribute("selected", "");
    binding.selectedIndex = 0;
    const submit = document.createEvent("Event");
    submit.initEvent("submit", true, true);
    form.dispatchEvent(submit);
    await Promise.resolve();
  };

  await openDeal();
  await fillAndSubmit("old deal");
  assert.equal(save.disabled, true);
  document.querySelector<HTMLButtonElement>(`#${exitButtonId}`)!.click();
  assert.equal(dialog.hasAttribute("open"), false);

  await openDeal();
  assert.equal(save.disabled, false);
  await fillAndSubmit("new deal");
  assert.equal(createRequests, 2);
  assert.equal(save.disabled, true);

  settleOld(oldOperation);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(location.hash, "#private-domain");
  assert.equal(dialog.hasAttribute("open"), true);
  assert.equal(save.disabled, true);
  assert.equal(
    document.querySelector("#replicaDealCreateStatus")?.textContent,
    "正在创建真实商机…"
  );
  controller.destroy();
}

function dispatchCustomEvent(
  document: Document,
  type: string,
  detail: unknown
): void {
  const event = document.createEvent("CustomEvent");
  event.initCustomEvent(type, false, false, detail);
  document.dispatchEvent(event);
}

{
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const api = createAuthoritativeDealCreateApi({
    cookieSource: () => "session=1; gj_csrf=csrf%2Fdeal",
    fetchImpl: async (path, init = {}) => {
      requests.push({ path: String(path), init });
      return String(path).startsWith("/api/customers")
        ? new Response(JSON.stringify({ customers: [customer] }), { status: 200 })
        : new Response(JSON.stringify({ deal: { id: "deal-1" } }), { status: 201 });
    }
  });

  assert.equal((await api.getCustomer(customer.id))?.id, customer.id);
  assert.equal((await api.createDeal(input)).deal.id, "deal-1");
  assert.equal(requests[0]?.path, "/api/customers?scope=mine");
  assert.equal(requests[0]?.init.credentials, "same-origin");
  assert.equal(new Headers(requests[0]?.init.headers).get("x-csrf-token"), null);
  assert.equal(requests[1]?.path, "/api/deals");
  assert.equal(requests[1]?.init.credentials, "same-origin");
  assert.equal(
    new Headers(requests[1]?.init.headers).get("x-csrf-token"),
    "csrf/deal"
  );
  assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), input);
}

{
  let unauthorized = 0;
  const api = createAuthoritativeDealCreateApi({
    cookieSource: () => "",
    onUnauthorized: () => {
      unauthorized += 1;
    },
    fetchImpl: async () => new Response(
      JSON.stringify({ message: "登录已失效" }),
      { status: 401 }
    )
  });

  await assert.rejects(api.getCustomer(customer.id), /登录已失效/u);
  assert.equal(unauthorized, 1);
}

{
  const { document } = parseHTML(`<!doctype html><html><body class="is-authenticated">
    <div id="replicaToast"><span>初始提示</span></div>
    <dialog id="replicaDealCreateDialog">
      <form id="replicaDealCreateForm">
        <input id="dealCustomerIdInput" />
        <input id="dealCustomerInput" />
        <input id="dealTitleInput" />
        <input id="dealProductInput" />
        <select id="dealAcquisitionBindingInput"></select>
        <select id="dealCurrencyInput"><option value="USD" selected>USD</option></select>
        <input id="dealQuantityInput" value="30" />
        <input id="dealUnitPriceInput" value="600" />
        <input id="dealAmountInput" value="18000" />
        <input id="dealNextActionAtInput" />
        <input id="dealExpectedCloseAtInput" />
        <input id="dealNextActionInput" value="确认采购清单并安排报价" />
        <div id="replicaDealCreateStatus"></div>
        <button id="saveDealButton" type="submit">保存商机</button>
        <button id="replicaDealCreateCancel" type="button">取消</button>
        <button id="replicaDealCreateClose" type="button">关闭</button>
      </form>
    </dialog>
  </body></html>`);
  const dialog = document.querySelector<HTMLDialogElement>("#replicaDealCreateDialog")!;
  const form = document.querySelector<HTMLFormElement>("#replicaDealCreateForm")!;
  Object.assign(dialog, {
    showModal() {
      dialog.setAttribute("open", "");
    },
    close() {
      dialog.removeAttribute("open");
    }
  });
  Object.assign(form, {
    reset() {
      form.querySelectorAll<HTMLInputElement>("input").forEach((field) => {
        field.value = field.getAttribute("value") ?? "";
      });
      form.querySelectorAll<HTMLSelectElement>("select").forEach((field) => {
        field.selectedIndex = field.options.length > 0 ? 0 : -1;
      });
    }
  });
  const pendingDeal = deferred<{ deal: { id: string } }>();
  let createSignal: AbortSignal | undefined;
  let customerRequests = 0;
  const location = { hash: "#private-domain" };
  const controller = createDealCreateController({
    document,
    location,
    api: {
      async getCustomer() {
        customerRequests += 1;
        return customer;
      },
      createDeal(_input, signal?: AbortSignal) {
        createSignal = signal;
        return pendingDeal.promise;
      }
    }
  });

  dispatchCustomEvent(document, "goodjob:deal-create-requested", {
    customerId: customer.id
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(dialog.hasAttribute("open"), true);
  document.querySelector<HTMLInputElement>("#dealTitleInput")!.value = "敏感商机";
  document.querySelector<HTMLInputElement>("#dealProductInput")!.value = "敏感产品";
  document.querySelector<HTMLInputElement>("#dealNextActionAtInput")!.value = "2026-08-25";
  document.querySelector<HTMLOptionElement>(
    "#dealAcquisitionBindingInput option"
  )!.setAttribute("selected", "");
  const submit = document.createEvent("Event");
  submit.initEvent("submit", true, true);
  form.dispatchEvent(submit);
  await Promise.resolve();

  document.body.classList.remove("is-authenticated");
  dispatchCustomEvent(document, "goodjob:auth-state-changed", {
    authenticated: false
  });

  assert.equal(dialog.hasAttribute("open"), false);
  assert.equal(createSignal?.aborted, true);
  assert.equal(document.querySelector<HTMLInputElement>("#dealCustomerIdInput")?.value, "");
  assert.equal(document.querySelector<HTMLInputElement>("#dealCustomerInput")?.value, "");
  assert.equal(document.querySelector<HTMLInputElement>("#dealTitleInput")?.value, "");
  assert.equal(document.querySelector<HTMLInputElement>("#dealProductInput")?.value, "");
  assert.equal(document.querySelector("#dealAcquisitionBindingInput")?.textContent, "");
  assert.equal(document.querySelector("#replicaDealCreateStatus")?.textContent, "");

  pendingDeal.resolve({ deal: { id: "late-deal" } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(dialog.hasAttribute("open"), false);
  assert.equal(location.hash, "#private-domain");
  assert.doesNotMatch(dialog.textContent, /敏感商机|敏感产品|测试客户/u);

  document.body.classList.add("is-authenticated");
  dispatchCustomEvent(document, "goodjob:deal-create-requested", {
    customerId: customer.id
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(dialog.hasAttribute("open"), true);
  assert.equal(customerRequests, 2);
  controller.destroy();
  assert.equal(dialog.hasAttribute("open"), false);
  assert.equal(document.querySelector<HTMLInputElement>("#dealCustomerIdInput")?.value, "");
  dispatchCustomEvent(document, "goodjob:deal-create-requested", {
    customerId: customer.id
  });
  await Promise.resolve();
  assert.equal(customerRequests, 2);
}

await assertPendingExitCanStartAnotherDeal(
  "replicaDealCreateCancel",
  (operation) => operation.resolve({ deal: { id: "late-old-deal" } })
);
await assertPendingExitCanStartAnotherDeal(
  "replicaDealCreateClose",
  (operation) => operation.reject(new Error("late old failure"))
);
