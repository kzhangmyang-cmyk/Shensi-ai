/** Internal deterministic model, not a public DTO or a calibrated forecast. */
export interface OperatingShock {
  demand: number; procurement: number; collectionDelay: number; delivery: number;
  price?: number; fixedCost?: number; badDebtRate?: number;
  yearType?: 'good'|'normal'|'bad';
  events?: Array<OperatingEvent & {backgroundValue:number; realizedStartMonth?:number; realizedValue?:number}>;
}
export interface OperatingEvent {
  template:string; startMonth:number; durationMonths:number; value:number; probability:number; assumption:string;
  /** Optional randomization windows; omitted keeps fixed timing/severity (v1/v2 replay). */
  startMonthMax?:number; valueMin?:number; valueMax?:number;
}
export const operatingEventFactors:Readonly<Record<string,'demand'|'procurement'|'collectionDelay'|'delivery'>>={
  staffing_shortage:'delivery',staffing_recovery:'delivery',sales_gain:'demand',sales_loss:'demand',cost_rise:'procurement',cost_fall:'procurement',payment_delay:'collectionDelay',payment_recovery:'collectionDelay',
};

export function validateOperatingEvents(events:readonly OperatingEvent[],months:number):void {
  integer(events.length,0,8);
  const occupied=new Set<string>(),ids=new Set<string>();
  for(const event of events){
    const factor=Object.hasOwn(operatingEventFactors,event.template)?operatingEventFactors[event.template]:undefined;
    if(!factor||ids.has(event.template)||typeof event.assumption!=='string'||!event.assumption.trim()||event.assumption.length>500)throw new Error('invalid_operating_event');
    ids.add(event.template);integer(event.startMonth,1,months);integer(event.durationMonths,1,months-event.startMonth+1);finite(event.probability,0,1);finite(event.value,0,24);
    if(['staffing_shortage','sales_loss','cost_fall'].includes(event.template))finite(event.value,0,1);
    if(['staffing_recovery','sales_gain','cost_rise'].includes(event.template))finite(event.value,1,24);
    if(event.template==='payment_recovery'&&event.value!==0)throw new Error('invalid_operating_event_recovery');
    if(event.template==='payment_delay')integer(event.value,1,24);
    if(factor==='collectionDelay')integer(event.value,0,24);
    for(let month=event.startMonth;month<event.startMonth+event.durationMonths;month++){
      const key=`${factor}:${month}`;
      if(occupied.has(key))throw new Error('overlapping_operating_events');
      occupied.add(key);
    }
  }
}
export interface ScheduledAmount { dueMonth: number; amountMinor: number }
export interface OperatingBaseline {
  cashMinor: number; monthlyOrders: number; backlogUnits: number; capacityUnits: number;
  priceMinor: number; unitCostMinor: number; fixedCostMinor: number; collectionMonths: number;
  receivables: readonly ScheduledAmount[]; payables: readonly ScheduledAmount[];
}
export interface OperatingPlan {
  id: string; demandMultiplier: number; capacityMultiplier: number;
  priceMultiplier: number; costMultiplier: number; extraFixedCostMinor: number;
}
export interface OperatingAssumptions {
  demand: readonly number[]; procurement: readonly number[];
  collectionDelay: readonly number[]; delivery: readonly number[];
  /** Convex lag/common-component weights, NOT estimated correlation coefficients. */
  persistence: number; commonWeight: number;
}

export type YearRegime = 'normal'|'tight'|'storm';
export type SeasonalityTemplate = 'none'|'general_ecommerce'|'home_textile';
export type ExternalEnvironmentId =
  | 'tariff'|'credit_tight'|'price_war'|'fx'|'material'|'key_account_delay'|'shipping'|'weather_power'|'labor_cost';

export interface OperatingPathOptions {
  seed: number; samples: number; months: number; assumptions: OperatingAssumptions;
  events?: readonly OperatingEvent[];
  yearRegime?: YearRegime;
  seasonality?: SeasonalityTemplate;
  externalEnvironment?: readonly ExternalEnvironmentId[];
  randomizePrice?: boolean;
  randomizeFixedCost?: boolean;
  fatTailProbability?: number;
}
export interface OperatingMonth {
  month: number; orders: number; delivered: number; backlogUnits: number;
  revenueMinor: number; receiptsMinor: number; paymentsMinor: number;
  profitMinor: number; cashMinor: number; receivablesMinor: number;
  shock: OperatingShock;
}

function finite(value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error('invalid_operating_input');
}
function integer(value: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  finite(value, min, max);
  if (!Number.isSafeInteger(value)) throw new Error('invalid_operating_integer');
  return value;
}
function money(value: number): number { return integer(value, -Number.MAX_SAFE_INTEGER); }
function randomStream(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export const EXTERNAL_ENVIRONMENT_LABELS: Readonly<Record<ExternalEnvironmentId, string>> = {
  tariff: '关税上调', credit_tight: '银行不好借钱', price_war: '价格战/流量贵', fx: '汇率波动',
  material: '原材料涨价', key_account_delay: '大客户拖欠', shipping: '海运不稳',
  weather_power: '极端天气/限电', labor_cost: '用工变贵',
};

function seasonalityMultiplier(template: SeasonalityTemplate|undefined, month: number): number {
  if (!template || template === 'none') return 1;
  // month is 1..12 within a calendar-like horizon starting at Jan for templates
  const m = ((month - 1) % 12) + 1;
  if (template === 'general_ecommerce' || template === 'home_textile') {
    if (m === 1) return 0.72; // 春节淡
    if (m === 2) return 0.85;
    if (m === 6) return 1.18; // 618
    if (m === 11) return 1.28; // 双11
    if (m === 12) return 1.12;
    return 1;
  }
  return 1;
}

function applyExternalEnvironment(
  base: OperatingAssumptions,
  toggles: readonly ExternalEnvironmentId[]|undefined,
  events: OperatingEvent[],
): { assumptions: OperatingAssumptions; events: OperatingEvent[]; impacts: Array<{id:ExternalEnvironmentId;label:string;impact:string}> } {
  const a = {
    demand: [...base.demand] as [number, number],
    procurement: [...base.procurement] as [number, number],
    delivery: [...base.delivery] as [number, number],
    collectionDelay: [...base.collectionDelay] as [number, number],
    persistence: base.persistence,
    commonWeight: Math.min(1, base.commonWeight),
  };
  const impacts: Array<{id:ExternalEnvironmentId;label:string;impact:string}> = [];
  const addEvent = (event: OperatingEvent) => { if (!events.some(e => e.template === event.template)) events.push(event); };
  for (const id of toggles ?? []) {
    const label = EXTERNAL_ENVIRONMENT_LABELS[id];
    if (id === 'tariff' || id === 'material') {
      a.procurement[0] = Math.min(24, a.procurement[0] * 1.04); a.procurement[1] = Math.min(24, a.procurement[1] * 1.12);
      impacts.push({ id, label, impact: '抬高采购成本区间' });
    } else if (id === 'price_war') {
      a.demand[0] = Math.max(0, a.demand[0] * 0.9); a.demand[1] = Math.max(0, a.demand[1] * 0.97);
      impacts.push({ id, label, impact: '压低需求并增加获客成本压力' });
    } else if (id === 'fx') {
      a.procurement[1] = Math.min(24, a.procurement[1] * 1.06);
      impacts.push({ id, label, impact: '进口成本波动加大' });
    } else if (id === 'key_account_delay') {
      a.collectionDelay[1] = Math.min(24, a.collectionDelay[1] + 1);
      a.commonWeight = Math.min(1, a.commonWeight + 0.15);
      addEvent({ template: 'payment_delay', startMonth: 2, durationMonths: 2, value: 2, probability: 0.45, assumption: '大客户拖欠：回款可能再延迟', startMonthMax: 8, valueMin: 1, valueMax: 3 });
      impacts.push({ id, label, impact: '回款变慢并提高坏账风险' });
    } else if (id === 'credit_tight') {
      a.commonWeight = Math.min(1, a.commonWeight + 0.2);
      addEvent({ template: 'cost_rise', startMonth: 3, durationMonths: 2, value: 1.08, probability: 0.4, assumption: '续贷失败/利息上浮推高资金成本', startMonthMax: 9, valueMin: 1.05, valueMax: 1.15 });
      impacts.push({ id, label, impact: '融资变难，共同不利权重上升' });
    } else if (id === 'shipping') {
      a.delivery[0] = Math.max(0, a.delivery[0] * 0.92); a.procurement[1] = Math.min(24, a.procurement[1] * 1.05);
      impacts.push({ id, label, impact: '交付变慢、物流成本上升' });
    } else if (id === 'weather_power') {
      addEvent({ template: 'staffing_shortage', startMonth: 4, durationMonths: 1, value: 0.82, probability: 0.35, assumption: '极端天气/限电冲击产能', startMonthMax: 10, valueMin: 0.7, valueMax: 0.9 });
      impacts.push({ id, label, impact: '产能短时受限' });
    } else if (id === 'labor_cost') {
      a.procurement[0] = Math.min(24, a.procurement[0] * 1.02); a.procurement[1] = Math.min(24, a.procurement[1] * 1.08);
      impacts.push({ id, label, impact: '用工成本抬升' });
    }
  }
  return { assumptions: a, events, impacts };
}

function yearTypeWeights(regime: YearRegime|undefined): [number, number, number] {
  // [good, normal, bad]
  if (regime === 'storm') return [0.05, 0.25, 0.7];
  if (regime === 'tight') return [0.1, 0.4, 0.5];
  if (regime === 'normal') return [0.25, 0.5, 0.25];
  return [0.25, 0.5, 0.25];
}

function drawYearType(random: () => number, regime: YearRegime|undefined): 'good'|'normal'|'bad' {
  const [g, n] = yearTypeWeights(regime);
  const u = random();
  if (u < g) return 'good';
  if (u < g + n) return 'normal';
  return 'bad';
}

export function generateOperatingPaths(options: OperatingPathOptions): OperatingShock[][] {
  const { seed, samples, months } = options;
  integer(seed, 0, 4294967295); integer(samples, 1, 1000); integer(months, 1, 24);
  const enhanced = Boolean(options.yearRegime || (options.externalEnvironment && options.externalEnvironment.length) || options.seasonality && options.seasonality !== 'none' || options.randomizePrice || options.randomizeFixedCost || (options.fatTailProbability ?? 0) > 0 || (options.events ?? []).some(event => event.startMonthMax !== undefined || event.valueMin !== undefined));
  const prepared = applyExternalEnvironment(options.assumptions, options.externalEnvironment as ExternalEnvironmentId[]|undefined, [...(options.events ?? [])]);
  const a = prepared.assumptions;
  finite(a.persistence, 0, 1); finite(a.commonWeight, 0, 1);
  // Stronger default downside coupling when enhanced mode is on
  const commonWeight = enhanced ? Math.min(1, Math.max(a.commonWeight, options.yearRegime === 'storm' ? 0.55 : options.yearRegime === 'tight' ? 0.4 : a.commonWeight)) : a.commonWeight;
  for (const range of [a.demand, a.procurement, a.collectionDelay, a.delivery]) {
    if (range.length !== 2) throw new Error('invalid_operating_range');
    finite(range[0], 0, 24); finite(range[1], range[0], 24);
  }
  integer(a.collectionDelay[0]); integer(a.collectionDelay[1]);
  const events = prepared.events; validateOperatingEvents(events, months);
  const fatTail = Math.min(0.2, Math.max(0, options.fatTailProbability ?? (enhanced ? 0.04 : 0)));
  return Array.from({ length: samples }, (_, sample) => {
    const random = randomStream((seed + Math.imul(sample, 0x9e3779b1)) >>> 0);
    const yearType = enhanced ? drawYearType(random, options.yearRegime) : 'normal';
    const yearShift = yearType === 'good' ? -0.15 : yearType === 'bad' ? 0.25 : 0;
    // Realize events once per sample with optional randomized timing/severity
    const activeEvents = events.flatMap(event => {
      let hash = 2166136261; for (const char of event.template) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      const eventRandom = randomStream((seed ^ Math.imul(sample, 0x9e3779b1) ^ hash) >>> 0);
      if (eventRandom() >= event.probability) return [];
      let startMonth = event.startMonth;
      let value = event.value;
      if (enhanced && event.startMonthMax && event.startMonthMax >= event.startMonth) {
        const span = event.startMonthMax - event.startMonth + 1;
        startMonth = event.startMonth + Math.floor(eventRandom() * span);
        startMonth = Math.min(startMonth, months - event.durationMonths + 1);
      }
      if (enhanced && event.valueMin !== undefined && event.valueMax !== undefined && event.valueMax >= event.valueMin) {
        value = event.valueMin + (event.valueMax - event.valueMin) * eventRandom();
        if (event.template === 'payment_delay') value = Math.max(1, Math.round(value));
      }
      return [{ ...event, startMonth, value, realizedStartMonth: startMonth, realizedValue: value }];
    });
    let previous: number[] | undefined;
    return Array.from({ length: months }, (_, index) => {
      const common = Math.min(1, Math.max(0, random() + yearShift * 0.5));
      const quantiles = Array.from({ length: 4 }, (_, factor) => {
        // Correlated downside: high common → demand/delivery down (via 1-q), cost/delay up
        const independent = random();
        const coupled = factor === 0 || factor === 3
          ? commonWeight * common + (1 - commonWeight) * independent
          : commonWeight * common + (1 - commonWeight) * independent;
        const fresh = coupled;
        return previous ? a.persistence * previous[factor] + (1 - a.persistence) * fresh : fresh;
      });
      previous = quantiles;
      const interpolate = (range: readonly number[], q: number) => range[0] + (range[1] - range[0]) * q;
      let demand = interpolate(a.demand, 1 - quantiles[0]);
      let procurement = interpolate(a.procurement, quantiles[1]);
      let collectionDelay = Math.min(a.collectionDelay[1], Math.floor(a.collectionDelay[0] + (a.collectionDelay[1] - a.collectionDelay[0] + 1) * quantiles[2]));
      let delivery = interpolate(a.delivery, 1 - quantiles[3]);
      const seasonal = seasonalityMultiplier(options.seasonality, index + 1);
      demand = Math.max(0, Math.min(24, demand * seasonal));
      if (enhanced && fatTail > 0 && random() < fatTail) {
        // Small-probability crisis month
        demand *= 0.55; procurement = Math.min(24, procurement * 1.25); delivery *= 0.75;
        collectionDelay = Math.min(24, collectionDelay + 1);
      }
      const shock: OperatingShock = { demand, procurement, collectionDelay, delivery };
      if (enhanced) {
        shock.yearType = yearType;
        if (options.randomizePrice) shock.price = Math.max(0.7, Math.min(1.2, 1 + (random() - 0.5) * 0.16 + (yearType === 'bad' ? -0.04 : 0)));
        if (options.randomizeFixedCost) shock.fixedCost = Math.max(0.85, Math.min(1.3, 1 + (random() - 0.4) * 0.2 + (yearType === 'bad' ? 0.05 : 0)));
        if ((options.externalEnvironment ?? []).includes('key_account_delay') && yearType === 'bad' && random() < 0.2) shock.badDebtRate = 0.08;
      }
      if (events.length || activeEvents.length) {
        shock.events = [];
        for (const event of [...activeEvents].sort((left, right) => left.template.localeCompare(right.template))) {
          if (index + 1 < event.startMonth || index + 1 >= event.startMonth + event.durationMonths) continue;
          const factor = operatingEventFactors[event.template];
          shock.events.push({ ...event, backgroundValue: shock[factor] });
          shock[factor] = event.value as never;
        }
      }
      return shock;
    });
  });
}

export function externalEnvironmentImpacts(options: OperatingPathOptions) {
  return applyExternalEnvironment(options.assumptions, options.externalEnvironment as ExternalEnvironmentId[]|undefined, [...(options.events ?? [])]).impacts;
}

export function usesEnhancedOperatingModel(options: OperatingPathOptions): boolean {
  return Boolean(options.yearRegime || (options.externalEnvironment && options.externalEnvironment.length) || (options.seasonality && options.seasonality !== 'none') || options.randomizePrice || options.randomizeFixedCost || (options.fatTailProbability ?? 0) > 0 || (options.events ?? []).some(event => event.startMonthMax !== undefined || event.valueMin !== undefined));
}


/** Monthly accrual: new orders → delivered units → AR → due-date receipt.
 * Direct unit costs are paid on delivery; fixed costs monthly. Opening AR/AP
 * retain supplied due dates. Negative cash signals an unfunded gap, not a loan.
 */
export function simulateOperatingPlans(
  baseline: OperatingBaseline, plans: readonly OperatingPlan[], paths: readonly (readonly OperatingShock[])[],
) {
  money(baseline.cashMinor);
  for (const value of [baseline.monthlyOrders, baseline.backlogUnits, baseline.capacityUnits,
    baseline.priceMinor, baseline.unitCostMinor, baseline.fixedCostMinor]) integer(value);
  integer(baseline.collectionMonths, 0, 24);
  for (const entries of [baseline.receivables, baseline.payables]) {
    integer(entries.length, 0, 10000);
    for (const entry of entries) { integer(entry.dueMonth, 1, 48); integer(entry.amountMinor); }
  }
  integer(plans.length, 1, 10); integer(paths.length, 1, 1000);
  const ids = new Set<string>();
  for (const plan of plans) {
    if (typeof plan.id !== 'string' || !plan.id.trim() || plan.id.length > 100 || ids.has(plan.id)) throw new Error('invalid_operating_plan_id');
    ids.add(plan.id);
    for (const value of [plan.demandMultiplier, plan.capacityMultiplier, plan.priceMultiplier, plan.costMultiplier]) finite(value, 0, 10);
    integer(plan.extraFixedCostMinor);
  }
  for (const path of paths) {
    integer(path.length, 1, 24);
    if (path.length !== paths[0].length) throw new Error('inconsistent_operating_horizon');
    for (const shock of path) {
      for (const value of [shock.demand, shock.procurement, shock.delivery]) finite(value, 0, 24);
      integer(shock.collectionDelay, 0, 24);
    }
  }
  return plans.map(plan => ({
    planId: plan.id,
    modelVersion: paths.some(path=>path.some(shock=>shock.yearType!==undefined||shock.price!==undefined||shock.fixedCost!==undefined||shock.badDebtRate!==undefined))?'operating-monthly-v3-regime':paths.some(path=>path.some(shock=>shock.events!==undefined))?'operating-monthly-v2-events':'operating-monthly-v1',
    samples: paths.map(path => {
      let cash = baseline.cashMinor;
      let backlog = baseline.backlogUnits;
      let receivables = baseline.receivables.map(entry => ({ ...entry }));
      let minimumCashMinor = cash;
      let totalProfitMinor = 0;
      const months: OperatingMonth[] = path.map((shock, index) => {
        const month = index + 1;
        const orders = integer(Math.floor(baseline.monthlyOrders * plan.demandMultiplier * shock.demand));
        const capacity = integer(Math.floor(baseline.capacityUnits * plan.capacityMultiplier * shock.delivery));
        const available = integer(backlog + orders);
        const delivered = Math.min(available, capacity);
        backlog = available - delivered;
        const priceMult = shock.price ?? 1;
        const fixedMult = shock.fixedCost ?? 1;
        const revenueMinor = integer(Math.round(delivered * baseline.priceMinor * plan.priceMultiplier * priceMult));
        const directCost = integer(Math.round(delivered * baseline.unitCostMinor * plan.costMultiplier * shock.procurement));
        const operatingCost = integer(directCost + Math.round((baseline.fixedCostMinor + plan.extraFixedCostMinor) * fixedMult));
        const bookedReceivable = shock.badDebtRate ? integer(Math.round(revenueMinor * (1 - shock.badDebtRate))) : revenueMinor;
        receivables.push({ dueMonth: month + baseline.collectionMonths + shock.collectionDelay, amountMinor: bookedReceivable });
        const receiptsMinor = receivables.filter(entry => entry.dueMonth <= month).reduce((sum, entry) => integer(sum + entry.amountMinor), 0);
        receivables = receivables.filter(entry => entry.dueMonth > month);
        const openingPayments = baseline.payables.filter(entry => entry.dueMonth === month).reduce((sum, entry) => integer(sum + entry.amountMinor), 0);
        const paymentsMinor = integer(operatingCost + openingPayments);
        const profitMinor = money(revenueMinor - operatingCost);
        cash = money(cash + receiptsMinor - paymentsMinor);
        minimumCashMinor = Math.min(minimumCashMinor, cash);
        totalProfitMinor = money(totalProfitMinor + profitMinor);
        return { month, orders, delivered, backlogUnits: backlog, revenueMinor, receiptsMinor, paymentsMinor,
          profitMinor, cashMinor: cash, receivablesMinor: receivables.reduce((sum, entry) => integer(sum + entry.amountMinor), 0), shock: structuredClone(shock) };
      });
      return { months, minimumCashMinor, totalProfitMinor, fundingGapMinor: Math.max(0, -minimumCashMinor) };
    }),
  }));
}
