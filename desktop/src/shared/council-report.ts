export const COUNCIL_REPORT_CHANNEL = 'shensi:council-report:export-pdf';
export interface CouncilReportRequest { html: string; filename: string }
export type CouncilReportResult = { status: 'saved'; fileName: string } | { status: 'cancelled' };
export interface CouncilReportBridge { exportPdf(request: CouncilReportRequest): Promise<CouncilReportResult> }

const tags = new Set('html head body title meta style h1 h2 h3 h4 h5 h6 p div span section article header footer main nav a table thead tbody tfoot tr th td ul ol li dl dt dd strong em b i br hr pre code'.split(' '));
const attributes = new Set('lang charset class id colspan rowspan scope style aria-label'.split(' '));
/** Admit only the static, escaped-text report vocabulary, never arbitrary pages. */
export function validateCouncilReportRequest(raw: unknown): CouncilReportRequest {
  const invalid = () => { throw new Error('council_report_invalid_request'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'filename,html' || typeof value.html !== 'string'
    || !value.html.trim() || value.html.length > 2_000_000 || typeof value.filename !== 'string'
    || !value.filename.trim() || value.filename.length > 180) return invalid();
  const html = value.html;
  if (!/<head\s*>/i.test(html) || !/<body(?:\s|>)/i.test(html) || /\u0000/.test(html)) return invalid();
  const pieces = html.split(/(<[^>]*>)/g);
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index];
    if (index % 2 === 0) { if (piece.includes('<')) return invalid(); continue; }
    if (/^<!doctype html>$/i.test(piece)) continue;
    const match = /^<(\/)?([a-z][a-z0-9]*)([^>]*)>$/i.exec(piece);
    if (!match || !tags.has(match[2].toLowerCase())) return invalid();
    let rest = match[3];
    if (match[1]) { if (rest.trim()) return invalid(); continue; }
    if (rest.endsWith('/')) rest = rest.slice(0, -1);
    while (rest.trim()) {
      const attr = /^\s+([a-z][a-z0-9-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/i.exec(rest);
      if (!attr) return invalid();
      if (attr[1].toLowerCase() === 'href') {
        if (match[2].toLowerCase() !== 'a' || !/^#council-report-section-\d+$/.test(attr[2] ?? attr[3])) return invalid();
      } else if (!attributes.has(attr[1].toLowerCase())) return invalid();
      if (match[2].toLowerCase() === 'meta' && (attr[1].toLowerCase() !== 'charset'
        || (attr[2] ?? attr[3]).toLowerCase() !== 'utf-8')) return invalid();
      rest = rest.slice(attr[0].length);
    }
  }
  const stem = value.filename.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '').replace(/\.pdf$/i, '').trim();
  return { html, filename: `${stem.slice(0, 176) || 'financial-council-report'}.pdf` };
}
