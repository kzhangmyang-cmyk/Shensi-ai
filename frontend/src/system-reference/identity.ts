export const referenceConnectionChanged = 'shensi:reference-connection-changed';
export function referenceIdentity(document: Document, identity: () => string | null) {
  return JSON.stringify([identity(), document.body.dataset.sessionMode, document.body.dataset.sessionUserId, document.body.dataset.sessionWorkspaceId]);
}
/** Memory-only invalidation. No credentials, excerpts or identity are persisted. */
export function observeReferenceIdentity(document: Document, identity: () => string | null, invalidate: () => void, central = false) {
  const initial = referenceIdentity(document, identity);
  const changed = () => { if (referenceIdentity(document, identity) !== initial) invalidate(); };
  const observer = document.defaultView?.MutationObserver ? new document.defaultView.MutationObserver(changed) : null;
  observer?.observe(document.body, {attributes:true,attributeFilter:['data-session-mode','data-session-user-id','data-session-workspace-id']});
  document.addEventListener('goodjob:auth-state-changed', invalidate);
  if (central) document.addEventListener(referenceConnectionChanged, invalidate);
  return () => { observer?.disconnect(); document.removeEventListener('goodjob:auth-state-changed', invalidate); document.removeEventListener(referenceConnectionChanged, invalidate); };
}
export function notifyReferenceConnectionChange(document: Document) {
  const event=document.createEvent('Event');event.initEvent(referenceConnectionChanged,false,false);document.dispatchEvent(event);
}
