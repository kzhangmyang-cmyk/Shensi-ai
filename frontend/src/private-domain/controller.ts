import {
  createPrivateDomainRuntimeApi,
  pendingAcquisitionBindings,
  type PrivateDomainRuntimeApi
} from "./runtime-api";
import {
  renderPrivateDomainView,
  type PrivateDomainViewState
} from "./view";

export interface PrivateDomainControllerOptions {
  api?: PrivateDomainRuntimeApi;
  main?: HTMLElement | null;
  inspector?: HTMLElement | null;
  eventTarget?: EventTarget;
}

export interface PrivateDomainController {
  getState(): Readonly<PrivateDomainViewState>;
  whenIdle(): Promise<void>;
  open(preferredCustomerId?: string): Promise<void>;
  deactivate(): void;
  selectCustomer(customerId: string): void;
  destroy(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "真实私域数据读取失败";
}

export function createPrivateDomainController(
  options: PrivateDomainControllerOptions = {}
): PrivateDomainController {
  const api = options.api ?? createPrivateDomainRuntimeApi();
  const main = options.main ?? (typeof document === "undefined"
    ? null
    : document.getElementById("demoModuleMain"));
  const inspector = options.inspector ?? (typeof document === "undefined"
    ? null
    : document.getElementById("demoModuleInspector"));
  const eventTarget = options.eventTarget ?? (typeof document === "undefined"
    ? new EventTarget()
    : document);
  const state: PrivateDomainViewState = {
    status: "ready",
    customers: [],
    todos: [],
    selectedCustomerId: null,
    error: null
  };
  let disposed = false;
  let active = false;
  let requestSerial = 0;
  let idlePromise = Promise.resolve();

  function render() {
    if (active && main && inspector) {
      renderPrivateDomainView(state, main, inspector);
    }
  }

  const controller: PrivateDomainController = {
    getState() {
      return state;
    },
    whenIdle() {
      return idlePromise;
    },
    open(preferredCustomerId) {
      active = true;
      const serial = ++requestSerial;
      state.status = "loading";
      state.error = null;
      render();
      const operation = (async () => {
        try {
          const [customers, todos] = await Promise.all([
            api.getCustomers(),
            api.getTodos()
          ]);
          if (disposed || serial !== requestSerial) return;
          state.customers = customers;
          state.todos = todos;
          const preferred = preferredCustomerId?.trim() ?? "";
          state.selectedCustomerId = customers.some((customer) =>
            customer.id === preferred)
            ? preferred
            : customers.some((customer) =>
                customer.id === state.selectedCustomerId)
              ? state.selectedCustomerId
              : customers[0]?.id ?? null;
          state.status = "ready";
          state.error = null;
          render();
        } catch (error) {
          if (disposed || serial !== requestSerial) return;
          state.status = "error";
          state.error = errorText(error);
          render();
          throw error;
        }
      })();
      idlePromise = operation.then(() => undefined, () => undefined);
      return operation;
    },
    deactivate() {
      active = false;
      requestSerial += 1;
    },
    selectCustomer(customerId) {
      const normalized = customerId.trim();
      if (!state.customers.some((customer) => customer.id === normalized)) {
        return;
      }
      state.selectedCustomerId = normalized;
      render();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      controller.deactivate();
      main?.removeEventListener("click", onClick);
      inspector?.removeEventListener("click", onClick);
      eventTarget.removeEventListener(
        "goodjob:acquisition-deal-created",
        onAcquisitionDealCreated
      );
    }
  };

  function onClick(event: Event) {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-private-domain-action]"
    );
    if (!target || (!main?.contains(target) && !inspector?.contains(target))) return;
    if (target.dataset.privateDomainAction === "select-customer") {
      controller.selectCustomer(target.dataset.customerId ?? "");
    } else if (target.dataset.privateDomainAction === "create-deal") {
      const customerId = target.dataset.customerId?.trim() ?? "";
      const customer = state.customers.find((item) => item.id === customerId);
      if (pendingAcquisitionBindings(customer).length === 0) return;
      eventTarget.dispatchEvent(new CustomEvent(
        "goodjob:deal-create-requested",
        { detail: { customerId } }
      ));
    } else if (target.dataset.privateDomainAction === "open-quote-workbench") {
      const customerId = target.dataset.customerId?.trim() ?? "";
      const customer = state.customers.find((item) => item.id === customerId);
      if (!customer) return;
      const binding = (customer.acquisitionBindings ?? []).find((item) =>
        typeof item?.handoffId === "string" && Boolean(item.handoffId.trim()));
      eventTarget.dispatchEvent(new CustomEvent(
        "goodjob:quote-workbench-requested",
        {
          detail: {
            customerId,
            candidateId: binding?.candidateId ?? undefined
          }
        }
      ));
    } else if (target.dataset.privateDomainAction === "retry") {
      void controller.open(state.selectedCustomerId ?? undefined).catch(
        () => undefined
      );
    }
  }

  function onAcquisitionDealCreated(event: Event) {
    if (!active || disposed) return;
    const detail = (event as CustomEvent<{ customerId?: unknown }>).detail;
    const customerId = typeof detail?.customerId === "string"
      ? detail.customerId.trim()
      : "";
    if (!customerId) return;
    void controller.open(customerId).catch(() => undefined);
  }

  main?.addEventListener("click", onClick);
  inspector?.addEventListener("click", onClick);
  eventTarget.addEventListener(
    "goodjob:acquisition-deal-created",
    onAcquisitionDealCreated
  );
  render();
  return controller;
}
