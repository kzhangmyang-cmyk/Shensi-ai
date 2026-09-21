# Product specialist skills

## Current implementation

六角色文字问答可显式使用与星盘共用的经营领域个人偏好：展开“经营偏好与执行复盘”，保存后点击“用于本次输入”。服务端按actor/workspace和经营领域/revision重新校验，读取不自动应用；切角色/新会话清除本次选用。现金底线不是公司财务事实，语音与获客命令不使用此偏好。该面板还可打开原星盘报告建议，使用同一人工计划/结果复盘记录；聊天本身尚无结构化建议复盘。技术共用与剩余差异见[共享能力](shared-agent-capabilities.md)。

All six roles have product-owned runtime Markdown skills, deterministic facts
and the existing authenticated single-role question path. In **智能体中心 →
和经营总管聊聊 → 本次咨询**, choose a role; the selected role's current model
route is used, with no six-model fan-out. Changing role cancels the old request
and clears its short conversation while retaining the unsent question.

| Role | Runtime skill | Implemented question methods | Required missing detail |
|---|---|---|---|
| cfo · AI 经营总管 | cfo-operating-advisor.v1 | Operating diagnosis, profit/cash difference, comparison prerequisites and priorities | Comparable budget/prior period and causal details |
| finance · 财务分析 | finance-statement-analyst.v1 | Cash reconciliation, working capital, closing balances and liquidity ratios | Average balances/period length for turnover, equity details |
| profit · 利润分析 | profit-contribution-analyst.v1 | Mapped revenue-to-net-profit bridge, margins and contribution prerequisites | Product/customer contribution and comparable price/volume/mix |
| cost · 成本分析 | cost-driver-analyst.v1 | Mapped cost/operating-expense ratios and cost-driver prerequisites | Quantities, standard/actual prices, allocation and fixed/variable split |
| cashflow · 现金流分析 | cashflow-liquidity-analyst.v1 | Cash movement bridge, profit/cash gap and planning prerequisites | Dated collections/payments, receivable due dates and available financing |
| tax · 税务健康 | tax-evidence-reviewer.v1 | Accounting tax expense, tax/accounting distinction and evidence checklist | Jurisdiction/entity/period, effective official rules, adjustments and filings |

All roles support text questions. Only CFO has realtime voice; selecting another
role hides voice controls. Existing council/report workflows are not replaced.
The first skill versions do not calculate advanced analyses without the required
detail, retrieve current tax policy or perform business writes.

## Numeric authority

The server validates and normalizes the latest authorized statement package,
calculates integer amounts and basis-point ratios, then produces one precise
display per fact. Raw Minor integers and the raw report are omitted from the
model-facing evidence. Models compose explanations using `{{fact:id}}`; the
server validates known references and substitutes the deterministic display.
Unknown references, literal numeric financial claims, and appended rescaling
units fail validation. The gateway permits one structured repair, then fails
closed rather than showing an invalid answer. The public answer stays plain text.

This prevents the reproduced “2500 yuan → 250000 yuan” substitution and protects
the tested amount/ratio renderings; it is not a proof that all prose reasoning,
chosen references or causal interpretation are correct. In particular,
percentages are not percentage-point changes, closing balances are not averages,
and a cash reconciliation does not prove complete three-statement reconciliation.
There are no computed variance/percentage-point facts without a comparable basis.
Explicit digits outside an exact company/period reference are not supported in
free-form output; use sourced references or a qualitative answer.

## Methods versus company knowledge

Skills maintain repeatable analytical methods and tested formulas. Company
knowledge holds sourced company facts with period, version and correction
history. Current six-role questions read an explicitly selected read-only CSV/XLSX, text PDF or DOCX
source or the latest verified three-statement package. They do not learn new facts
by silently saving chat or train the provider model. Future knowledge ingestion should preserve source,
scope, validity and user-confirmed corrections through the existing authorization
boundary. No new database, connector or knowledge write is part of this release.

## Uploaded material and questions

All six roles use the same explicitly selected source, with different methods.
**财务经营 → 让 AI 读取** supports partial originals, multiple regions in one sheet,
and source-cell references without ledger commit or complete statements; see
`finance-document-reading.md`. The independent source reader reuses each role's
instructions while bypassing only the verified-package fact gate; it does not
fabricate a BusinessReport. With no explicit document ID, verified facts keep
their existing deterministic preparation and role-specific selection.
In **智能体中心 → 准备财务分析**, select the balance sheet, income
statement and cash-flow statement, review the parsed preview and confirm the
import. A confirmed package is available to questions immediately; starting a
council run is not required. “Latest” means the most recently committed package
(`createdAt`, then package ID), so the answer's displayed period is authoritative
even when the last import was for an older accounting period.

| Material | Available to six-role questions |
|---|---|
| Original CSV/XLSX, text PDF or DOCX after explicit AI reading | Yes; bounded source text with spreadsheet coordinates, PDF page/item or Word paragraph/table-cell references, coverage and uncertainty; never the binary file or invented verified facts |
| File selected without AI reading | No; local inspection alone does not select question material |
| Parsed but unconfirmed three-statement preview | No; a preview is not verified company evidence |
| Confirmed three-statement package | Yes; the server derives role-specific display facts from its normalized report and includes the package/period source |
| 财务经营 expense/fact ledger import | No; these ledger rows do not create a three-statement package |
| Confirmed cash-forecast supplement | Retained in the package, but current question facts do not expose its forecast amounts or receivable rows |
| Chat history or an arbitrary document | No new verified facts or durable company knowledge |

No explicit document and no package produces `material: null` and no company facts. Explicit financial
numbers or nonexistent fact references are rejected even when supplied in chat;
Chinese amounts with units such as 块钱、人民币、美金、欧元 and 港币 are also
subject to the same reference rule.
The nonnumeric phrase “统一成本口径” is accepted without interpreting its
embedded “一成” as a percentage. Actual reductions stated as “一成” and
amounts elsewhere in the same answer still require verified references.
General explanations still depend on the configured model and are not a proof
of the company's condition. Every role checks `finance.council.run` before
reading a package or calling the model. Both question and overview projections
reject or withhold material returned from another workspace.

The closing-cash fact reads the balance-sheet cash field it cites. The cash-flow
reconstruction remains a separate reconciliation delta, including nonzero
differences within the existing one-major-unit tolerance; the tolerance does
not replace the reported balance.

## Reuse decisions (reviewed 2026-09-06)

| Reference | License / maintenance evidence | Use in this product |
|---|---|---|
| [Anthropic Finance](https://github.com/anthropics/knowledge-work-plugins/tree/main/finance) | [Apache-2.0](https://github.com/anthropics/knowledge-work-plugins/blob/main/LICENSE), unarchived; repository metadata reported a 2026-09-05 push | Reference input checks, variance explanations and source traceability. Do not inherit US GAAP/SOX assumptions, universal thresholds or unchecked multi-factor formulas. |
| [Anthropic Financial Services](https://github.com/anthropics/financial-services) | [Apache-2.0](https://github.com/anthropics/financial-services/blob/main/LICENSE), unarchived; 2026-08-25 push | Reference three-statement reconciliation methods; investment-banking workflows and paid connectors are outside scope. |
| [ERPNext](https://github.com/frappe/erpnext) | GPL-3.0, unarchived; 2026-09-05 push | Compare accounting-source architecture only; no copied GPL code or ERP runtime. |

Specific references: [variance analysis](https://github.com/anthropics/knowledge-work-plugins/blob/main/finance/skills/variance-analysis/SKILL.md),
[financial statements](https://github.com/anthropics/knowledge-work-plugins/blob/main/finance/skills/financial-statements/SKILL.md),
[three-statement model](https://github.com/anthropics/financial-services/blob/main/plugins/vertical-plugins/financial-analysis/skills/3-statement-model/SKILL.md).
Activity is not correctness evidence. Methods and product-specific instructions
are written for Shensi; no third-party source code or book chapters are copied.
Additional connectors would require separate permission, data-destination and
maintenance review.

Chinese management-accounting reference: [财政部正式发布通知，财会〔2017〕24号](https://kjs.mof.gov.cn/zhengcefabu/201710/t20171018_2727363.htm)
(2017-09-29; page 2017-10-19), with budget, cost, operations, performance and
management-report methods. This is not a current tax-rate source, and the 2016
consultation draft is not substituted for the final notice. Do not package
commercially restricted textbook content as freely licensed skill material.

## Scenario acceptance

Shared fixture: `backend/test/financial-skill-fixture.ts`, synthetic 示例公司,
2026-Q2, CNY minor units. Expected income 10000 yuan; net profit 2500 yuan;
operating cash -1000 yuan; closing cash 9000 yuan; cash/profit gap -3500 yuan;
gross/net margins 40%/25%, current ratio 4, quick ratio 3.6667.

Automated tests cover exact amounts/source fields, all six skills in the real
gateway request, role routing, conflicts/missing data, zero denominators,
negative/zero amounts, ratio/percent units, unknown references, literal yuan/wan
errors, bounded repair and rejection. Model outputs in unit tests are fixtures.
The in-memory repository-to-question test checks every role before upload,
after preview, after confirmed import and from another workspace. It verifies
distinct exact facts, absence of raw file/report fields in model evidence and
rejection of unsourced amounts. This does not certify a live model response.

Explicit finite live evaluation uses only these synthetic statements and the
authorized account's normally configured model credentials:
`cd backend && node --import tsx test/financial-skills-live-eval.mjs --live-synthetic-only <account> [role ...]`.
It opens a read-only transaction for scoped model metadata/encrypted versions,
uses the normal gateway in memory, and never imports statements or persists
business/ledger data. It is not part of default tests. Current measured results
and remaining acceptance limits are in `docs/PROJECT_STATUS.md`.

Skills are copied next to compiled Backend modules by
`backend/scripts/copy-cfo-skill.mjs`; `pnpm --dir backend build` includes all six.
Focused gate: `pnpm --dir backend test:cfo-conversation`. Live explanations still
need review for role fit, correct source, unsupported attribution and data gaps.
