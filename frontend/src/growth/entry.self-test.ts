import { strict as assert } from "node:assert";
import { growthRouteMeta, renderQuoteCaseSelectionRequired } from "./entry";

assert.deepEqual(growthRouteMeta({ name: "advisor" }), {
  title: "增长顾问",
  subtitle: "今日经营建议与待办优先级"
});
assert.deepEqual(growthRouteMeta({ name: "catalog" }), {
  title: "客户目录",
  subtitle: "统一查看客户、线索与经营资料"
});
assert.deepEqual(growthRouteMeta({ name: "quote" }), {
  title: "报价工作台",
  subtitle: "基于客户需求生成、审批与追踪报价"
});
assert.deepEqual(growthRouteMeta({ name: "finance" }), {
  title: "财务经营",
  subtitle: "查看经营数据、归因与财务进度"
});
assert.deepEqual(growthRouteMeta({ name: "roi" }), {
  title: "ROI 经营分析",
  subtitle: "评估投入产出与增长效率"
});
assert.deepEqual(growthRouteMeta({ name: "financial-council" }), {
  title: "财务委员会",
  subtitle: "真实三表 · 六角色审计 · 人工审批"
});
assert.match(renderQuoteCaseSelectionRequired(), /请选择报价案例/u);
assert.match(renderQuoteCaseSelectionRequired(), /#growth\/catalog/u);
assert.doesNotMatch(renderQuoteCaseSelectionRequired(), /quote_case_required/u);
