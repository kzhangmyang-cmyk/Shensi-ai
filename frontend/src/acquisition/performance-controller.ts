import {
  AcquisitionPerformanceApiError,
  createAcquisitionPerformanceApi,
  type AcquisitionPerformanceDto,
  type AcquisitionPerformanceFilters
} from "./performance-api";
import {
  renderAcquisitionPerformance,
  type AcquisitionPerformanceViewState
} from "./performance-view";

type PerformanceApi = ReturnType<typeof createAcquisitionPerformanceApi>;
type PerformanceStatus = AcquisitionPerformanceViewState["status"];

let started = false;

function calendarDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(Number.NaN);
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === value
    ? date
    : new Date(Number.NaN);
}

function dateValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function performanceFiltersFromDates(
  fromValue: string,
  toValue: string,
  platformValue: string
): AcquisitionPerformanceFilters {
  const to = calendarDay(toValue);
  let from = calendarDay(fromValue);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) {
    throw new Error("请选择有效的时间范围");
  }
  if (from.getTime() > to.getTime()) throw new Error("开始日期不能晚于结束日期");
  const earliest = new Date(to.getTime() - (89 * 24 * 60 * 60 * 1000));
  if (from.getTime() < earliest.getTime()) from = earliest;
  const platform = platformValue === "douyin" || platformValue === "web"
    ? platformValue
    : undefined;
  return { platform, from: dateValue(from), to: dateValue(to) };
}

export function isUnauthorizedPerformanceError(error: unknown) {
  return error instanceof AcquisitionPerformanceApiError
    && error.status === 401;
}

export interface PerformanceGenerationToken {
  readonly version: number;
  readonly signature: string;
  readonly signal: AbortSignal;
}

export function createPerformanceGenerationGuard() {
  let version = 0;
  let active: { token: PerformanceGenerationToken; abort: AbortController }
    | null = null;
  return {
    begin(filters: AcquisitionPerformanceFilters, mode: string) {
      active?.abort.abort();
      const abort = new AbortController();
      const token: PerformanceGenerationToken = {
        version: ++version,
        signature: JSON.stringify({ mode, filters }),
        signal: abort.signal
      };
      active = { token, abort };
      return token;
    },
    invalidate() {
      version += 1;
      active?.abort.abort();
      active = null;
    },
    isCurrent(token: PerformanceGenerationToken) {
      return active?.token === token
        && token.version === version
        && !token.signal.aborted;
    }
  };
}

export function performanceStatusFor(counts: { discovered: number }): PerformanceStatus {
  return counts.discovered === 0 ? "empty" : "ready";
}

export function defaultPerformanceDateValues(now: Date) {
  const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  const to = new Date(Date.UTC(
    shanghaiNow.getUTCFullYear(),
    shanghaiNow.getUTCMonth(),
    shanghaiNow.getUTCDate()
  ));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: dateValue(from), to: dateValue(to) };
}

export function startAcquisitionPerformance(
  api: PerformanceApi = createAcquisitionPerformanceApi(),
  now: () => Date = () => new Date()
) {
  if (started || typeof document === "undefined") return;
  const section = document.querySelector<HTMLElement>("#replicaAcquisitionPerformance");
  const body = document.querySelector<HTMLElement>("#replicaAcquisitionPerformanceBody");
  const fromInput = document.querySelector<HTMLInputElement>("#replicaPerformanceFrom");
  const toInput = document.querySelector<HTMLInputElement>("#replicaPerformanceTo");
  const platformInput = document.querySelector<HTMLSelectElement>("#replicaPerformancePlatform");
  const refreshButton = document.querySelector<HTMLButtonElement>("#replicaPerformanceRefresh");
  if (!section || !body || !fromInput || !toInput || !platformInput || !refreshButton) return;
  started = true;

  const defaults = defaultPerformanceDateValues(now());
  fromInput.value ||= defaults.from;
  toInput.value ||= defaults.to;
  let realMode = document.querySelector("[data-acquisition-mode=\"real\"].active") !== null;
  let requestVersion = 0;
  const aiGeneration = createPerformanceGenerationGuard();
  let state: AcquisitionPerformanceViewState = {
    status: "loading",
    data: null,
    aiInterpretation: null,
    aiStatus: "idle"
  };

  const render = () => {
    body.innerHTML = renderAcquisitionPerformance(state);
  };

  const setSummaryCards = (data: AcquisitionPerformanceDto | null) => {
    const values = data
      ? [data.counts.discovered, data.counts.highIntent, data.counts.converted, data.counts.won]
      : ["—", "—", "—", "—"];
    const labels = ["发现候选", "高意向", "转入 CRM", "成交"];
    labels.forEach((label, index) => {
      const labelElement = document.querySelector<HTMLElement>(`#replicaMetricLabel${index}`);
      const valueElement = document.querySelector<HTMLElement>(`#replicaMetricValue${index}`);
      const unitElement = document.querySelector<HTMLElement>(`#replicaMetricUnit${index}`);
      const changeElement = document.querySelector<HTMLElement>(`#replicaMetricChange${index}`);
      if (labelElement) labelElement.textContent = label;
      if (valueElement) valueElement.textContent = String(values[index]);
      if (unitElement) unitElement.textContent = index === 3 ? "个合同" : "个候选";
      if (changeElement) changeElement.textContent = data ? "真实时间范围聚合" : "等待真实接口";
    });
  };

  const currentFilters = () => performanceFiltersFromDates(
    fromInput.value,
    toInput.value,
    platformInput.value
  );

  const load = async () => {
    if (!realMode) return;
    aiGeneration.invalidate();
    const version = ++requestVersion;
    state = { status: "loading", data: null, aiInterpretation: null, aiStatus: "idle" };
    setSummaryCards(null);
    render();
    refreshButton.disabled = true;
    try {
      const data = await api.getPerformance(currentFilters());
      if (version !== requestVersion || !realMode) return;
      state = {
        status: performanceStatusFor(data.counts),
        data,
        aiInterpretation: null,
        aiStatus: "idle"
      };
      setSummaryCards(data);
    } catch (error) {
      if (version !== requestVersion || !realMode) return;
      state = {
        status: isUnauthorizedPerformanceError(error) ? "unauthorized" : "error",
        data: null,
        error: error instanceof Error ? error.message : "真实经营接口不可用",
        aiInterpretation: null,
        aiStatus: "idle"
      };
      setSummaryCards(null);
    } finally {
      if (version === requestVersion) {
        refreshButton.disabled = false;
        render();
      }
    }
  };

  refreshButton.addEventListener("click", () => void load());
  platformInput.addEventListener("change", () => void load());
  fromInput.addEventListener("change", () => void load());
  toInput.addEventListener("change", () => void load());
  body.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-performance-action=\"generate\"]"
    );
    if (!button || !state.data || state.aiStatus === "loading") return;
    const filters = currentFilters();
    const generation = aiGeneration.begin(filters, "real");
    state = { ...state, aiStatus: "loading", aiError: undefined };
    render();
    void api.generateBriefing(filters, {
      signal: generation.signal
    }).then((interpretation) => {
      if (!realMode || !aiGeneration.isCurrent(generation)) return;
      state = { ...state, aiStatus: "ready", aiInterpretation: interpretation };
      render();
    }).catch((error) => {
      if (!realMode || !aiGeneration.isCurrent(generation)) return;
      state = {
        ...state,
        aiStatus: "error",
        aiError: error instanceof Error ? error.message : "模型调用失败"
      };
      render();
    });
  });

  document.addEventListener("goodjob:acquisition-mode-changed", (event) => {
    const detail = (event as CustomEvent<{ mode?: string; phase?: string }>).detail;
    realMode = detail?.mode === "real";
    section.hidden = !realMode;
    if (!realMode) {
      requestVersion += 1;
      aiGeneration.invalidate();
      return;
    }
    void load();
  });

  section.hidden = !realMode;
  if (realMode) void load();
}
