from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Iterable, Sequence

from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "docs" / "product"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

FONT = "Arial Unicode MS"
NAVY = "1F4E78"
BLUE = "2E74B5"
DARK_BLUE = "1F4D78"
LIGHT_BLUE = "E8EEF5"
LIGHTER_BLUE = "F5F8FC"
GOLD = "B8860B"
PALE_GOLD = "FFF2CC"
GREEN = "E2F0D9"
GRAY = "666666"
LIGHT_GRAY = "F2F4F7"
WHITE = "FFFFFF"
BLACK = "202020"
TABLE_WIDTH_DXA = 9360
TABLE_INDENT_DXA = 120


@dataclass(frozen=True)
class WorkItem:
    id: str
    milestone: str
    title: str
    decision_owner: str
    engineering_owner: str
    deliverable: str
    acceptance: str
    dependency: str = "无"


ITEMS: list[WorkItem] = [
    # M0 collaboration and platform foundations
    WorkItem("COL-001", "M0", "统一Git远程与分支规范", "共同", "主责", "GitHub作为origin、Gitee作为upstream；main仅接收PR。", "双方按同一分支命名和拉取流程操作；不直接向main提交。"),
    WorkItem("COL-002", "M0", "Codex协作规则", "共同", "主责", "AGENTS.md明确Codex可建分支、开发、测试和发草稿PR，但不得自行合并。", "两边Codex读取规则后能复述权限、禁区、测试和交付格式。"),
    WorkItem("COL-003", "M0", "Issue与PR模板", "共同", "主责", "建立任务范围、依赖、验收、风险、测试结果和人工审核模板。", "任一新功能均可由模板生成可独立领取的任务。"),
    WorkItem("COL-004", "M0", "工程忽略与密钥治理", "协作", "主责", "补齐.gitignore、环境变量模板、密钥扫描与默认账号安全说明。", "node_modules、dist、.env和本地数据不会进入提交；仓库无真实密钥。"),
    WorkItem("COL-005", "M0", "热点文件模块化", "协作", "主责", "逐步拆分frontend/src/prototype-api.ts与backend/src/server.ts的获客、CRM、AI和财务职责。", "新增功能可在独立模块完成；两条轨道不再频繁修改同一巨型文件。"),
    WorkItem("COL-006", "M0", "持续集成与质量门", "定义业务验收样例", "主责", "构建、后端测试、前端测试和关键E2E进入CI。", "草稿PR显示构建与测试结果；失败不得标记可审核。"),
    WorkItem("COL-007", "M0", "领域词典与ID体系", "主责", "协作", "统一Lead、Account、Opportunity、BattleCard、FinancialValue等定义和任务编号。", "产品文档、Schema、API、页面和Issue使用同一术语。"),
    WorkItem("COL-008", "M0", "黄金样例数据集", "主责", "提供载入工具", "建立强意向、弱意向、负向、比价、长账期和高毛利等标准样例。", "每个智能体和财务规则均可用固定样例回归验证。"),
    WorkItem("COL-009", "M0", "AI结构化输出契约", "主责", "协作", "定义ICP、LeadScore、BattleCard、PricingAdvice、FinancialValue和Forecast JSON Schema。", "Schema含版本、证据、置信度、错误状态；前后端均可校验。"),
    WorkItem("COL-010", "M0", "AI调用网关与审计", "定义模型策略", "主责", "统一模型适配、重试、超时、成本、Prompt版本和调用日志。", "模型失败有可观察错误与规则兜底；敏感数据不进入无授权模型。"),

    # M1 lead intelligence
    WorkItem("ACQ-001", "M1", "ICP客户画像配置", "主责", "主责页面与存储", "定义行业、地区、产品、客单价、目标角色、排除对象和关键词规则。", "可保存多个ICP版本并用于搜索、评分和作战卡。", "COL-007/COL-009"),
    WorkItem("ACQ-002", "M1", "搜索任务规划智能体", "主责", "实现任务服务", "根据ICP生成关键词、渠道、地区、优先级和停止条件。", "同一ICP可生成可解释、可编辑、可重跑的搜索计划。", "ACQ-001"),
    WorkItem("ACQ-003", "M1", "多数据源线索发现", "定义来源策略", "主责", "接入搜索API、企业数据源、官网、地图、招聘、招投标和手工导入。", "每条线索保留来源、时间、原文和采集方式；来源失败彼此隔离。", "ACQ-002"),
    WorkItem("ACQ-004", "M1", "Excel与链接导入", "定义字段映射", "主责", "支持批量Excel、单条链接和手工线索进入统一处理流程。", "导入结果显示成功、重复、失败及原因；可重复执行。"),
    WorkItem("ACQ-005", "M1", "AI线索清洗与标准化", "主责", "实现服务与持久化", "提取企业、行业、地区、联系人、联系方式、需求摘要和来源证据。", "输出符合统一Lead Schema；低置信度字段明确标注。", "ACQ-003/ACQ-004"),
    WorkItem("ACQ-006", "M1", "跨来源去重与合并", "定义合并规则", "主责", "按域名、企业名、联系方式和人工映射合并同一客户。", "合并不丢失原始证据；支持拆分和查看合并历史。", "ACQ-005"),
    WorkItem("ACQ-007", "M1", "真实意向评分", "主责", "实现评分服务与页面", "按需求明确度、ICP匹配、购买阶段、互动、预算、负向信号和触达风险评分。", "输出S/A/B/C/D、分数、证据、置信度、建议动作和规则/模型版本。", "COL-008/COL-009/ACQ-005"),
    WorkItem("ACQ-008", "M1", "评分规则兜底", "主责", "实现规则引擎", "在模型不可用时用可配置规则生成最低可用评分。", "断开模型后仍能评分；结果标明fallback且可追溯。", "ACQ-007"),
    WorkItem("ACQ-009", "M1", "人工改分与评分历史", "定义改分原因", "主责", "支持人工调整等级、填写原因并保留历史版本。", "任何改分可追溯到人员、时间、前后值；不覆盖AI原始结果。", "ACQ-007"),
    WorkItem("ACQ-010", "M1", "基础客户作战卡", "主责", "实现数据聚合与页面", "汇总客户信息、需求证据、痛点、建议角色、开场方向、风险和下一步。", "A级以上可一键生成；所有结论有证据和置信度。", "ACQ-007"),
    WorkItem("ACQ-011", "M1", "基础知识库", "定义知识分类与引用规则", "主责", "维护产品、行业方案、案例、报价规则、异议和禁止承诺。", "作战卡能引用知识条目并显示来源版本；权限隔离。"),
    WorkItem("ACQ-012", "M1", "商机雷达与线索池页面", "业务验收", "主责", "提供搜索任务、来源统计、线索列表、证据、评分、筛选和导入反馈。", "用户可从创建任务完整走到查看A级线索与作战卡。", "ACQ-001—ACQ-011"),

    # M2 sales execution
    WorkItem("SAL-001", "M2", "客户情报研究智能体", "主责", "提供工具与任务状态", "基于公开企业信息、官网、招聘、招投标和历史沟通补充需求证据。", "研究过程显示来源、完成度和过期时间；不把推测写成事实。", "ACQ-010"),
    WorkItem("SAL-002", "M2", "供应商分析", "主责", "实现数据结构与页面", "识别疑似现有供应商、能力缺口、替换或补位机会。", "每个供应商判断有来源、置信度和建议切入角度。", "SAL-001"),
    WorkItem("SAL-003", "M2", "决策链识别", "主责", "实现角色模型与页面", "识别老板、运营、采购、销售、店长和技术等角色及优先级。", "明确需求发起人、影响人、决策人、关注点和未知项。", "SAL-001"),
    WorkItem("SAL-004", "M2", "采购偏好与沟通风格", "主责", "实现存储与展示", "分析效果、价格、品牌、稳定、技术、速度和多人决策倾向。", "只基于商务信息与授权数据；输出证据、置信度和不建议方式。", "SAL-001"),
    WorkItem("SAL-005", "M2", "开场链接策略智能体", "主责", "实现生成入口与版本管理", "生成公开回复、企微邀请、电话、邮件、会议和分角色开场策略。", "话术与角色、采购偏好和线索等级一致；不得直接自动发送。", "SAL-002—SAL-004"),
    WorkItem("SAL-006", "M2", "报价拦截", "主责", "实现触发器与工作台", "识别问价场景，先生成需求澄清问题和内部处理建议。", "对外不自动给固定价格；对内保留触发原因和人工编辑记录。"),
    WorkItem("SAL-007", "M2", "基础报价建议", "主责", "实现计算服务与页面", "根据套餐、成本、客户价值、复杂度和采购偏好给区间、底价、折扣边界。", "价格建议显示假设、毛利影响和审批条件，不自动承诺客户。", "FIN-001基础口径"),
    WorkItem("SAL-008", "M2", "人工审核队列", "定义风险和审批策略", "主责", "统一审核话术、触达建议、报价、折扣和高风险动作。", "支持通过、修改、驳回、转交；全流程留痕。", "SAL-005—SAL-007"),
    WorkItem("SAL-009", "M2", "触达风控与勿扰", "主责", "主责实现", "定义敏感词、重复触达、负向客户、频率、夸大承诺和勿扰规则。", "高风险动作被阻断或升级审批；规则可配置并有命中原因。"),
    WorkItem("SAL-010", "M2", "CRM阶段与负责人", "定义业务阶段", "主责", "支持新线索到已回款/流失/复盘的阶段、负责人和时间线。", "阶段变更受规则约束；所有变更进入审计时间线。"),
    WorkItem("SAL-011", "M2", "跟进记录与AI下一步", "主责建议逻辑", "主责数据与页面", "记录沟通、异议、下次时间、报价、成交、回款和AI建议。", "AI建议引用最新上下文；销售可采用、修改或忽略并反馈。", "SAL-010"),
    WorkItem("SAL-012", "M2", "客户作战室完整版", "业务与AI验收", "主责", "整合情报、供应商、决策链、偏好、话术、报价、审核和跟进。", "销售可在一个页面完成从理解客户到创建跟进任务的完整操作。", "SAL-001—SAL-011"),

    # M3 finance and management
    WorkItem("FIN-001", "M3", "财务指标词典与口径", "主责", "协作落库", "定义收入、毛利、服务成本、获客成本、回款、ROI、LTV和账期风险口径。", "每项指标有公式、数据来源、时间口径、缺失处理和示例。"),
    WorkItem("FIN-002", "M3", "产品套餐与成本模型", "主责", "主责实现", "维护套餐价、底价、直接成本、交付成本、赠品成本和折扣权限。", "任一报价可计算预估毛利；历史版本不随新规则改变。", "FIN-001"),
    WorkItem("FIN-003", "M3", "线索财务价值评分", "主责", "实现服务与页面", "估算成交额、毛利、概率、销售成本、服务复杂度、回款、复购和转介绍。", "输出财务价值等级、假设、置信度和与意向评分合成的优先级。", "FIN-001/ACQ-007"),
    WorkItem("FIN-004", "M3", "渠道成本归集", "主责口径", "主责实现", "按渠道、活动、期间记录广告、工具、人力和内容等成本。", "成本可追溯、可分摊、可更正；同一成本不重复计入。", "FIN-001"),
    WorkItem("FIN-005", "M3", "渠道ROI计算与看板", "主责", "主责实现", "计算渠道线索、A级率、成交、收入、毛利、回款、CAC、ROI和转化率。", "筛选时间/渠道/销售后口径一致；可钻取到底层线索和订单。", "FIN-004/SAL-010"),
    WorkItem("FIN-006", "M3", "报价与折扣毛利保护", "主责", "主责实现审批联动", "计算不同价格、折扣、赠品和服务承诺对毛利的影响。", "低于底价或毛利线自动升级审批；保留审批前后方案。", "FIN-002/SAL-008"),
    WorkItem("FIN-007", "M3", "客户利润复盘", "主责", "主责数据与页面", "比较预计与实际成交、成本、毛利、回款、售后、复购和转介绍。", "可识别高利润、低利润、高服务成本和慢回款客户并解释原因。", "FIN-003/SAL-010"),
    WorkItem("FIN-008", "M3", "经营数据看板", "定义指标优先级", "主责", "展示商机、漏斗、报价、回款、利润、渠道ROI和异常提醒。", "老板、销售、运营、财务按权限看到一致且可追溯的数据。", "FIN-005/FIN-007"),
    WorkItem("FIN-009", "M3", "财务与经营权限", "定义敏感字段边界", "主责", "按角色控制价格、成本、毛利、回款、导出和审批权限。", "越权请求被拒绝并记录；销售无法查看未授权成本与利润。"),

    # M4 forecasting and learning
    WorkItem("FRC-001", "M4", "预测数据质量门", "主责", "主责实现", "定义最小样本、字段完整度、异常值和可预测性检查。", "数据不足时系统明确说明不能可靠预测，不伪造精确结果。", "FIN-001"),
    WorkItem("FRC-002", "M4", "销售预测模型", "主责", "实现训练/推理服务", "结合线索等级、阶段、报价、历史转化和销售表现预测成交额。", "输出区间、置信度、关键驱动和回测误差；可与基线模型比较。", "FRC-001"),
    WorkItem("FRC-003", "M4", "回款预测模型", "主责", "实现训练/推理服务", "结合合同、账期、客户风险和历史回款预测到账时间与金额。", "输出未来7/30/90天区间和延期风险客户；支持回测。", "FRC-001"),
    WorkItem("FRC-004", "M4", "目标达成与线索缺口", "主责", "主责实现", "根据目标、预测和转化漏斗估算所需新增A级线索与重点动作。", "建议能追溯到假设和当前漏斗，不以保证完成目标表述。", "FRC-002/FRC-003"),
    WorkItem("FRC-005", "M4", "预测与风险看板", "定义解释层", "主责", "展示预测区间、目标概率、重点客户、回款风险和数据质量。", "管理者能从预测下钻到客户和证据；不同页面口径一致。", "FRC-002—FRC-004"),
    WorkItem("FRC-006", "M4", "成交反馈与模型优化", "主责", "实现反馈管道", "把成交、流失、实际成本和回款结果反馈给评分与预测评估。", "新模型先离线评估再发布；保留版本、指标和回滚能力。", "FIN-007/FRC-002/FRC-003"),
    WorkItem("FRC-007", "M4", "智能体与财务模型评测", "主责", "提供自动评测基础", "建立准确性、证据完整度、幻觉率、稳定性、成本和延迟指标。", "发布前通过固定黄金集和回归阈值；失败阻止上线。", "COL-008"),

    # M5 enterprise extension
    WorkItem("ENT-001", "M5", "外部系统连接器", "定义业务映射", "主责", "按项目接入CRM、ERP、财务、企微、进销存、收银、广告平台和自有数据库。", "连接器可配置、可重试、可审计；字段映射和同步冲突有记录。"),
    WorkItem("ENT-002", "M5", "多组织与数据隔离", "定义管理规则", "主责", "支持组织、部门、门店、区域、团队和跨组织审批。", "租户与组织数据隔离经自动安全测试验证。"),
    WorkItem("ENT-003", "M5", "行业模型包", "主责", "实现配置加载", "沉淀财税、装修、美业、教培、招商等行业ICP、评分、话术和财务规则。", "行业包可版本化、启停和覆盖，不复制核心代码。"),
    WorkItem("ENT-004", "M5", "私有化部署", "定义模型与数据边界", "主责", "提供Docker/内网部署、备份恢复、日志监控和升级方案。", "在隔离环境完成安装、升级、回滚和恢复演练。"),
    WorkItem("ENT-005", "M5", "审计与合规增强", "定义合规规则", "主责", "提供数据来源、授权、访问、AI调用、审批和导出审计。", "关键记录不可由普通角色删除；支持按客户导出审计链。"),
    WorkItem("ENT-006", "M5", "企业定制交付流程", "共同", "共同", "建立需求评估、范围冻结、数据准备、验收和变更管理模板。", "企业需求不直接污染标准版；变更有报价、依赖和验收边界。"),
]


MILESTONES = [
    ("M0", "协作与工程基础", "两套Codex可在独立分支安全开发，并通过契约和测试集成。", "协作规则、模块边界、CI、Schema和黄金样例可用。"),
    ("M1", "商机判断闭环", "输入ICP后发现线索、清洗去重、真实评分并生成基础作战卡。", "完整演示：创建搜索任务 → 查看A级线索 → 生成作战卡。"),
    ("M2", "销售转化闭环", "从客户情报、决策链和话术进入审核、报价与CRM跟进。", "完整演示：作战卡 → 人工审核 → 报价/跟进 → 留痕。"),
    ("M3", "财务经营闭环", "从成交与成本形成财务价值、渠道ROI、利润复盘和经营看板。", "核心指标可追溯到底层数据，报价受毛利边界保护。"),
    ("M4", "预测优化闭环", "预测成交与回款、识别缺口，并用真实结果评测优化模型。", "预测有数据质量门、区间、解释、回测和模型版本。"),
    ("M5", "企业定制能力", "扩展外部连接、多组织、行业模型和私有化部署。", "按项目评估交付，不把定制逻辑硬编码到标准版。"),
]


def set_cell_shading(cell, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=80, start=120, bottom=80, end=120) -> None:
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for m, v in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{m}"))
        if node is None:
            node = OxmlElement(f"w:{m}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(v))
        node.set(qn("w:type"), "dxa")


def set_run_font(run, size=11, bold=False, color=BLACK, italic=False) -> None:
    run.font.name = FONT
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), FONT)
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), FONT)
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), FONT)
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    run.font.color.rgb = RGBColor.from_string(color)


def set_paragraph_font(paragraph, size=11, bold=False, color=BLACK) -> None:
    for run in paragraph.runs:
        set_run_font(run, size=size, bold=bold, color=color)


def set_cell_text(cell, text: str, *, size=9, bold=False, color=BLACK, align=None) -> None:
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.08
    if align is not None:
        p.alignment = align
    run = p.add_run(text)
    set_run_font(run, size=size, bold=bold, color=color)
    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    set_cell_margins(cell)


def set_repeat_table_header(row) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def configure_table_geometry(table, widths_in: Sequence[float]) -> None:
    widths_dxa = [int(round(w * 1440)) for w in widths_in]
    if sum(widths_dxa) != TABLE_WIDTH_DXA:
        widths_dxa[-1] += TABLE_WIDTH_DXA - sum(widths_dxa)
    table.autofit = False
    tbl_pr = table._tbl.tblPr
    layout = tbl_pr.find(qn("w:tblLayout"))
    if layout is None:
        layout = OxmlElement("w:tblLayout")
        tbl_pr.append(layout)
    layout.set(qn("w:type"), "fixed")
    tbl_w = tbl_pr.find(qn("w:tblW"))
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        tbl_pr.append(tbl_w)
    tbl_w.set(qn("w:w"), str(TABLE_WIDTH_DXA))
    tbl_w.set(qn("w:type"), "dxa")
    tbl_ind = tbl_pr.find(qn("w:tblInd"))
    if tbl_ind is None:
        tbl_ind = OxmlElement("w:tblInd")
        tbl_pr.append(tbl_ind)
    tbl_ind.set(qn("w:w"), str(TABLE_INDENT_DXA))
    tbl_ind.set(qn("w:type"), "dxa")
    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width in widths_dxa:
        col = OxmlElement("w:gridCol")
        col.set(qn("w:w"), str(width))
        grid.append(col)
    for row in table.rows:
        for idx, cell in enumerate(row.cells):
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_w = tc_pr.find(qn("w:tcW"))
            if tc_w is None:
                tc_w = OxmlElement("w:tcW")
                tc_pr.append(tc_w)
            tc_w.set(qn("w:w"), str(widths_dxa[idx]))
            tc_w.set(qn("w:type"), "dxa")
            cell.width = Inches(widths_dxa[idx] / 1440)


def add_page_number(paragraph) -> None:
    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = paragraph.add_run("第 ")
    set_run_font(run, size=9, color=GRAY)
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), "PAGE")
    run._r.addnext(fld)
    run2 = paragraph.add_run(" 页")
    set_run_font(run2, size=9, color=GRAY)


def configure_document(doc: Document, running_title: str) -> None:
    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(1)
    section.bottom_margin = Inches(1)
    section.left_margin = Inches(1)
    section.right_margin = Inches(1)
    section.header_distance = Inches(0.492)
    section.footer_distance = Inches(0.492)

    styles = doc.styles
    normal = styles["Normal"]
    normal.font.name = FONT
    normal._element.rPr.rFonts.set(qn("w:ascii"), FONT)
    normal._element.rPr.rFonts.set(qn("w:hAnsi"), FONT)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    normal.font.size = Pt(11)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.25

    for name, size, color, before, after in (
        ("Heading 1", 16, BLUE, 18, 10),
        ("Heading 2", 13, BLUE, 14, 7),
        ("Heading 3", 12, DARK_BLUE, 10, 5),
    ):
        style = styles[name]
        style.font.name = FONT
        style._element.rPr.rFonts.set(qn("w:ascii"), FONT)
        style._element.rPr.rFonts.set(qn("w:hAnsi"), FONT)
        style._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = RGBColor.from_string(color)
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True

    header_p = section.header.paragraphs[0]
    header_p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    header_p.paragraph_format.space_after = Pt(0)
    header_run = header_p.add_run(running_title)
    set_run_font(header_run, size=8.5, color=GRAY)
    footer_p = section.footer.paragraphs[0]
    add_page_number(footer_p)


def add_cover(doc: Document, title: str, subtitle: str, owner: str, scope: str) -> None:
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(18)
    p.paragraph_format.space_after = Pt(4)
    r = p.add_run("AI增长经营系统｜开发执行文件")
    set_run_font(r, size=10, bold=True, color=GOLD)

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(6)
    r = p.add_run(title)
    set_run_font(r, size=24, bold=True, color=NAVY)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(18)
    r = p.add_run(subtitle)
    set_run_font(r, size=12.5, color=GRAY)

    meta = [
        ("文档版本", "V1.0"),
        ("生成日期", date.today().isoformat()),
        ("责任范围", owner),
        ("产品范围", scope),
        ("协作模式", "受控Codex协作：独立分支 → 自动测试 → 草稿PR → 另一位成员人工审核合并"),
    ]
    table = doc.add_table(rows=1, cols=2)
    table.style = "Table Grid"
    for idx, (label, value) in enumerate(meta):
        row = table.rows[0] if idx == 0 else table.add_row()
        set_cell_text(row.cells[0], label, size=9.5, bold=True, color=NAVY)
        set_cell_text(row.cells[1], value, size=9.5)
        set_cell_shading(row.cells[0], LIGHT_BLUE)
    configure_table_geometry(table, [1.35, 5.15])

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(14)
    p.paragraph_format.space_after = Pt(0)
    r = p.add_run("使用说明：")
    set_run_font(r, size=10.5, bold=True, color=NAVY)
    r = p.add_run("任务完成后勾选状态，并在对应GitHub Issue/PR中附测试证据。清单是范围基准，不替代Issue中的详细验收。")
    set_run_font(r, size=10.5)

    doc.add_page_break()


def add_callout(doc: Document, label: str, text: str, fill=PALE_GOLD) -> None:
    table = doc.add_table(rows=1, cols=1)
    table.style = "Table Grid"
    cell = table.cell(0, 0)
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(2)
    r = p.add_run(f"{label}  ")
    set_run_font(r, size=10, bold=True, color=NAVY)
    r = p.add_run(text)
    set_run_font(r, size=10)
    set_cell_shading(cell, fill)
    set_cell_margins(cell, top=110, bottom=110, start=140, end=140)
    configure_table_geometry(table, [6.5])


def add_matrix(
    doc: Document,
    headers: Sequence[str],
    rows: Iterable[Sequence[str]],
    widths: Sequence[float],
    *,
    font_size: float = 8.8,
    zebra: bool = True,
) -> None:
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    header = table.rows[0]
    set_repeat_table_header(header)
    for idx, text in enumerate(headers):
        set_cell_text(header.cells[idx], text, size=9, bold=True, color=WHITE, align=WD_ALIGN_PARAGRAPH.CENTER)
        set_cell_shading(header.cells[idx], NAVY)
    for row_idx, values in enumerate(rows):
        row = table.add_row()
        for idx, value in enumerate(values):
            align = WD_ALIGN_PARAGRAPH.CENTER if idx in (0, 1) else WD_ALIGN_PARAGRAPH.LEFT
            set_cell_text(row.cells[idx], str(value), size=font_size, align=align)
            if zebra and row_idx % 2 == 1:
                set_cell_shading(row.cells[idx], LIGHTER_BLUE)
    configure_table_geometry(table, widths)
    doc.add_paragraph().paragraph_format.space_after = Pt(0)


def milestone_items(milestone: str) -> list[WorkItem]:
    return [item for item in ITEMS if item.milestone == milestone]


def add_common_rules(doc: Document) -> None:
    doc.add_heading("一、统一协作原则", level=1)
    rows = [
        ("任务来源", "所有开发必须对应GitHub Issue；临时想法先进入需求池，不直接修改代码。"),
        ("Codex权限", "可创建分支、修改代码、运行测试、提交和创建草稿PR；不得自行合并。"),
        ("人工审核", "业务/模型PR由工程负责人审代码；工程/UI PR由智能决策负责人审业务和验收。"),
        ("变更边界", "同一时间一个Issue只有一个主责人；修改共同Schema必须先建HITL决策Issue。"),
        ("完成定义", "代码、测试、文档、迁移、回滚说明和验收证据齐全后才算完成。"),
        ("产品禁区", "不以自动评论、自动私信陌生人、自动加好友、自动群发和规避平台检测为核心能力。"),
    ]
    add_matrix(doc, ["规则", "统一要求"], rows, [1.35, 5.15], font_size=9.2, zebra=False)


def create_unified_document() -> Path:
    doc = Document()
    configure_document(doc, "统一开发功能清单")
    add_cover(
        doc,
        "统一开发功能清单",
        "AI获客增长与经营决策系统｜M0–M5全量路线",
        "两位项目负责人共同使用",
        "19个产品模块、6个交付阶段、完整产品路线",
    )
    add_common_rules(doc)
    add_callout(doc, "统一原则", "完整规划、分阶段交付。每个里程碑必须形成可运行、可演示、可验收的纵向闭环。")

    doc.add_heading("二、阶段总览与发布门", level=1)
    add_matrix(
        doc,
        ["阶段", "目标", "可演示结果", "发布门"],
        [(m, name, demo, gate) for m, name, demo, gate in MILESTONES],
        [0.55, 1.25, 2.35, 2.35],
        font_size=8.6,
    )

    doc.add_heading("三、职责边界", level=1)
    rows = [
        ("智能体与财务决策负责人", "智能体架构、Prompt与工具策略、AI Schema、意向评分、客户作战卡、财务口径、ROI/报价/预测模型、黄金样例和业务验收。"),
        ("前端与后端工程负责人", "前端体验、后端服务、数据库、权限、工作流、AI网关、数据落库、测试、CI、部署、稳定性和工程验收。"),
        ("共同负责", "产品范围冻结、共同Schema、API契约、发布门、重大技术/业务取舍、企业定制范围和最终合并。"),
    ]
    add_matrix(doc, ["角色", "职责"], rows, [1.75, 4.75], font_size=9.1, zebra=False)

    doc.add_heading("四、全量开发清单", level=1)
    add_callout(doc, "状态标记", "☐ 未开始　◐ 进行中　☑ 已完成　! 阻塞。状态变化以GitHub Issue为准。", fill=GREEN)
    for milestone, name, _, _ in MILESTONES:
        doc.add_heading(f"{milestone}｜{name}", level=2)
        rows = []
        for item in milestone_items(milestone):
            owner = "共同" if item.decision_owner == "共同" and item.engineering_owner == "共同" else (
                "智能决策" if item.decision_owner == "主责" and item.engineering_owner != "主责" else (
                    "产品工程" if item.engineering_owner == "主责" and item.decision_owner != "主责" else "双轨"
                )
            )
            rows.append((item.id, "☐", owner, f"{item.title}：{item.deliverable}", item.acceptance))
        add_matrix(doc, ["ID", "状态", "主责", "交付项", "验收标准"], rows, [0.7, 0.45, 0.8, 2.1, 2.45], font_size=7.9)

    doc.add_heading("五、统一完成定义（Definition of Done）", level=1)
    dod = [
        ("DOD-01", "功能对应已批准Issue，范围与依赖明确。"),
        ("DOD-02", "实现位于独立分支，未夹带无关改动。"),
        ("DOD-03", "AI输出通过Schema校验；财务指标符合统一口径。"),
        ("DOD-04", "单元、集成与必要E2E测试通过，并附测试证据。"),
        ("DOD-05", "数据库迁移可重复执行，有回滚或兼容说明。"),
        ("DOD-06", "错误、超时、数据不足和模型失败有明确用户反馈。"),
        ("DOD-07", "接口文档、业务规则和页面说明同步更新。"),
        ("DOD-08", "另一位负责人完成业务或工程审核后方可合并。"),
    ]
    add_matrix(doc, ["编号", "完成标准"], dod, [1.0, 5.5], font_size=9.1, zebra=False)

    path = OUTPUT_DIR / "AI获客增长与经营决策系统_统一开发功能清单.docx"
    doc.save(path)
    return path


def decision_items() -> list[WorkItem]:
    result = []
    for item in ITEMS:
        if item.decision_owner in {"主责", "共同"} or "定义" in item.decision_owner or "验收" in item.decision_owner:
            result.append(item)
    return result


def engineering_items() -> list[WorkItem]:
    result = []
    for item in ITEMS:
        if item.engineering_owner in {"主责", "共同"} or "实现" in item.engineering_owner or "协作" in item.engineering_owner or "提供" in item.engineering_owner:
            result.append(item)
    return result


def add_role_operating_model(doc: Document, role: str, owns: str, excludes: str) -> None:
    doc.add_heading("一、角色使命与边界", level=1)
    add_matrix(
        doc,
        ["项目", "说明"],
        [
            ("角色使命", role),
            ("你最终负责", owns),
            ("不单独负责", excludes),
            ("与另一轨交接", "先交Schema/规则/验收样例，再由另一轨实现或接入；接口变更必须通过HITL Issue确认。"),
            ("Codex权限", "可建分支、开发、测试、提交、推送并创建草稿PR；不得自行合并。"),
        ],
        [1.35, 5.15],
        font_size=9.2,
        zebra=False,
    )


def create_decision_document() -> Path:
    doc = Document()
    configure_document(doc, "智能体与财务决策负责人功能清单")
    add_cover(
        doc,
        "智能体与财务决策负责人功能清单",
        "你的任务范围｜智能体、评分、作战策略与完整财务决策",
        "智能体与财务决策负责人",
        "覆盖M0–M5中的业务规则、AI契约、财务模型与验收",
    )
    add_role_operating_model(
        doc,
        "保证系统真正具备可解释的智能判断和经营决策能力，而不是在CRM上增加通用聊天框。",
        "智能体职责与工具、结构化输出、意向评分、客户作战卡、决策链、采购偏好、报价与财务口径、ROI、利润和预测模型、黄金测试集及业务验收。",
        "前端组件、后端基础设施、数据库迁移、权限实现、部署和工程稳定性；但你必须审核这些实现是否符合业务规则。",
    )

    doc.add_heading("二、必须先交付的共享契约", level=1)
    schemas = [
        ("ICPProfile", "行业、产品、地区、客单价、客户角色、正负向信号、排除对象、渠道策略。"),
        ("LeadScore", "意向等级/分数、证据、负向信号、风险、置信度、建议动作、模型/规则版本。"),
        ("BattleCard", "需求证据、痛点、供应商、决策链、采购偏好、开场策略、报价建议、下一步和禁用动作。"),
        ("PricingAdvice", "澄清问题、报价区间、底价、折扣边界、赠品成本、毛利影响、审批条件。"),
        ("FinancialValue", "预计成交、毛利、概率、获客/销售/服务成本、回款、复购、转介绍和假设。"),
        ("Forecast", "预测区间、置信度、数据质量、驱动因素、风险客户、目标缺口和模型版本。"),
    ]
    add_matrix(doc, ["契约", "你需要定义的内容"], schemas, [1.35, 5.15], font_size=9.0)

    doc.add_heading("三、分阶段个人功能清单", level=1)
    all_role_items = decision_items()
    for milestone, name, _, _ in MILESTONES:
        rows = []
        for item in all_role_items:
            if item.milestone != milestone:
                continue
            handoff = item.engineering_owner if item.engineering_owner != "主责" else "交付Schema、规则和验收样例给工程轨"
            rows.append((item.id, "☐", f"{item.title}：{item.deliverable}", f"交接：{handoff}\n验收：{item.acceptance}"))
        if rows:
            doc.add_heading(f"{milestone}｜{name}", level=2)
            add_matrix(doc, ["ID", "状态", "你的交付物", "交接与验收"], rows, [0.75, 0.45, 2.7, 2.6], font_size=8.1)

    doc.add_heading("四、智能体质量门", level=1)
    quality = [
        ("证据", "任何客户、供应商、决策链和采购偏好结论必须有来源；推测与事实分开。"),
        ("置信度", "输出明确置信度和未知项；低置信度不触发高风险建议。"),
        ("结构化", "AI输出必须通过JSON Schema，禁止仅返回自然语言长文。"),
        ("降级", "模型失败、超时或数据不足时返回明确状态，并使用规则兜底或要求人工补充。"),
        ("一致性", "同一黄金样例在Prompt或模型升级后不得无解释地跨越两个等级。"),
        ("成本", "记录模型、Token、延迟、成本和Prompt版本，支持按功能统计。"),
        ("安全", "不使用未授权私密数据，不输出自动骚扰或规避平台检测策略。"),
    ]
    add_matrix(doc, ["质量维度", "验收要求"], quality, [1.25, 5.25], font_size=9.1, zebra=False)

    doc.add_heading("五、财务决策质量门", level=1)
    finance = [
        ("口径唯一", "每项指标只有一个正式定义；页面、接口和报表使用同一计算版本。"),
        ("假设透明", "预计成交、毛利和回款必须显示数据来源、假设和置信区间。"),
        ("可追溯", "ROI、利润和预测能下钻到渠道成本、线索、报价、订单与回款。"),
        ("不伪精确", "样本不足时输出区间或不可预测，不生成看似精确的数字。"),
        ("可回测", "预测和评分均可使用历史数据回测，并与简单基线比较。"),
        ("版本化", "规则、权重、公式和模型版本被保存，历史结果可重现。"),
    ]
    add_matrix(doc, ["质量维度", "验收要求"], finance, [1.25, 5.25], font_size=9.1, zebra=False)

    doc.add_heading("六、你的PR完成定义", level=1)
    add_callout(doc, "完成条件", "Schema/规则已版本化；黄金样例通过；失败与低置信度路径明确；成本与证据可追溯；工程负责人已审核实现可行性。", fill=GREEN)

    path = OUTPUT_DIR / "AI获客增长与经营决策系统_智能体与财务决策负责人功能清单.docx"
    doc.save(path)
    return path


def create_engineering_document() -> Path:
    doc = Document()
    configure_document(doc, "前端与后端工程负责人功能清单")
    add_cover(
        doc,
        "前端与后端工程负责人功能清单",
        "朋友的任务范围｜产品体验、后端平台、数据、测试与部署",
        "前端与后端工程负责人",
        "覆盖M0–M5中的工程架构、页面、服务、数据、权限和运维",
    )
    add_role_operating_model(
        doc,
        "把智能体与财务决策规则可靠地变成可使用、可协作、可审计和可部署的产品。",
        "前端体验、后端模块、数据库与迁移、API、AI调用网关、任务与审核工作流、权限、安全、测试、CI、部署、可观测性和性能。",
        "独自决定意向评分、客户作战逻辑、财务口径和预测算法；对不明确的业务规则必须通过HITL Issue与另一负责人确认。",
    )

    doc.add_heading("二、工程架构边界", level=1)
    architecture = [
        ("前端", "按全网商机、线索池、客户作战室、报价审核、CRM、ROI、预测和系统设置拆分features；共享设计系统与数据访问层。"),
        ("业务后端", "按lead、account、battle-card、review、crm、pricing、finance、forecast和iam拆分路由/服务/仓储。"),
        ("AI网关", "统一模型适配、Schema校验、Prompt版本、任务状态、重试、成本、日志和人工审核挂起点。"),
        ("数据库", "业务实体、AI结果、证据、规则版本、人工改写、审批、财务事实和审计日志分层保存。"),
        ("异步任务", "搜索、网页解析、情报研究、批量评分、作战卡、预测等长任务异步执行，支持重试与幂等。"),
        ("权限", "租户、团队、角色和字段级敏感权限；财务与导出能力单独授权。"),
        ("运维", "环境配置、数据库迁移、健康检查、日志、指标、备份恢复、升级回滚和私有化部署预留。"),
    ]
    add_matrix(doc, ["工程域", "实现要求"], architecture, [1.25, 5.25], font_size=9.0)

    doc.add_heading("三、分阶段个人功能清单", level=1)
    all_role_items = engineering_items()
    for milestone, name, _, _ in MILESTONES:
        rows = []
        for item in all_role_items:
            if item.milestone != milestone:
                continue
            handoff = item.decision_owner if item.decision_owner != "主责" else "由智能决策轨提供Schema、规则与验收样例"
            rows.append((item.id, "☐", f"{item.title}：{item.deliverable}", f"交接：{handoff}\n验收：{item.acceptance}"))
        if rows:
            doc.add_heading(f"{milestone}｜{name}", level=2)
            add_matrix(doc, ["ID", "状态", "朋友的交付物", "交接与验收"], rows, [0.75, 0.45, 2.7, 2.6], font_size=8.1)

    doc.add_heading("四、核心页面交付清单", level=1)
    pages = [
        ("UI-01", "首页经营看板", "今日线索、S/A级、审核任务、预计成交/回款、ROI和风险提醒。"),
        ("UI-02", "行业与产品配置", "ICP、关键词、排除对象、客单价、报价和渠道配置。"),
        ("UI-03", "全网商机雷达", "搜索任务、来源、执行状态、消耗、失败原因和结果统计。"),
        ("UI-04", "线索池", "等级、财务价值、来源、需求证据、负责人、阶段和批量操作。"),
        ("UI-05", "客户作战室", "情报、供应商、决策链、偏好、话术、报价、审核和跟进时间线。"),
        ("UI-06", "报价工作台", "套餐、报价、底价、折扣、毛利影响、审批和版本对比。"),
        ("UI-07", "人工审核队列", "话术、触达、报价和风险的通过、修改、驳回与转交。"),
        ("UI-08", "CRM跟进", "阶段、负责人、沟通、异议、任务、报价、成交和回款。"),
        ("UI-09", "渠道ROI", "渠道成本、线索质量、成交、毛利、回款、ROI和明细下钻。"),
        ("UI-10", "销售与回款预测", "区间、置信度、目标概率、风险客户、缺口和数据质量。"),
        ("UI-11", "客户利润复盘", "预计与实际、服务成本、售后、回款、复购和转介绍。"),
        ("UI-12", "知识库与系统设置", "知识、Prompt/规则版本、模型、账号、权限、审计和数据源。"),
    ]
    add_matrix(doc, ["ID", "页面", "必须展示/操作"], pages, [0.8, 1.45, 4.25], font_size=8.9)

    doc.add_heading("五、工程质量门", level=1)
    quality = [
        ("模块边界", "新功能进入独立模块；禁止继续把业务堆进两个巨型文件。"),
        ("Schema校验", "AI输入输出和API请求响应均有运行时校验；不合格结果不得直接落业务表。"),
        ("迁移安全", "迁移可重复、兼容已有数据；高风险变更提供备份和回滚说明。"),
        ("可靠性", "长任务具备状态、超时、重试、幂等和取消；第三方来源失败不拖垮整体。"),
        ("安全", "无硬编码密钥；权限、租户隔离、导出、审计和输入验证有测试。"),
        ("可观测", "日志包含trace/request/task ID，记录错误、延迟、AI成本和外部数据源状态。"),
        ("性能", "列表分页、搜索与批量任务受限；关键页面有加载、空态和失败态。"),
        ("测试", "后端单元/集成、前端单元、核心E2E和安全测试进入CI。"),
        ("可部署", "开发、测试、生产配置分离；健康检查、备份恢复和升级文档可执行。"),
    ]
    add_matrix(doc, ["质量维度", "验收要求"], quality, [1.25, 5.25], font_size=9.0, zebra=False)

    doc.add_heading("六、朋友的PR完成定义", level=1)
    add_callout(doc, "完成条件", "功能使用统一Schema与API契约；页面覆盖加载/空/错/权限态；迁移与测试通过；日志可定位；文档已更新；智能决策负责人已完成业务验收。", fill=GREEN)

    path = OUTPUT_DIR / "AI获客增长与经营决策系统_前端与后端工程负责人功能清单.docx"
    doc.save(path)
    return path


def main() -> None:
    paths = [
        create_unified_document(),
        create_decision_document(),
        create_engineering_document(),
    ]
    for path in paths:
        print(path)


if __name__ == "__main__":
    main()
