import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { renderReportBody, renderReportHtml } from "./report";
import type { FinancialCouncilDetailedReport } from "../contracts";

const report: FinancialCouncilDetailedReport = {
  reportId: "report-v7", version: "financial-council-report.v1", title: "经营 <script>alert(1)</script>",
  complete: true, generatedAt: "2026-09-10T00:00:00Z",
  sections: [{ id: "summary", title: "一、经营摘要", paragraphs: ["现金 < 100 & 利润 > 0", "应收变化见[依据1]"],
    items: [{ label: "应收", value: "CNY 1,234.56", evidenceRefs: ["source<&>"] }] }]
};
const html = renderReportHtml(report);
const { document } = parseHTML(html);
assert.equal(document.querySelectorAll("script,img,iframe").length, 0);
assert.equal(document.querySelector("title")?.textContent, report.title);
assert.match(document.body.textContent ?? "", /report-v7/);
assert.match(document.body.textContent ?? "", /CNY 1,234.56/);
assert.ok(html.includes(renderReportBody(report)), "export and screen must share exact versioned report body");
assert.match(html, /现金 &lt; 100 &amp; 利润 &gt; 0/);
assert.equal(document.querySelector('nav a')?.getAttribute('href'), '#council-report-section-0');
assert.equal(document.querySelector('header .council-report-identity') !== null, false,
  'technical identity must not interrupt the report introduction');
assert.equal(document.querySelector('article > footer')?.textContent?.trim(),
  '报告版本：financial-council-report.v1 · 完整报告编号：report-v7');
assert.equal(document.querySelector('article')?.lastElementChild?.tagName, 'FOOTER');
assert.equal(document.querySelector('section h3')?.textContent, '一、经营摘要',
  'section headings must preserve backend numbering without adding a second number');
assert.ok(document.querySelector('section')?.textContent?.includes('应收变化见[依据1]'));
