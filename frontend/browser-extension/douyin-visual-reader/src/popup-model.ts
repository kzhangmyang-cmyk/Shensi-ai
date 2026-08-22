import { canonicalDouyinVideoUrl } from "./protocol";

export interface SelectableDouyinTab {
  id: number;
  windowId: number;
  title: string;
  url: string;
}

export function createPopupSelectionModel(candidates: SelectableDouyinTab[]) {
  const tabs = candidates.filter((tab) => Number.isSafeInteger(tab.id)
    && tab.id > 0 && Number.isSafeInteger(tab.windowId) && tab.windowId >= 0
    && canonicalDouyinVideoUrl(tab.url)?.sourceUrl === tab.url);
  let selected: number | null = null;
  return {
    tabs: () => tabs.map((tab) => ({ ...tab })),
    selectedTabId: () => selected,
    select(tabId: number) {
      if (!tabs.some((tab) => tab.id === tabId)) return false;
      selected = tabId;
      return true;
    },
    canStart: () => selected !== null,
    confirm: () => tabs.find((tab) => tab.id === selected) ?? null
  };
}
