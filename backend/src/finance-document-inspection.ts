import { parseSecureSpreadsheetArtifact, type ParsedSpreadsheetCell } from './secure-spreadsheet-artifact.js';
import type { FinanceTextCell } from './secure-finance-document-text.js';

export type FinanceDocumentRegionKind = 'balance_sheet' | 'income_statement' | 'cash_flow_statement' | 'ledger' | 'unknown';
export interface FinanceSpreadsheetCell { sourceRef: string; sheetName: string; row: number; column: number; text: string;
  valueStatus?: 'original' | 'cached_formula' }
export type FinanceDocumentCell = FinanceSpreadsheetCell | FinanceTextCell;
export interface FinanceDocumentRegion { regionId: string; sheetName: string; kind: FinanceDocumentRegionKind;
  startRow: number; endRow: number; headerRow: number | null; sourceRefs: string[]; uncertain: string[] }
export interface FinanceDocumentObservation { text: string; sourceRefs: string[] }
export interface FinanceDocumentInspection {
  files?: Array<{ fileName: string; fileHash: string; prefix: string }>;
  fileHash: string; classification: 'financial_statements' | 'ledger' | 'unknown';
  regions: FinanceDocumentRegion[]; cells: FinanceDocumentCell[];
  missingStatements: Array<'balance_sheet' | 'income_statement' | 'cash_flow_statement'>;
  uncertain: string[]; observations: FinanceDocumentObservation[];
  modelStatus: 'not_requested' | 'consent_required' | 'completed' | 'unavailable' | 'invalid_output';
}
const STATEMENTS = ['balance_sheet', 'income_statement', 'cash_flow_statement'] as const;
const LIMITS = { maxBytes: 5 * 1024 * 1024, maxSheets: 10, maxRows: 5000, maxColumns: 100, maxCellLength: 20000 };
function coordinate(cell: ParsedSpreadsheetCell, name: 'sourceRow' | 'sourceColumn', fallback: number): number {
  const value = name in cell ? (cell as unknown as Record<string, unknown>)[name] : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
const normalized = (text: string) => text.replace(/[\s：:]/gu, '').toLowerCase();
function titleKind(text: string): FinanceDocumentRegionKind | null {
  const title = normalized(text);
  if (/^(?:合并)?资产负债表$/.test(title)) return 'balance_sheet';
  if (/^(?:合并)?(?:利润表|损益表)$/.test(title)) return 'income_statement';
  if (/^(?:合并)?现金流量表$/.test(title)) return 'cash_flow_statement';
  return null;
}
function headerKind(rows: ParsedSpreadsheetCell[][], index: number): FinanceDocumentRegionKind | null {
  const labels = rows[index].filter(cell => cell.formula === null).map(cell => normalized(cell.text));
  if (labels.some(text => text === '资产') && labels.some(text => /期末余额/.test(text))) return 'balance_sheet';
  const subjectColumn = rows[index].findIndex(cell => cell.formula === null && normalized(cell.text) === '项目');
  // Only account names under the subject column establish the statement kind.
  // Free-form remarks anywhere in the row are not classification evidence.
  const subjects = rows.slice(index + 1, index + 8).map(row => row[subjectColumn])
    .filter((cell): cell is ParsedSpreadsheetCell => !!cell && cell.formula === null)
    .map(cell => normalized(cell.text.replace(/\s/gu, '')
      .replace(/^[一二三四五六七八九十\d]+[、.．]/u, '')
      .replace(/^减[：:]/u, '')));
  if (labels.includes('项目') && labels.some(text => /本年累计金额|本期金额|本月金额/.test(text))) {
    const income = subjects.includes('营业收入') && subjects.includes('营业成本');
    const cash = subjects.some(text => /^(?:(?:经营|投资|筹资)活动(?:产生的)?现金流(?:入|出)(?:小计)?|(?:经营|投资|筹资)活动产生的现金流量净额|(?:期初|期末)现金及现金等价物余额)$/u.test(text));
    if (income && !cash) return 'income_statement';
    if (cash && !income) return 'cash_flow_statement';
  }
  if (labels.some(text => /^(?:日期|业务日期|businessoccurredat)$/.test(text))
    && labels.some(text => /^(?:金额|借方金额|贷方金额|amount)$/.test(text))) return 'ledger';
  return null;
}

/** Read-only source inspection: no normalization, currency inference or ledger writes. */
export function inspectFinanceDocument(input: { content: Buffer; mediaType: string }): FinanceDocumentInspection & { cells: FinanceSpreadsheetCell[] } {
  const artifact = parseSecureSpreadsheetArtifact({ ...input, limits: LIMITS });
  const uncertain = new Set<string>(['currency_not_verified', 'period_not_verified', 'unit_not_verified']);
  const cells: FinanceSpreadsheetCell[] = []; const regions: FinanceDocumentRegion[] = [];
  artifact.sheets.forEach((sheet, sheetIndex) => {
    sheet.rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
      const cachedFormula = cell.formula !== null;
      if (cachedFormula) {
        if (!('hasCachedValue' in cell) || cell.hasCachedValue !== true || !cell.text.trim()) {
          uncertain.add('formula_value_unknown'); return;
        }
        uncertain.add('formula_cache_unverified');
      }
      if (!cell.text.trim()) return;
      if (cell.text.length > 500) { uncertain.add('cell_text_omitted'); return; }
      if (cells.length >= 2000) { uncertain.add('inspection_truncated'); return; }
      const sourceRow = coordinate(cell, 'sourceRow', rowIndex + 1);
      const sourceColumn = coordinate(cell, 'sourceColumn', columnIndex + 1);
      cells.push({ sourceRef: `cell:${sheetIndex + 1}:${sourceRow}:${sourceColumn}`, sheetName: sheet.name,
        row: sourceRow, column: sourceColumn, text: cell.text, ...(cachedFormula ? { valueStatus: 'cached_formula' as const } : {}) });
    }));
    const markers: Array<{ index: number; kind: FinanceDocumentRegionKind; header: number | null }> = [];
    for (let index = 0; index < sheet.rows.length; index++) {
      const row = sheet.rows[index];
      const title = row.map(cell => cell.formula === null ? titleKind(cell.text) : null).find(kind => kind !== null);
      const header = headerKind(sheet.rows, index);
      const kind = title ?? header;
      if (!kind) continue;
      const previous = markers.at(-1);
      if (header && previous?.kind === kind && previous.header === null && index - previous.index <= 4) {
        previous.header = index; continue;
      }
      markers.push({ index, kind, header: header ? index : null });
    }
    if (markers.length === 0 && sheet.rows.length) markers.push({ index: 0, kind: 'unknown', header: null });
    markers.forEach((marker, index) => {
      if (regions.length >= 200) { uncertain.add('inspection_truncated'); return; }
      const startRow = coordinate(sheet.rows[marker.index][0], 'sourceRow', marker.index + 1);
      const next = markers[index + 1];
      const endIndex = next ? next.index - 1 : sheet.rows.length - 1;
      const endRow = coordinate(sheet.rows[endIndex][0], 'sourceRow', endIndex + 1);
      const headerRow = marker.header === null ? null : coordinate(sheet.rows[marker.header][0], 'sourceRow', marker.header + 1);
      const regionUncertain: string[] = [];
      if (marker.kind === 'unknown') regionUncertain.push('region_kind_unknown');
      if (headerRow === null) regionUncertain.push('header_not_verified');
      regions.push({ regionId: `region:${sheetIndex + 1}:${startRow}`, sheetName: sheet.name, kind: marker.kind,
        startRow, endRow, headerRow,
        sourceRefs: cells.filter(cell => cell.sourceRef.startsWith(`cell:${sheetIndex + 1}:`)
          && (cell.row === startRow || cell.row === headerRow)).map(cell => cell.sourceRef), uncertain: regionUncertain });
    });
  });
  const kinds = new Set(regions.map(region => region.kind));
  if (kinds.has('unknown') || regions.length === 0) uncertain.add('document_regions_unverified');
  const classification = STATEMENTS.some(kind => kinds.has(kind)) ? 'financial_statements' : kinds.has('ledger') ? 'ledger' : 'unknown';
  return { fileHash: artifact.fileHash, classification, regions, cells,
    missingStatements: STATEMENTS.filter(kind => !kinds.has(kind)), uncertain: [...uncertain], observations: [], modelStatus: 'not_requested' };
}
