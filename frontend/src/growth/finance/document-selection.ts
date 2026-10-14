import type { components } from '../../generated/growth-advisor-quote-roi';
export type FinanceDocumentMaterialSource = components['schemas']['FinanceDocumentMaterialSource'];
let selected: { scope: string; source: FinanceDocumentMaterialSource } | null = null;
let removeSessionGuard: (() => void) | undefined;
const listeners = new Set<() => void>();
export function financeDocumentScope(workspaceId: string | null | undefined, userId: string | null | undefined): string | null {
  return workspaceId && userId ? JSON.stringify([workspaceId, userId]) : null;
}
export function getFinanceDocumentSelection(scope: string | null): FinanceDocumentMaterialSource | null {
  return scope && selected?.scope === scope ? selected.source : null;
}
export function setFinanceDocumentSelection(scope: string, source: FinanceDocumentMaterialSource | null): void {
  if (!source && selected?.scope !== scope) return;
  if (source && selected?.scope === scope && selected.source.documentId === source.documentId && selected.source.fileHash === source.fileHash) return;
  selected = source ? { scope, source: Object.freeze({ ...source, missingStatements: [...source.missingStatements] }) } : null;
  removeSessionGuard?.(); removeSessionGuard = undefined;
  if (source && typeof document !== 'undefined' && document.body) {
    const doc = document;
    const resetIfChanged = () => {
      if (financeDocumentScope(doc.body.dataset.sessionWorkspaceId, doc.body.dataset.sessionUserId) !== scope) resetFinanceDocumentSelection();
    };
    const observer = new MutationObserver(resetIfChanged);
    observer.observe(doc.body, { attributes: true, attributeFilter: ['data-session-workspace-id', 'data-session-user-id'] });
    const onAuth = (event: Event) => {
      if ((event as CustomEvent<{ authenticated?: boolean }>).detail?.authenticated === false) resetFinanceDocumentSelection();
    };
    doc.addEventListener('goodjob:auth-state-changed', onAuth);
    removeSessionGuard = () => { observer.disconnect(); doc.removeEventListener('goodjob:auth-state-changed', onAuth); };
  }
  listeners.forEach(listener => listener());
}
export function resetFinanceDocumentSelection(): void { selected = null; removeSessionGuard?.(); removeSessionGuard = undefined; listeners.forEach(listener => listener()); }
export function subscribeFinanceDocumentSelection(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
