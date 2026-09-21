import { canonicalDouyinVideoUrl } from "./protocol";

export interface ConfirmedDouyinTab {
  id: number;
  windowId: number;
  url: string;
}

export interface BoundDouyinTab {
  tabId: number;
  windowId: number;
  url: string;
}

export interface FreshTabPreparationDependencies {
  getTab(tabId: number): Promise<ConfirmedDouyinTab & { active?: boolean }>;
  focusWindow(windowId: number): Promise<void>;
  activateTab(tabId: number): Promise<void>;
}

export function validateFreshPopupSelection(
  selected: ConfirmedDouyinTab,
  fresh: ConfirmedDouyinTab & { active?: boolean }
): boolean {
  const selectedCanonical = canonicalDouyinVideoUrl(selected.url);
  const freshCanonical = canonicalDouyinVideoUrl(fresh.url);
  return Number.isSafeInteger(selected.id) && selected.id > 0
    && Number.isSafeInteger(selected.windowId) && selected.windowId >= 0
    && selected.id === fresh.id && selected.windowId === fresh.windowId
    && selectedCanonical !== null && freshCanonical !== null
    && selectedCanonical.sourceUrl === selected.url
    && freshCanonical.sourceUrl === fresh.url
    && selected.url === fresh.url;
}

export async function prepareFreshDouyinTab(
  selected: ConfirmedDouyinTab,
  dependencies: FreshTabPreparationDependencies
): Promise<(ConfirmedDouyinTab & { active: true }) | null> {
  const before = await dependencies.getTab(selected.id);
  if (!validateFreshPopupSelection(selected, before)) return null;
  await dependencies.focusWindow(selected.windowId);
  await dependencies.activateTab(selected.id);
  const after = await dependencies.getTab(selected.id);
  if (!validateFreshPopupSelection(selected, after) || after.active !== true) return null;
  return { ...after, active: true };
}

export function sameWindowActivationIsTakeover(
  binding: BoundDouyinTab,
  activation: { tabId: number; windowId: number }
): boolean {
  return activation.windowId === binding.windowId && activation.tabId !== binding.tabId;
}

export function focusLeavesBoundWindow(
  binding: BoundDouyinTab,
  focusedWindowId: number,
  windowIdNone: number
): boolean {
  return focusedWindowId !== windowIdNone && focusedWindowId !== binding.windowId;
}

export function boundTabNavigationIsTakeover(
  binding: BoundDouyinTab,
  tabId: number,
  nextUrl: string | undefined
): boolean {
  if (tabId !== binding.tabId || nextUrl === undefined) return false;
  return canonicalDouyinVideoUrl(nextUrl)?.sourceUrl !== binding.url;
}

export function boundTabDocumentLifecycleIsTakeover(
  binding: BoundDouyinTab,
  tabId: number,
  changeInfo: { status?: string; url?: string }
): boolean {
  if (tabId !== binding.tabId) return false;
  return changeInfo.status === "loading"
    || boundTabNavigationIsTakeover(binding, tabId, changeInfo.url);
}

export function boundTabReplacementIsTakeover(
  binding: BoundDouyinTab,
  _addedTabId: number,
  removedTabId: number
): boolean {
  return removedTabId === binding.tabId;
}
