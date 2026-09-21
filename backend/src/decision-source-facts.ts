import type { FinanceDocumentCell } from './finance-document-inspection.js';
const fields = [
  ['cashMinor','期初现金',['期初现金'],'元',100],
  ['monthlyOrders','每月订单',['月订单','每月订单'],'件',1],
  ['backlogUnits','期初积压',['期初积压'],'件',1],
  ['capacityUnits','每月产能',['月产能','每月产能','每月交付产能'],'件',1],
  ['priceMinor','销售单价',['销售单价'],'元',100],
  ['unitCostMinor','单位直接成本',['单位直接成本'],'元',100],
  ['fixedCostMinor','每月固定费用',['每月固定费用','月固定费用'],'元',100],
  ['collectionMonths','基础回款周期',['基础回款周期','回款周期'],'月',1],
] as const;
export interface DecisionFact {
  field: typeof fields[number][0]; label: string; status: 'missing'|'candidate'|'conflict';
  candidates: Array<{ value: number; sourceRefs: string[] }>;
}
/** Conservative table-label proposals. An absent candidate is not zero and never blocks reading prose. */
export function proposeDecisionFacts(cells: FinanceDocumentCell[]): DecisionFact[] {
  const rows = new Map<string, FinanceDocumentCell[]>();
  for (const cell of cells) {
    if (!('sheetName' in cell) && !('table' in cell)) continue;
    const key = cell.sourceRef.slice(0,cell.sourceRef.lastIndexOf(':'));
    rows.set(key,[...(rows.get(key)??[]),cell]);
  }
  return fields.map(([field,label,aliases,unit,multiplier])=>{
    const candidates: DecisionFact['candidates'] = [];
    for (const row of rows.values()) {
      const heading=row.find(cell=>aliases.some(alias=>cell.text.trim()===alias || cell.text.replace(/\s/g,'')===`${alias}（${unit}）` || cell.text.replace(/\s/g,'')===`${alias}(${unit})`));
      if (!heading) continue;
      const unitCell=row.find(cell=>cell.text.trim()===unit);
      if (!unitCell && !heading.text.includes(`（${unit}）`) && !heading.text.includes(`(${unit})`)) continue;
      const values=row.filter(cell=>cell!==heading && cell!==unitCell && /^-?\d+(?:\.\d{1,2})?$/.test(cell.text.trim()));
      // Multiple periods/columns need a person to choose the baseline period.
      if(values.length!==1) continue;
      const raw=Number(values[0].text);const value=Math.round(raw*multiplier);
      if(!Number.isSafeInteger(value) || (multiplier===1&&!Number.isInteger(raw)) || (field!=='cashMinor'&&value<0)) continue;
      candidates.push({value,sourceRefs:[heading.sourceRef,values[0].sourceRef,...(unitCell?[unitCell.sourceRef]:[])]});
    }
    return {field,label,status:!candidates.length?'missing':new Set(candidates.map(item=>item.value)).size>1?'conflict':'candidate',candidates};
  });
}
