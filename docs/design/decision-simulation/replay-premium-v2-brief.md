# 星盘主屏视觉参考 v2

生成方式：内置 ImageGen。设计图 `replay-premium-v2.png` 为视觉参考；图内企业数值、建议和事件为合成示例，不是产品计算结果。品牌必须使用产品真实素材。

## 布局与实现约束

- 单一主标题、五阶段导航、情景上下文、连续摘要条、轨迹主画布与右侧详情、底部依据与临界点。
- 主画布约占工作区 72%，右侧详情约 28%。完整 100 格选择器在右侧折叠展开，不挤占主图。
- 保留黑绿主题，底色 #090E0C，面板 #101915，边界 #26362E，主色 #42DD9B，正文 #E6EEE9。圆角以 8px 为主。
- 1280×768 下优先图与播放控件；允许次要内容向下滚动，不缩成难读小字。
- 图中的分位区间、现金利润切换与风险事件必须以已保存计算数据为依据；缺失时不显示伪造结果。
- 同样本对照、完整 100 情景、种子、周期、来源、5 角色真实状态、历史恢复与完整导出均必须保留。
- 已完成计算后的轨迹播放标记为结果回放。真实模型计算状态单独呈现。
- 播放暂停、进度拖动、倍速、选中情景高亮和对照切换使用实际结果，尊重 reduced-motion。
- 图中侧栏品牌字和 100 格数量存在生成局限，实现须纠正为实际品牌与完整数量。

## 生成提示词

Use case: ui-mockup. Create one exquisite high fidelity desktop Chinese enterprise decision simulation application design screenshot, 1600x1000 landscape. A complete flat app screen, no device frame, no perspective, no presentation annotations. Redesign the reference's business functionality, NOT its clunky styling. Design quality of meticulous premium desktop productivity software: precision alignment, extremely readable Chinese typography, restrained use of panels, elegant density, strong hierarchy, breathing room. Preserve black and emerald green brand. NO Apple logo, no neon yellow, no purple, no decorative planets or cosmic illustrations.
Palette almost-black #090E0C, subtly lighter #101915 surfaces, fine #26362E borders, emerald #42DD9B, off-white #E6EEE9, clear muted gray-green text. 8px panel corners rather than huge round cards. 1px lines, sparse highlights.
Layout: 176px quiet left sidebar with abstract small orbital brand symbol and Chinese brand 燊锶. Navigation 自动营销总览 / 获客中心 / 社媒对话 / 私域客户池 / 企业查询 / 智能体中心 / 星盘决策 selected / 设置中心. DO NOT include obsolete growth/financial council modules. Bottom compact user avatar.
Main top header title 星盘决策, subtitle 看清每个决定的可能走向. Right quiet 历史记录 and 导出报告 button. Below one compact horizontal stage navigation: 01 企业资料, 02 数据核对, 03 智能体分析, 04 平行情景 active, 05 决策报告. No duplicate titles and no giant hero.
Compact scenario context row: 产能扩张，还是维持现状？ and small badge 模拟示例, secondary 100 条情景 · 12 个月 · 已完成计算. Right 编辑经营起点.
One elegant horizontal summary strip without four separate chunky cards: 期末现金中位数 ¥428,600 / 较维持现状 +¥82,400 / 最低现金 ¥96,200 / 资金不足情景 8 / 100. Small note 样本统计，不代表现实发生概率.
Core workspace left 72% and right 28%, ~480px tall. Main large chart area titled 100 条可能的经营轨迹 with small explanatory legend: 扩张方案 solid emerald and 维持现状 dashed gray. Top right segmented selector 现金 / 利润. Plot shows many thin subdued emerald branching trajectories starting from common initial baseline, one bright emerald selected path, one fine dashed gray comparison path, subtle translucent quantile band, restrained amber paths below zero. Accurate subtle axis markings ¥60万 / ¥40万 / ¥20万 / ¥0; horizontal monthly labels 1月 through12月. CURRENT month 6 with vertical cursor and small tasteful data marker. Chart dominates and is airy, not clutter. No fake space particle effects.
Below chart unified playback bar: circular play icon, 结果回放, precise green month scrubber from1 to12, 第6月 / 12月, 1× selector, 重播. This is result replay not computation progress.
Right inspector separated by fine vertical border: 情景 037 with small dropdown. Label 第6月, large 月末现金 ¥284,600, clean rows 本月收入 ¥86,000 / 本月回款 ¥72,000 / 本月支出 ¥58,400 / 订单交付 96 / 100. Mini event annotation 回款延迟 7 天 with small amber dot and 影响现金，不等于亏损. Lower expandable section 选择情景 shows compact 10×10 tiny squares with 37 selected emerald; numbers optional except selected37, not 100 giant buttons.
Bottom full-width balanced two-column secondary area: left 五位智能体 · 已完成 with five compact horizontal role chips 创始人 市场 运营 财务 审议, each small check; one concise recommendation 先锁定回款，再分阶段扩产。 supporting sentence 扩张提升利润，但第4—6月需要更充足的现金储备。 and 查看分析依据. Right 决策临界点 with two precise rows 回款延迟超过 21 天 → 现金压力上升, 月订单低于 120 单 → 扩张优势消失. Footer subtle 已读取 2 份示例资料 · 假设可调整 · 查看来源.
Overall premium calm beautiful information tool; strong visual restraint and intentional hierarchy. All data synthetic design examples. Chinese copy crisp. Reference provided only for functional context, transform layout as described.

