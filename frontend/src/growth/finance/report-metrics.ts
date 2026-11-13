import type { FinanceDocumentInspection } from './api';

export interface ReportMetric {
  label: string; amount: number; currency: string; period: string; sourceRefs: string[];
}
const metricNames = new Set(['营业收入', '营业成本', '净利润', '经营现金净流入']);
const currencies = new Set(['CNY', 'USD', 'EUR', 'GBP', 'HKD', 'JPY']);
/** Display-only extraction from an explicit source table, never from model prose.
 * Ambiguous, cached-formula, missing-unit and conflicting entries are not charted.
 */
export function reportMetrics(value: FinanceDocumentInspection): ReportMetric[] {
  type Cell = Extract<FinanceDocumentInspection['cells'][number], {sheetName:string}>;
  const sheets = new Map<string, Cell[]>();
  for (const cell of value.cells) {
    if (!('sheetName' in cell)) continue;
    const file = value.files?.filter(file => cell.sourceRef.startsWith(file.prefix))
      .sort((a,b) => b.prefix.length-a.prefix.length)[0]?.prefix ?? value.documentId;
    const key = JSON.stringify([file,cell.sheetName]);
    sheets.set(key, [...(sheets.get(key) ?? []),cell]);
  }
  const results = new Map<string, ReportMetric | null>();
  for (const cells of sheets.values()) {
    const rows = new Map<number, Cell[]>();
    for (const cell of cells) rows.set(cell.row, [...(rows.get(cell.row) ?? []), cell]);
    let headers: Map<string, number> | undefined;
    for (const [,row] of [...rows].sort(([a],[b])=>a-b)) {
      const labels = ['指标','金额','币种','期间','单位'];
      if (labels.every(label=>row.filter(c=>c.text.trim()===label).length===1)) {
        headers = new Map(labels.map(label=>[label,row.find(c=>c.text.trim()===label)!.column]));
        continue;
      }
      if (!headers) continue;
      const selected = labels.map(label=>row.filter(c=>c.column===headers!.get(label)));
      if(selected.some(cells=>cells.length!==1 || cells[0].valueStatus==='cached_formula')) continue;
      const [label, raw, currency, period, unit] = selected.map(cells=>cells[0].text.trim());
      if (!metricNames.has(label) || !currencies.has(currency) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) continue;
      const key=JSON.stringify([currency,period,label]);
      // Do not silently select a valid row over a contradictory/missing amount.
      if (!['主币单位', ...(currency==='CNY'?['元']:[])].includes(unit)
        || !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) {results.set(key,null);continue;}
      const amount=Number(raw.replace(/,/g,''));
      if (!Number.isFinite(amount) || !Number.isSafeInteger(Math.round(amount*100))) {results.set(key,null);continue;}
      const previous=results.get(key);
      if (previous===null || (previous && previous.amount!==amount)) {results.set(key,null);continue;}
      const sourceRefs=selected.map(cells=>cells[0].sourceRef);
      results.set(key,{label,amount,currency,period,sourceRefs:[...new Set([...(previous?.sourceRefs??[]),...sourceRefs])]});
    }
  }
  return [...results.values()].filter((item):item is ReportMetric=>item!==null);
}

export const metricAmount = (metric:ReportMetric) => new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits:0,maximumFractionDigits:2,
}).format(metric.amount);
