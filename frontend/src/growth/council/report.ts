import type { FinancialCouncilDetailedReport } from "../contracts";

declare global {
  interface Window {
    shensiCouncilReport?: {
      exportPdf(input: { html: string; filename: string }): Promise<{ status: "saved" | "cancelled"; fileName?: string }>;
    };
  }
}

export function escapeReportHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

/** Both the screen and downloads render this exact immutable DTO, never a second read. */
export function renderReportBody(report: FinancialCouncilDetailedReport): string {
  const e = escapeReportHtml;
  return `<article class="council-detailed-report"><header><h2>${e(report.title)}</h2>
    <p>${report.complete ? "完整报告" : "阶段报告 · 分析尚未全部完成"} · ${e(report.generatedAt)}</p></header>
    <nav aria-label="报告目录"><h3>目录</h3><ol>${report.sections.map((s, index) => `<li><a href="#council-report-section-${index}">${e(s.title)}</a></li>`).join("")}</ol></nav>
    ${report.sections.map((s, index) => `<section id="council-report-section-${index}"><h3>${e(s.title)}</h3>
      ${s.paragraphs.map(p => `<p>${e(p)}</p>`).join("")}
      <dl>${s.items.map(item => `<div><dt>${e(item.label)}</dt><dd>${e(item.value)}${item.evidenceRefs.length
        ? `<p class="council-report-evidence">依据：${item.evidenceRefs.map(e).join("、")}</p>` : ""}</dd></div>`).join("")}</dl></section>`).join("")}
    <footer><p class="council-report-identity">报告版本：${e(report.version)} · 完整报告编号：${e(report.reportId)}</p></footer></article>`;
}

export function renderReportHtml(report: FinancialCouncilDetailedReport): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeReportHtml(report.title)}</title>
    <style>body{font-family:system-ui,sans-serif;color:#18251f;background:#fff;margin:36px;line-height:1.65;font-size:12px}h2{font-size:24px}h3{font-size:17px;margin-top:26px}p,dd,dt{overflow-wrap:anywhere;white-space:pre-wrap}dd{margin:0 0 12px}dt{font-weight:600}section{break-inside:auto}h3,dt{break-after:avoid}nav ol{columns:2}.council-report-identity,.council-report-evidence{color:#526259;font-size:10px}@page{size:A4;margin:16mm}@media print{body{margin:0}}</style>
    </head><body>${renderReportBody(report)}</body></html>`;
}
