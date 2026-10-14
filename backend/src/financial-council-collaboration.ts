import { financialCouncilCanonicalHash, immutableFinancialCouncilValue } from "./financial-council-domain.js";
import type { FinancialCouncilRun, FinancialCouncilRunEvent } from "./financial-council-domain.js";
import type { FinancialSnapshot } from "./financial-council-snapshot.js";
import type { FinancialCouncilCollaborationEvent } from "./financial-council-collaboration-record.js";
import type { FinancialCouncilAnalysisGap, FinancialCouncilAnalysisControl,
  FinancialCouncilSpecialistResult, FinancialCouncilRebuttalAttempt,
  FinancialCouncilFindingDisposition } from "./financial-council-repository.js";
import type { FinancialCouncilAuditGraph } from "./financial-council-audit.js";
import type { ConsensusReport, FinancialCouncilFinding } from "./growth-contract-types.js";
import { createFinancialCouncilReportPresentation } from "./financial-council-report-presentation.js";

const ROLES = ["cfo", "finance", "profit", "cost", "cashflow", "tax"] as const;
const LABELS = { cfo: "经营总管", finance: "财务分析", profit: "利润分析",
  cost: "成本分析", cashflow: "现金流分析", tax: "税务健康" } as const;
const CLOSED = new Set(["awaiting_approval", "approved", "rejected", "stale", "expired", "failed", "not_computable"]);
type RoleState = FinancialCouncilCollaborationEvent["state"] | "waiting";
type ReportItem = { label: string; value: string; evidenceRefs: readonly string[] };
type ReportSection = { id: string; title: string; paragraphs: readonly string[]; items: readonly ReportItem[] };

export interface FinancialCouncilCollaborationInput {
  readonly run: FinancialCouncilRun;
  readonly snapshot: FinancialSnapshot;
  readonly events: readonly FinancialCouncilCollaborationEvent[];
  readonly runEvents: readonly FinancialCouncilRunEvent[];
  readonly results: readonly FinancialCouncilSpecialistResult[];
  readonly gaps: readonly FinancialCouncilAnalysisGap[];
  readonly attempts: readonly FinancialCouncilRebuttalAttempt[];
  readonly dispositions: readonly FinancialCouncilFindingDisposition[];
  readonly graph: FinancialCouncilAuditGraph | null;
  readonly consensus: ConsensusReport | null;
  readonly control: FinancialCouncilAnalysisControl | null;
  readonly now: string;
}

function evidence(finding: FinancialCouncilFinding): string[] {
  return [finding.findingId, ...finding.evidenceRefs.map(ref =>
    `${ref.source}:${ref.sourceId}@${ref.contentHash}`),
  ...(finding.formulaRef ? [formulaReference(finding)] : [])];
}

function formulaReference(finding: FinancialCouncilFinding): string {
  const formula = finding.formulaRef!;
  return `formula:${formula.formulaVersion}:${formula.inputHash}:${formula.resultHash}`;
}

export function projectFinancialCouncilCollaboration(input: FinancialCouncilCollaborationInput) {
  const { run, snapshot } = input;
  const narrative = [...input.events].reverse().find(event => event.role === "cfo"
    && event.narrative !== null)?.narrative ?? null;
  const finalReason = input.runEvents.at(-1)?.reasonCode ?? null;
  const leaseLive = input.control?.lease !== null && input.control?.lease !== undefined
    && Date.parse(input.control.lease.leaseExpiresAt) > Date.parse(input.now);
  const roles = ROLES.map(role => {
    const event = [...input.events].reverse().find(row => row.role === role);
    const result = input.results.find(row => row.role === role && row.phase === "analyze");
    const gap = input.gaps.find(row => row.role === role);
    let state: RoleState = event?.state ?? (result ? "completed" : gap ? "missing_data" : "waiting");
    let message = event?.message ?? (result ? "已保存专业分析；历史过程记录不完整。"
      : gap ? "该角色缺少必要资料或当前不可用。" : "等待前序步骤完成。");
    let reasonCode = event?.reasonCode ?? gap?.code ?? null;
    if (role === "cfo" && !narrative && input.consensus) {
      state = "degraded"; reasonCode = "historical_narrative_unavailable";
      message = "已有确定性汇总；历史记录未保存模型汇总状态。";
    } else if (state === "running" && (CLOSED.has(run.status) || !leaseLive)) {
      state = CLOSED.has(run.status) ? "failed" : "degraded";
      reasonCode = finalReason ?? "worker_interrupted";
      message = CLOSED.has(run.status) ? "本次运行已停止，该阶段未完成。" : "上次执行已中断，等待工作进程恢复。";
    } else if (state === "waiting" && CLOSED.has(run.status)) {
      message = "本次运行已结束，此角色没有执行记录。";
    }
    if (role === "cashflow" && !result && snapshot.formulaInputs.cashflow.status === "not_computable") {
      state = "missing_data"; reasonCode = snapshot.formulaInputs.cashflow.reason;
      message = "缺少本次已确认的现金流及预测输入，暂不可计算。";
    }
    return { role, state, phase: event?.phase ?? (role === "cfo" ? "synthesis" as const : "analysis" as const),
      updatedAt: event?.occurredAt ?? result?.createdAt ?? gap?.createdAt ?? null,
      message, reasonCode, findings: result?.findings ?? [], actions: result?.actions ?? [] };
  });
  const reviews = input.attempts.map(attempt => {
    const edge = input.graph?.edges.find(row => row.edgeId === attempt.edgeId);
    const disposition = input.dispositions.find(row => row.findingId === attempt.targetFindingId);
    const state = attempt.status === "completed" && disposition?.status !== "unresolved"
      ? disposition?.status ?? "pending" : "pending";
    const original = input.results.filter(result => result.phase === "analyze")
      .flatMap(result => result.findings).find(finding => finding.findingId === attempt.targetFindingId);
    const output = attempt.result?.value;
    const summary = [original ? `原始分析：${original.conclusion}` : "",
      output?.explanation ?? "复核已登记，尚无已保存结论。",
      output?.replacement ? `修订意见：${output.replacement.conclusion}` : "",
      ...(output?.replacement?.assumptions ?? []).map(value => `修订假设：${value}`),
      ...[...(output?.evidenceRefs ?? []), ...(output?.replacement?.evidenceRefs ?? [])]
        .map(ref => `复核依据：${ref}`)].filter(Boolean).join("\n");
    return { role: attempt.role, round: 1 as const, findingId: attempt.targetFindingId,
      peerFindingId: edge?.findingIds.find(id => id !== attempt.targetFindingId) ?? "",
      state, summary,
      occurredAt: attempt.completedAt ?? attempt.createdAt };
  });
  // Only explicitly public business fields leave this projection. Provider bindings,
  // raw prompts, reservation inputs and private model reasoning remain internal.
  const events = input.events.map(({ eventId, role, phase, state, occurredAt, message, reasonCode, findingIds }) =>
    ({ eventId, role, phase, state, occurredAt, message, reasonCode, findingIds }));
  const complete = !!input.consensus && run.portfolios.length > 0
    && CLOSED.has(run.status) && run.status !== "failed" && run.status !== "not_computable";
  const generatedAt = [run.updatedAt, ...events.map(row => row.occurredAt),
    ...input.results.map(row => row.createdAt), ...reviews.map(row => row.occurredAt)]
    .sort().at(-1)!;
  const sections: ReportSection[] = [];
  const presentation = createFinancialCouncilReportPresentation();
  const { reference, code, text, shorten: prose } = presentation;
  const item = (label: string, value: string, evidenceRefs: readonly string[] = []): ReportItem =>
    ({ label, value, evidenceRefs: [...new Set(evidenceRefs.map(reference))] });
  const section = (id: string, title: string, paragraphs: string[], items: ReportItem[] = []) =>
    sections.push({ id, title, paragraphs, items });
  const findings = input.results.filter(result => result.phase === "analyze").flatMap(result => result.findings);
  const byId = new Map(findings.map(finding => [finding.findingId, finding]));
  const allActions = new Map(input.results.flatMap(result => result.actions)
    .concat(run.portfolios.flatMap(portfolio => portfolio.actions)).map(action => [action.actionId, action]));
  const findingTitle = (finding: FinancialCouncilFinding) => `${LABELS[finding.agentRole]} · ${finding.formulaRef
    ? code(finding.formulaRef.formulaVersion, "其他计算议题") : "专业判断"}`;
  const sourceIds = snapshot.sourceRefs.map(ref => {
    const hash = ref.kind === "financial_statement_package" ? ref.snapshotHash : ref.contentHash;
    const version = ref.kind === "financial_statement_package" ? ref.sourceVersion : ref.version;
    const id = `${ref.kind}:${ref.sourceId}@${hash}`;
    presentation.define(id, code(ref.kind), `来源 ${ref.sourceId}；版本 ${version}；内容 ${hash}`);
    return id;
  });
  const metricSources = sourceIds.filter((_, index) => ["business_report", "financial_statement_package"]
    .includes(snapshot.sourceRefs[index]!.kind));
  presentation.define(run.statementPackageId, "报表资料包");
  presentation.define(snapshot.snapshotId, "冻结快照", `${snapshot.snapshotId}；内容 ${snapshot.snapshotHash}`);
  presentation.define(run.policyVersionId, "本轮策略版本");
  for (const finding of findings) {
    presentation.define(finding.findingId, findingTitle(finding));
    for (const ref of finding.evidenceRefs) {
      const id = `${ref.source}:${ref.sourceId}@${ref.contentHash}`;
      const alias = `evidence:${financialCouncilCanonicalHash({ snapshotId: snapshot.snapshotId,
        snapshotHash: snapshot.snapshotHash, ref })}`;
      presentation.define(id, code(ref.source), `${ref.sourceId}；内容 ${ref.contentHash}；证据编号 ${alias}`, [alias]);
    }
    if (finding.formulaRef) presentation.define(formulaReference(finding), `${findingTitle(finding)}计算依据`);
  }
  for (const action of allActions.values()) presentation.define(action.actionId, code(action.kind));
  for (const portfolio of run.portfolios) presentation.define(portfolio.portfolioId, "方案记录");
  const gapById = new Map([...snapshot.dataGaps, ...findings.flatMap(finding => finding.missingData)]
    .map(gap => [`gap:${financialCouncilCanonicalHash({ snapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash, gap })}`, gap]));
  for (const [id, gap] of gapById) presentation.define(id, "判断假设所依赖的资料缺口", `${id}；${gap.description}`);
  const assumption = (value: string) => gapById.has(value) ? `${text(gapById.get(value)!.description)} ${reference(value)}`
    : value.startsWith("gap:") ? `假设所引用的资料说明缺失 ${reference(value)}` : prose(value);
  const reportReview = (review: typeof reviews[number]) => {
    const original = byId.get(review.findingId);
    const output = input.attempts.find(attempt => attempt.targetFindingId === review.findingId)?.result?.value;
    return [original ? `原始分析：${text(original.conclusion)}` : "",
      output ? prose(output.explanation) : "复核已登记，尚无已保存结论。",
      output?.replacement ? `修订意见：${prose(output.replacement.conclusion)}` : "",
      ...(output?.replacement?.assumptions ?? []).map(value => `修订假设：${assumption(value)}`),
      ...[...(output?.evidenceRefs ?? []), ...(output?.replacement?.evidenceRefs ?? [])]
        .map(ref => `复核依据：${reference(ref)}`)].filter(Boolean).join("\n");
  };
  const money = (value: number) => Number.isSafeInteger(value)
    ? new Intl.NumberFormat("zh-CN", { style: "currency", currency: run.currency,
      currencyDisplay: "code" }).format(value / 100) : "暂不可计算";
  const percent = (value: number, denominatorPresent: boolean) => denominatorPresent && Number.isFinite(value)
    ? `${(value / 100).toFixed(2)}%` : "暂不可计算（分母资料不足）";
  const diagnosis = narrative?.overallDiagnosis ?? input.consensus?.overallDiagnosis
    ?? (CLOSED.has(run.status) ? "本次运行未生成完整汇总，请查看缺失资料和执行结果。" : "汇总尚未完成，以下仅为已保存的阶段结果。");
  section("executive-summary", "一、经营摘要与决策优先级", [prose(diagnosis),
    complete ? "本报告已包含分析、复核与建议组合，所有建议等待人工判断。" : "阶段报告尚不完整，不代表六角色均已完成。",
    narrative?.narrativeStatus === "model_valid" ? "总管汇总已通过证据引用校验。"
      : narrative ? `总管模型汇总降级（${code(narrative.narrativeStatus)}），当前保留确定性审计结果。`
        : "总管模型汇总状态尚无可恢复记录。"],
  (narrative?.priorityFindingIds ?? []).flatMap((id, index) => {
    const finding = byId.get(id);
    const revised = reviews.find(review => review.findingId === id && review.state === "revised");
    return finding ? [item(`优先关注 ${index + 1} · ${findingTitle(finding)}${revised ? " · 有修订意见" : ""}`,
      revised ? reportReview(revised) : text(finding.conclusion), evidence(finding))] : [];
  }));
  section("sources", "二、资料、期间与计算口径", [
    `企业：${snapshot.report.companyName}；期间：${snapshot.report.period}；币种：${run.currency}。`,
    "本次六角色使用同一冻结快照；报表原值和服务端确定性计算构成数字依据。"], [
    item("数据截至", run.dataAsOf), item("报表资料包", "本次分析使用的资料包", [run.statementPackageId]),
    item("快照版本", "同一冻结快照，完整版本与校验值见附录", [snapshot.snapshotId]),
    item("策略版本", "本次运行已冻结的策略", [run.policyVersionId]),
    ...snapshot.sourceRefs.map((ref, index) => item(code(ref.kind), "已纳入本次冻结资料", [sourceIds[index]!]))
  ]);
  const metrics = snapshot.formulaInputs.indicators;
  section("metrics", "三、确定性指标与趋势", ["金额以报表币种显示；百分比由服务端计算。未提供可比期间时，不生成同比或环比趋势。"], [
    item("营业收入", money(metrics.revenueMinor), metricSources), item("净利润", money(metrics.netProfitMinor), metricSources),
    item("毛利率", percent(metrics.grossMarginBps, metrics.revenueMinor !== 0), metricSources),
    item("净利率", percent(metrics.netMarginBps, metrics.revenueMinor !== 0), metricSources),
    item("资产负债率", percent(metrics.debtRatioBps, snapshot.report.totalAssetsMinor !== 0), metricSources),
    item("现金流预测", snapshot.formulaInputs.cashflow.status === "computed"
      ? `未来 30 天净额 ${money(snapshot.formulaInputs.cashflow.next30DaysNetMinor)}；未来 90 天净额 ${money(snapshot.formulaInputs.cashflow.next90DaysNetMinor)}`
      : "暂不可计算（缺少现金流输入）", metricSources), item("期间趋势", "未提供本次快照可验证的可比期间趋势。")
  ]);
  section("specialists", "四、五位专业角色的结论与证据", ["此处保留原始专业分析；修订、撤回及保留意见见交叉复核章节，不将未经重新计算的复核草稿当作新的财务事实。"], roles.filter(role => role.role !== "cfo").flatMap(role => [
    item(`${LABELS[role.role]} · ${code(role.state)}`, prose(role.message)),
    ...role.findings.flatMap(finding => [item(findingTitle(finding),
      `${text(finding.conclusion)}\n关注程度：${code(finding.severity)}；记录置信度 ${(finding.confidenceBps / 100).toFixed(2)}%。`, evidence(finding)),
      item("判断假设", finding.assumptions.length ? finding.assumptions.map(assumption).join("；") : "未记录额外判断假设。", [finding.findingId]),
      ...finding.missingData.map(gap => item("缺失资料", text(gap.description), [finding.findingId])),
      ...finding.candidateActionIds.flatMap(id => {
        const action = allActions.get(id);
        return action ? [item(`关联建议情景估算 · ${code(action.kind)}`,
          `现金影响：保守 ${money(action.cashImpact.conservative)} / 基准 ${money(action.cashImpact.base)} / 乐观 ${money(action.cashImpact.optimistic)}；利润影响：保守 ${money(action.profitImpact.conservative)} / 基准 ${money(action.profitImpact.base)} / 乐观 ${money(action.profitImpact.optimistic)}。这是该项建议的估算，不是已实现收益。`, [id, finding.findingId])] : [];
      }),
      ...(finding.candidateActionIds.length ? [] : [item("影响估算", "未记录关联行动的金额影响估算，不能据此视为零。", [finding.findingId])])])
  ]));
  section("review", "五、交叉复核、修订与保留分歧", [
    "专业分析顺序执行；规则审计发现冲突后仅进行有界的一轮定向复核。没有发起复核的角色不显示虚构讨论。",
    ...(narrative?.riskNotes ?? []).map(prose)
  ], [
    ...reviews.map(review => item(`${LABELS[review.role]} · ${code(review.state)}`, reportReview(review),
      [review.findingId, review.peerFindingId].filter(Boolean))),
    ...(input.consensus?.unresolvedConflicts ?? []).map(conflict => item("未解决分歧", code(conflict.type), conflict.findingIds)),
    ...(input.consensus?.minorityFindings ?? []).map(finding => item(`保留意见 · ${findingTitle(finding)}`, text(finding.conclusion), evidence(finding))),
    ...(input.consensus?.rejectedFindings ?? []).map(finding => item(`未采纳意见 · ${findingTitle(finding)}`, text(finding.conclusion), evidence(finding))),
    ...(reviews.length === 0 ? [item("复核记录", input.graph ? "没有已登记的定向复核。" : "审计尚未完成。")] : [])
  ]);
  const portfolioLabels = { balanced: "均衡方案", cash_first: "现金优先", growth_first: "增长优先" };
  section("options", "六、备选方案与风险比较", ["以下为基于当前策略和假设的情景估算，不是已实现收益，也不自动执行。"],
    run.portfolios.flatMap(portfolio => [
      item(portfolioLabels[portfolio.kind], `现金影响：保守 ${money(portfolio.scenarioForecast.cashImpact.conservative)} / 基准 ${money(portfolio.scenarioForecast.cashImpact.base)} / 乐观 ${money(portfolio.scenarioForecast.cashImpact.optimistic)}；利润影响基准 ${money(portfolio.scenarioForecast.profitImpact.base)}`, [portfolio.portfolioId]),
      ...portfolio.hardConstraints.map(constraint => item(`${portfolioLabels[portfolio.kind]} · ${code(constraint.code)}`,
        `${constraint.satisfied ? "满足" : "不满足"}${constraint.reason ? `：${text(constraint.reason)}` : ""}`)),
      ...portfolio.rejectedActions.map(action => item(`${portfolioLabels[portfolio.kind]} · 未选建议${allActions.has(action.actionId)
        ? ` · ${code(allActions.get(action.actionId)!.kind)}` : ""}`, text(action.reason), [action.actionId]))
    ]));
  const suggestions = [...new Map(run.portfolios.flatMap(portfolio => portfolio.actions)
    .map(action => [action.actionId, action])).values()];
  section("actions", "七、建议行动与人工确认", ["此处为建议清单，不创建财务分录、不付款、不报税、不对外联系。修改和执行需另行人工确认。"],
    suggestions.map((action, index) => item(`建议 ${index + 1} · ${LABELS[action.ownerRole]} · ${code(action.kind)}`,
      `${action.explanation === `${action.kind}_hypothesis` ? text(action.explanation) : prose(action.explanation)}${action.subjectRef ? `；对象：${action.subjectRef}` : ""}；建议周期 ${action.durationDays} 天；前提：${action.prerequisites.map(value => value.startsWith("formula:")
        ? `核对本项计算依据 ${reference(value)}` : allActions.has(value) ? `先完成关联建议 ${reference(value)}` : prose(value)).join("、") || "未记录具体前提，需负责人补充确认"}；预算 ${money(action.budgetCostMinor)}。`,
      [action.actionId, ...action.sourceFindingIds])));
  section("appendix", "八、缺失资料、公式与版本附录", [
    `运行 ${run.runId} · 修订 ${run.revision} · 状态 ${code(run.status)}。`,
    "正文使用短编号引用，下列索引保留完整来源、编号、公式版本和校验值。协作过程仅包含公开业务结论与证据。"
  ], [
    ...snapshot.dataGaps.map(gap => item(code(gap.code), text(gap.description))),
    ...roles.filter(role => ["missing_data", "failed", "degraded", "waiting"].includes(role.state))
      .map(role => item(LABELS[role.role], role.message)),
    ...events.map(event => item(`${event.occurredAt} · ${event.role ? LABELS[event.role] : "规则审计"}`,
      `${code(event.phase)} / ${code(event.state)}：${prose(event.message)}`, event.findingIds))
  ]);
  sections[sections.length - 1]!.items = [...sections.at(-1)!.items, ...presentation.appendix()];
  const reportBody = { version: "financial-council-report.v1" as const,
    title: `${snapshot.report.companyName} · ${snapshot.report.period} 经营分析报告`,
    complete, generatedAt, sections };
  return immutableFinancialCouncilValue({ runId: run.runId, workspaceId: run.workspaceId,
    revision: run.revision, dataAsOf: run.dataAsOf, currency: run.currency,
    statementPackageId: run.statementPackageId, snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash, policyVersionId: run.policyVersionId,
    executionMode: "sequential" as const, reviewRoundLimit: 1 as const,
    roles, events, reviews, narrative,
    report: { reportId: financialCouncilCanonicalHash({ runId: run.runId,
      snapshotHash: snapshot.snapshotHash, revision: run.revision, ...reportBody }), ...reportBody } });
}
