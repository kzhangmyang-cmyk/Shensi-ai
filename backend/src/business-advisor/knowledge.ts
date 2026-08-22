export interface KnowledgeEntry {
  readonly category: string;
  readonly title: string;
  readonly content: string;
}

export interface AgentKnowledgeBase {
  readonly agentId: string;
  readonly entries: readonly KnowledgeEntry[];
}

const STANDARD_ENTRIES: Record<string, readonly KnowledgeEntry[]> = {
  finance: Object.freeze([
    Object.freeze({
      category: "指标体系",
      title: "核心财务指标口径",
      content:
        "毛利率=毛利/收入；净利率=净利润/收入；ROE=净利润/净资产；ROA=净利润/总资产；资产负债率=总负债/总资产；流动比率=流动资产/流动负债；速动比率=(流动资产-存货)/流动负债；应收账款周转率=收入/应收账款；存货周转率=营业成本/存货；利息保障倍数=(净利润+所得税+利息)/利息；应收周转天数=应收账款/收入×365；现金保障月数=期末现金/月均毛利。"
    }),
    Object.freeze({
      category: "解读原则",
      title: "三张报表联动看问题",
      content:
        "收入增长但经营现金下降，优先核查应收账款与存货占用；利润改善但现金恶化，警惕赊销扩张；负债上升要看是否投向经营性资产。收现比=经营现金流入/收入，净现比=经营净现金流/净利润，两者长期低于1说明利润没有变成现金。"
    }),
    Object.freeze({
      category: "勾稽核查",
      title: "报表勾稽关系检查",
      content:
        "实务中常见问题：各表之间未建立勾稽关系、明细与总计对不上、同一科目核算口径不统一（如预算差异表的实际支出与现金流量表的现金流出不一致）、大量手工复制粘贴造成数据错位。检查顺序：先验资产负债平衡，再验利润与现金流的联动，最后核对明细与汇总。"
    }),
    Object.freeze({
      category: "勾稽核查",
      title: "理论现金流勾稽法",
      content:
        "用 净利润+折旧摊销调整±营运资金变动 倒推理论货币资金变动，与账面实际货币资金减少对比；若存在无法解释的资金缺口，可能隐藏账外账或核算错误，需重点核查。例：净利-1363万+折旧-20万+应收增加-517万≈-1900万，实际货币资金减少1758万，缺口142万无法解释。"
    })
  ]),
  profit: Object.freeze([
    Object.freeze({
      category: "管理会计",
      title: "真实利润口径",
      content:
        "真实利润=收入-直接成本-售后成本-运输成本-销售费用-分摊管理成本。毛利好看不等于真赚钱；扣除后仍低于警戒线的产品称为假利润。"
    }),
    Object.freeze({
      category: "客户分析",
      title: "客户 ABC 分类",
      content:
        "A 类：真实利润率≥20%且回款≤60天；B 类：真实利润率≥0且回款≤90天；C 类：负利润或拖款超90天。大客户不等于好客户，要按真实贡献排序。白酒零售案例：重点会员复购率仅40.97%，未复购客户60%因缺乏有效跟进而丢失，新客转化率从78.64%降至60%，客户质量下滑要先看跟进机制。"
    }),
    Object.freeze({
      category: "对标分析",
      title: "费用对标法",
      content:
        "选择同行业可比公司（如酒类流通对标华致酒行），分销售费用/管理费用逐科目对比费用率：薪酬费用比=职工薪酬/收入、每元薪酬创收=收入/职工薪酬、日常经营办公费占比。对比后落到差异最大的科目找原因。案例：薪酬费用比5.93% vs 对标3.05%，每元薪酬创收16.85元 vs 32.75元，办公费占比2.66% vs 0.34%。"
    })
  ]),
  cost: Object.freeze([
    Object.freeze({
      category: "成本结构",
      title: "固定/变动/半变动成本",
      content:
        "固定成本：人工、租金、折旧；变动成本：原材料、直接计件；半变动成本：销售提成。材料成本率异常波动需核查涨价、采购异常与产品结构变化。"
    }),
    Object.freeze({
      category: "差异分析",
      title: "价差与量差分离",
      content:
        "成本率上升不能只报现象，要拆成价差（采购单价变化）与量差（用量/损耗/结构变化）。考核口径要统一：经营毛利率用实际成本率、营销考核用年初标准成本，两者差异本身就要解释，不能只报送数据不做分析。"
    }),
    Object.freeze({
      category: "异常识别",
      title: "异常科目背后找管理问题",
      content:
        "预算内科目也可能藏浪费：如制造费用中“运费”“其他”异常高，表面没超预算，实际反映闲置库存返修、排产混乱、产品定位问题。异常识别要看科目明细与业务动因，而不是只看是否超预算。"
    })
  ]),
  cashflow: Object.freeze([
    Object.freeze({
      category: "资金管理",
      title: "利润增长现金断裂风险",
      content:
        "当收入增长但应收账款增速明显更快时，利润表好看但现金会被占用。未来30/90天现金预测为负即触发资金断裂预警，需优先压缩应收与库存。"
    }),
    Object.freeze({
      category: "资金管理",
      title: "资金全链条复盘",
      content:
        "按 收款-付款-借款-余额 全链条复盘：个人卡收款/公款私存、先付款后补流程、出纳未日清月结、资金日报与银行余额不一致、大量未达账项、银行账户过多资金分散、员工借款长期不清理。任一环节失控都直接影响资金安全与税务合规。"
    }),
    Object.freeze({
      category: "资金管理",
      title: "回款与现金质量",
      content:
        "收现比与净现比是检验利润质量的硬指标：收入增长但收现比下降，说明赊销扩张占用资金；净利润为正但净现比长期低于1，警惕“有利润没现金”。应收超过90天即进入拖款高风险区间，需逐客户催收并收紧账期。"
    })
  ]),
  tax: Object.freeze([
    Object.freeze({
      category: "合规边界",
      title: "税务健康检查边界",
      content:
        "本智能体只做风险体检（发票、收入确认、成本真实性、个税、股权），输出红黄绿分级；不做避税方案，所有结论需由执业税务师复核。"
    }),
    Object.freeze({
      category: "高频风险",
      title: "民企高频税务风险场景",
      content:
        "实务高频：个人卡收款/公款私存导致三流不一致（资金流、发票流、合同流）、未按规定取得发票、往来长期挂账被视同隐匿收入或分红、账实不符被认定虚增成本或隐匿收入、员工借款超一年未还视同分红缴20%个税、未按权责发生制核算。"
    })
  ]),
  cfo: Object.freeze([
    Object.freeze({
      category: "咨询框架",
      title: "经营诊断报告结构",
      content:
        "报告=企业健康评分+三大问题(问题→证据→风险→建议)+未来90天行动计划。行动按月度展开：先清理低利润客户/产品，再调报价与成本，最后做资金与预算安排。"
    }),
    Object.freeze({
      category: "咨询框架",
      title: "业务条线检查框架",
      content:
        "按 采购-销售-授权审批-资金-存货-资产-财务规范-税务 八条业务线逐项体检。每个问题遵循四段式：现象（查到什么）→证据（访谈/查账/系统记录）→风险（法律/财务/管理）→建议（制度规范+流程优化+岗位分工）。"
    }),
    Object.freeze({
      category: "咨询框架",
      title: "风险三分类",
      content:
        "风险统一按 法律风险（涉税处罚、诉讼、刑事责任）、财务风险（资金占用、坏账、成本虚增）、管理风险（职责不清、舞弊空间、效率损失）三分类输出，并给出红/黄/绿分级，帮助老板按优先级决策。"
    })
  ])
};

export function standardAgentKnowledgeBase(
  agentId: string
): AgentKnowledgeBase {
  return Object.freeze({
    agentId,
    entries: Object.freeze([
      ...(STANDARD_ENTRIES[agentId] ?? [])
    ])
  });
}

export function allStandardAgentKnowledgeBases(): readonly AgentKnowledgeBase[] {
  return Object.freeze(
    Object.keys(STANDARD_ENTRIES).map((agentId) =>
      standardAgentKnowledgeBase(agentId))
  );
}

/** 外部资料注入点：把课程方法论、行业基准、脱敏报表样本等按 agentId 追加。 */
export function extendAgentKnowledgeBase(
  base: AgentKnowledgeBase,
  extra: readonly KnowledgeEntry[]
): AgentKnowledgeBase {
  return Object.freeze({
    agentId: base.agentId,
    entries: Object.freeze([
      ...base.entries,
      ...extra.map((entry) => Object.freeze({ ...entry }))
    ])
  });
}
