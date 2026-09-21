export const ROI_TAB_KEYS = ["expected", "actual", "cash"] as const;

export type RoiTabKey = typeof ROI_TAB_KEYS[number];

interface RoiTabDefinition {
  readonly key: RoiTabKey;
  readonly label: string;
  readonly tabId: string;
  readonly panelId: string;
}

const ROI_TABS: readonly RoiTabDefinition[] = [
  {
    key: "expected",
    label: "预计 ROI",
    tabId: "roi-tab-expected",
    panelId: "roi-panel-expected"
  },
  {
    key: "actual",
    label: "已关账实际 ROI",
    tabId: "roi-tab-actual",
    panelId: "roi-panel-actual"
  },
  {
    key: "cash",
    label: "现金回收",
    tabId: "roi-tab-cash",
    panelId: "roi-panel-cash"
  }
];

function tabDefinition(key: RoiTabKey): RoiTabDefinition {
  const tab = ROI_TABS.find((candidate) => candidate.key === key);
  if (!tab) throw new Error(`Unknown ROI tab: ${key}`);
  return tab;
}

function roiTabButtons(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("[data-roi-tab]")];
}

function isRoiTabKey(value: string | undefined): value is RoiTabKey {
  return value !== undefined && ROI_TAB_KEYS.includes(value as RoiTabKey);
}

export function renderRoiTabList(): string {
  return `<nav class="roi-view-tabs" role="tablist" aria-label="ROI 分析口径" aria-orientation="horizontal">
    ${ROI_TABS.map((tab) => {
      const active = tab.key === "expected";
      return `<button type="button" id="${tab.tabId}" class="${active ? "active" : ""}" role="tab" aria-selected="${active}" aria-controls="${tab.panelId}" tabindex="${active ? "0" : "-1"}" data-roi-tab="${tab.key}">${tab.label}</button>`;
    }).join("")}
  </nav>`;
}

export function roiTabPanelAttributes(key: RoiTabKey): string {
  const tab = tabDefinition(key);
  const active = key === "expected";
  return `id="${tab.panelId}" role="tabpanel" aria-labelledby="${tab.tabId}" data-roi-panel="${key}"${active ? "" : " hidden"}`;
}

/**
 * Applies the tab and panel state without changing the current ROI query.
 * Clicks use the browser's native focus behavior; keyboard navigation asks
 * this helper to move focus with the selected tab.
 */
export function activateRoiTab(
  host: HTMLElement,
  key: string | undefined,
  options: { readonly focus?: boolean } = {}
): boolean {
  if (!isRoiTabKey(key)) return false;
  const tabs = roiTabButtons(host);
  const activeTab = tabs.find((tab) => tab.dataset.roiTab === key);
  if (!activeTab) return false;

  tabs.forEach((tab) => {
    const active = tab === activeTab;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.setAttribute("tabindex", active ? "0" : "-1");
  });
  host.querySelectorAll<HTMLElement>("[data-roi-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.roiPanel !== key;
  });
  if (options.focus) activeTab.focus();
  return true;
}

/**
 * Implements the horizontal ARIA tab keyboard pattern with wrapping arrow
 * navigation and direct Home/End selection. Returns whether the caller must
 * prevent the browser's native key behavior.
 */
export function moveRoiTabWithKey(
  host: HTMLElement,
  currentTab: HTMLButtonElement,
  key: string
): boolean {
  if (!ROI_TAB_KEYS.includes(currentTab.dataset.roiTab as RoiTabKey)) return false;
  const tabs = roiTabButtons(host);
  const currentIndex = tabs.indexOf(currentTab);
  if (currentIndex < 0 || tabs.length === 0) return false;

  let targetIndex: number;
  switch (key) {
    case "ArrowLeft":
      targetIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      break;
    case "ArrowRight":
      targetIndex = (currentIndex + 1) % tabs.length;
      break;
    case "Home":
      targetIndex = 0;
      break;
    case "End":
      targetIndex = tabs.length - 1;
      break;
    default:
      return false;
  }

  return activateRoiTab(host, tabs[targetIndex]?.dataset.roiTab, { focus: true });
}
