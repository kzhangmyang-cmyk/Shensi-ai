export type CfoAcquisitionProgressStage =
  | "draft"
  | "run_started"
  | "candidate_review"
  | "crm_handoff"
  | "deal_created";

export interface CfoAcquisitionProgress {
  version: 1;
  scope: string;
  prompt: string;
  stage: CfoAcquisitionProgressStage;
  planId: string | null;
  runId: string | null;
  runStatus: string | null;
  candidateId: string | null;
  customerId: string | null;
  todoId: string | null;
  dealId: string | null;
  updatedAt: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY_PREFIX = "shensi:cfo-acquisition-progress:v1:";

function text(value: unknown, maximum = 255): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : null;
}

function key(scope: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(scope)}`;
}

function valid(value: unknown, scope: string): value is CfoAcquisitionProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.version === 1
    && row.scope === scope
    && typeof row.prompt === "string"
    && row.prompt.length <= 2_000
    && ["draft", "run_started", "candidate_review", "crm_handoff", "deal_created"]
      .includes(String(row.stage))
    && typeof row.updatedAt === "string"
    && Number.isFinite(Date.parse(row.updatedAt));
}

export function loadCfoAcquisitionProgress(
  storage: StorageLike | null | undefined,
  scope: string | null | undefined
): CfoAcquisitionProgress | null {
  if (!storage || !scope?.trim()) return null;
  try {
    const raw = storage.getItem(key(scope.trim()));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed, scope.trim()) ? Object.freeze(parsed) : null;
  } catch {
    return null;
  }
}

export function saveCfoAcquisitionProgress(
  storage: StorageLike | null | undefined,
  value: CfoAcquisitionProgress
): CfoAcquisitionProgress | null {
  if (!storage || !valid(value, value.scope)) return null;
  const frozen = Object.freeze({ ...value });
  try {
    storage.setItem(key(value.scope), JSON.stringify(frozen));
    return frozen;
  } catch {
    return null;
  }
}

function scopeFrom(documentRef: Document): string | null {
  const workspace = text(documentRef.body.dataset.sessionWorkspaceId);
  const user = text(documentRef.body.dataset.sessionUserId);
  return workspace && user ? `${workspace}:${user}` : null;
}

function storageFrom(documentRef: Document): StorageLike | null {
  try {
    return documentRef.defaultView?.localStorage ?? null;
  } catch {
    return null;
  }
}

function notify(documentRef: Document, progress: CfoAcquisitionProgress): void {
  documentRef.dispatchEvent(new documentRef.defaultView!.CustomEvent(
    "goodjob:cfo-acquisition-progress-changed",
    { detail: progress }
  ));
}

export function recordCfoAcquisitionDraft(
  documentRef: Document,
  prompt: string,
  now = () => new Date().toISOString()
): CfoAcquisitionProgress | null {
  const scope = scopeFrom(documentRef);
  const normalizedPrompt = text(prompt, 2_000);
  if (!scope || !normalizedPrompt) return null;
  const progress = saveCfoAcquisitionProgress(storageFrom(documentRef), {
    version: 1,
    scope,
    prompt: normalizedPrompt,
    stage: "draft",
    planId: null,
    runId: null,
    runStatus: null,
    candidateId: null,
    customerId: null,
    todoId: null,
    dealId: null,
    updatedAt: now()
  });
  if (progress) notify(documentRef, progress);
  return progress;
}

export function startCfoAcquisitionProgressTracking(
  documentRef: Document,
  now = () => new Date().toISOString()
): { dispose(): void } {
  const update = (
    transform: (current: CfoAcquisitionProgress, detail: Record<string, unknown>) => CfoAcquisitionProgress | null,
    event: Event
  ) => {
    const scope = scopeFrom(documentRef);
    const storage = storageFrom(documentRef);
    const current = loadCfoAcquisitionProgress(storage, scope);
    if (!current) return;
    const detail = (event as CustomEvent<Record<string, unknown>>).detail ?? {};
    const next = transform(current, detail);
    if (!next) return;
    const saved = saveCfoAcquisitionProgress(storage, {
      ...next,
      updatedAt: now()
    });
    if (saved) notify(documentRef, saved);
  };
  const onStarted = (event: Event) => update((current, detail) => {
    const planId = text(detail.planId);
    const runId = text(detail.runId);
    if (!planId || !runId) return null;
    return {
      ...current,
      stage: "run_started",
      planId,
      runId,
      runStatus: text(detail.runStatus) ?? "queued"
    };
  }, event);
  const onCandidate = (event: Event) => update((current, detail) => {
    const planId = text(detail.planId);
    if (!planId || current.planId !== planId) return null;
    const handoff = detail.action === "private_domain_handoff_completed";
    return {
      ...current,
      stage: handoff ? "crm_handoff" : "candidate_review",
      candidateId: text(detail.candidateId) ?? current.candidateId,
      customerId: text(detail.customerId) ?? current.customerId,
      todoId: text(detail.todoId) ?? current.todoId
    };
  }, event);
  const onDeal = (event: Event) => update((current, detail) => {
    if (current.stage !== "crm_handoff") return null;
    const customerId = text(detail.customerId);
    const dealId = text(detail.dealId);
    if (!customerId || customerId !== current.customerId || !dealId) return null;
    return { ...current, stage: "deal_created", dealId };
  }, event);
  documentRef.addEventListener("goodjob:cfo-acquisition-workflow-started", onStarted);
  documentRef.addEventListener("goodjob:acquisition-candidate-changed", onCandidate);
  documentRef.addEventListener("goodjob:acquisition-deal-created", onDeal);
  return {
    dispose() {
      documentRef.removeEventListener("goodjob:cfo-acquisition-workflow-started", onStarted);
      documentRef.removeEventListener("goodjob:acquisition-candidate-changed", onCandidate);
      documentRef.removeEventListener("goodjob:acquisition-deal-created", onDeal);
    }
  };
}

