import type {
  CashForecastAmountField,
  CashForecastReceivableDraft,
  FinancialCashForecastDraft,
  FinancialCashForecastDraftSnapshot
} from "./cash-forecast-draft";

export type AgentsRoute =
  | { view: "overview" }
  | { view: "report" }
  | { view: "detail"; agentId: string };

export function parseAgentsHash(hash: string): AgentsRoute | null {
  const pathname = hash.replace(/^#/, "").split("?")[0];
  if (pathname === "growth/agents") return { view: "overview" };
  if (pathname === "growth/agents/report") return { view: "report" };
  const match = /^growth\/agents\/([A-Za-z0-9_-]+)$/u.exec(pathname);
  if (match) return { view: "detail", agentId: match[1]! };
  return null;
}

type ForecastEventRoot = Document | HTMLElement;

let activeDraft: FinancialCashForecastDraft | null = null;

export function currentFinancialCashForecastDraftSnapshot():
FinancialCashForecastDraftSnapshot | null {
  return activeDraft?.snapshot() ?? null;
}

export function currentFinancialCashForecastDraftComplete(): boolean {
  return activeDraft?.isComplete() ?? false;
}

function syncCommit(root: ForecastEventRoot, draft: FinancialCashForecastDraft): void {
  const commit = root.querySelector<HTMLButtonElement>('[data-real-action="commit"]');
  const consent = root.querySelector<HTMLInputElement>("[data-real-consent]");
  if (commit) commit.disabled = !(consent?.checked === true && draft.isComplete());
}

function receivableValue(row: HTMLElement): CashForecastReceivableDraft {
  const value = (field: string) => row.querySelector<HTMLInputElement>(
    `[data-cash-forecast-receivable-field="${field}"]`
  )?.value ?? "";
  return {
    customer: value("customer"),
    amount: value("amount"),
    daysOutstanding: value("daysOutstanding")
  };
}

function appendReceivableRow(root: ForecastEventRoot, serial: number): void {
  const rows = root.querySelector<HTMLElement>("[data-cash-forecast-receivables]");
  const documentPort = rows?.ownerDocument;
  if (!rows || !documentPort) return;
  const position = rows.querySelectorAll("[data-cash-forecast-receivable-row]").length + 1;
  const row = documentPort.createElement("fieldset");
  row.className = "cash-forecast-receivable";
  row.setAttribute("data-cash-forecast-receivable-row", "");
  row.innerHTML = `<legend>应收账款 ${position}</legend>
    <label for="cash-forecast-customer-${serial}">应收客户 ${position}</label>
    <input id="cash-forecast-customer-${serial}" type="text" maxlength="255"
      autocomplete="off" data-cash-forecast-receivable-field="customer">
    <label for="cash-forecast-amount-${serial}">应收金额 ${position}</label>
    <input id="cash-forecast-amount-${serial}" type="text" inputmode="decimal"
      autocomplete="off" data-cash-forecast-receivable-field="amount">
    <label for="cash-forecast-days-${serial}">逾期天数 ${position}</label>
    <input id="cash-forecast-days-${serial}" type="text" inputmode="numeric"
      autocomplete="off" data-cash-forecast-receivable-field="daysOutstanding">
    <button type="button" data-cash-forecast-receivable-remove>删除应收账款 ${position}</button>`;
  rows.append(row);
  root.querySelector<HTMLElement>("[data-cash-forecast-receivables-empty]")?.setAttribute(
    "hidden", ""
  );
}

export function bindFinancialCashForecastDraft(
  root: ForecastEventRoot,
  draft: FinancialCashForecastDraft
): () => void {
  let nextRowSerial = 1;
  const onInput = (event: Event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target || !root.contains(target)) return;
    const amount = target.closest<HTMLInputElement>("[data-cash-forecast-amount]");
    if (amount) {
      draft.setAmount(amount.dataset.cashForecastAmount as CashForecastAmountField, amount.value);
      syncCommit(root, draft);
      return;
    }
    const row = target.closest<HTMLElement>("[data-cash-forecast-receivable-row]");
    if (row) {
      const rows = [...root.querySelectorAll<HTMLElement>(
        "[data-cash-forecast-receivable-row]"
      )];
      draft.updateReceivable(rows.indexOf(row), receivableValue(row));
      syncCommit(root, draft);
      return;
    }
    if (target.matches("[data-cash-forecast-attestation]")) {
      draft.setAttestation(target.checked);
      syncCommit(root, draft);
    }
  };
  const onClick = (event: Event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-cash-forecast-receivable-add], [data-cash-forecast-receivable-empty], [data-cash-forecast-receivable-remove]"
    );
    if (!target || !root.contains(target)) return;
    if (target.matches("[data-cash-forecast-receivable-add]")) {
      try {
        draft.addReceivable();
        appendReceivableRow(root, nextRowSerial++);
      } catch { /* Maximum row count remains closed without logging private data. */ }
    } else if (target.matches("[data-cash-forecast-receivable-empty]")) {
      draft.setReceivablesEmpty();
      root.querySelector<HTMLElement>("[data-cash-forecast-receivables]")?.replaceChildren();
      root.querySelector<HTMLElement>("[data-cash-forecast-receivables-empty]")
        ?.removeAttribute("hidden");
    } else {
      const row = target.closest<HTMLElement>("[data-cash-forecast-receivable-row]");
      if (row) {
        const rows = [...root.querySelectorAll<HTMLElement>(
          "[data-cash-forecast-receivable-row]"
        )];
        draft.removeReceivable(rows.indexOf(row));
        row.remove();
      }
    }
    syncCommit(root, draft);
  };
  root.addEventListener("input", onInput);
  root.addEventListener("change", onInput);
  root.addEventListener("click", onClick);
  return () => {
    root.removeEventListener("input", onInput);
    root.removeEventListener("change", onInput);
    root.removeEventListener("click", onClick);
  };
}

export function activateFinancialCashForecastDraft(
  draft: FinancialCashForecastDraft
): () => void {
  activeDraft = draft;
  const unbind = typeof document === "undefined"
    ? () => undefined
    : bindFinancialCashForecastDraft(document, draft);
  return () => {
    unbind();
    if (activeDraft === draft) activeDraft = null;
  };
}
