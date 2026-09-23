# 官网视觉依据

用户最终要求：蓝白配色，完整品牌 Logo，深蓝山水与云雾、玻璃导航/卡片、原子轨道聚合、粒子滚动变形，保留五大业务和全部双语页面。首版以产品展示为主。官网为独立模块，不覆盖客户工作台。

## Image Gen

使用内置 Image Gen，未使用 CLI/API Key。工作设计稿为 `hero.png`、`business.png`、`products.png`、`ending.png`、`contact.png`。前期黑绿稿被用户蓝白要求替代，未纳入官网。原始生成稿没有收到用户逐图批准，作为按用户要求制作的实现参考，不称为已获批准的设计。

共用提示：premium Chinese enterprise corporate website SHENSI 燊锶; blue and white, white #ffffff, navy #163859, blue #2b64e8, cyan #16b4cf; modern Chinese sans serif; floating frosted-glass navigation; spacious cinematic editorial layout; actual controls and copy implemented in HTML, no fake metrics.

各稿内容：
1. Hero：light misty Chinese mountains, complete logo on glass card, three orbiting atoms; headline “让企业经营 / 更清晰，更稳健。”; supporting professional/digital intelligence copy; two CTA buttons and five disciplines.
2. Business：five horizontal selectors and full-screen story scene, large navy heading, digital-intelligence copy, blue orbital sculpture, progress indicator. User additionally requested particle morphs; implement live Canvas geometry, not a raster imitation.
3. Needs/products：five needs buttons, mapped business pair, two concept-only product panels illustrating acquisition/agents/finance and scenario paths.
4. Ending：three not-yet-published insight topics, three trust principles, blue CTA band, white business footer.
5. Contact：bilingual labels, China/international paths, name/company/email/industry/need/message, consent, send button.

主视觉提示：wide cinematic Chinese mountain panorama, pale blue dawn sky and white mist, dark navy mountains at lower far edges, no words/logo/UI. Orbital 提示：three cobalt translucent glass orbit loops, cyan sphere, white podium and icy blue background, right-aligned object with left negative space, no words/UI.

首屏修订提示：edit the original mountain asset, preserve geography, add substantially more white mist across the center and lower center for navy text, preserve dark mountains only at far lower edges, lighten the blue sky, remove warm yellow sunlight; no words or UI. 最终首页使用 `public/assets/mountains-v2.png`，其他业务视觉保留 `mountains.png` 与 `orbital.png`。

## 设计系统与有意调整

白/冰蓝分区，深蓝正文，亮蓝操作，圆角22px，按钮胶囊形；1256px内容宽度，桌面56px/手机20px边距。标题层级从约66px降到23px，正文14–16px，标签10–12px。文字均为 HTML，不将生成截图作为页面。

保留实际原始 Logo，替换生成稿里不准确的品牌字与图形；业务粒子遵循用户后续动态要求。洞察不虚构文章、文章链接或成果。完整咨询页需要可读隐私说明，因此补入中英隐私页。产品图简化为真实能力的概念示意，不采用生成稿自造的业务指标。详情页沿用相同系统。

## 浏览器与视觉验收

内页采用同一蓝白山水和玻璃导航，新增四产品的独立线形图案及轻微浮动，五业务以各自步骤与输出体现差异；FAQ可展开，产品卡片整块可点击，洞察使用真实待发布专题页。页面首屏用白雾叠加山水，提高文字对比。40个中英页面均通过IAB桌面1280×720/手机390×844检查，无横向溢出或空白；实点验证产品→详情→咨询参数、专题→对应英文页、手机菜单→业务详情。1000个内部链接与锚点在构建中检查，40页HTTP200；截图 `/tmp/shensi-pages-desktop.png`、`/tmp/shensi-pages-mobile.png`。没有将展示页包装成可直接操作真实数据的工作台。

官网开场以原应用 `frontend/src/desktop/startup-splash.css` 的轨迹作为动态参考，单独适配蓝白配色；不使用原概念预览里的工作台截图。当前首页顶端先呈现滚动开场，下面所述完整标题/CTA构图出现在滚动开场结束时。原动画8.75秒关键帧由滚动驱动，取消自动时钟；核心扩散后交叉淡入山水首页，不等待真实应用初始化。

开场专项IAB验收：1280×720桌面和390×844手机。前进/回退到相同360px滚动位置时，原子computed transform完全相同；文字在末尾出现，继续滚动可见五业务正文。手机修复620px原始舞台撑宽网格造成的偏右裁切，缩放后Logo完整居中。关闭动态直接展示首页，重新开启后关键帧继续随滚动工作。专项截图位于 `/tmp/shensi-entry-desktop.png` 与 `/tmp/shensi-entry-mobile.png`；本轮控制台无error/warn。

使用 Codex 内置浏览器/IAB，未改用外部 Playwright。查看原参考站的首屏、粒子叙事与产品区，再对照五张蓝白工作稿。`view_image` 已读取工作稿及最终桌面、手机、产品截图；桌面原生视口1440×900，另查1280×720，手机390×844。

对照检查：玻璃导航的悬浮位置和圆角、完整 Logo 与三轨道、蓝白色温、标题两行层级、双 CTA 的顺序与按钮形状、五大业务的顺序和滚动切换、需求推荐面板、产品示意的对齐与图表。首屏标题和两个CTA与工作稿一致；说明文案因响应式换行拆成两行，Logo使用真实原稿。已按工作稿忠实核验这些设计要素；实际粒子形态为用户追加要求下的动态版本，不宣称与静态生成稿逐像素一致。

发现并修复：首版山水在手机端对比过强，使用 Image Gen 编辑生成 `mountains-v2.png`，增加中心白雾并保留边缘深蓝山体；SVG 网格默认填充形成黑色三角，显式设 `fill="none"` 后重新截图确认。最终保留的截图为 `verified-desktop.png`、`verified-mobile.png`、`verified-particles.png`、`verified-products.png`；都是交付用设计证据，不是页面背景。

交互证据：首屏→业务故事；业务导航→沙盘/外贸场景与粒子变形；需求选择→正确组合→方案query传入咨询；手机菜单；咨询填写/同意→未配置服务503真实提示且保留内容；动态开关→Canvas隐藏、全部业务可读。桌面/手机检查无横向溢出、无缺失图片；最终产品页检查无控制台error/warn。系统reduced-motion有CSS和事件监听实现，浏览器实测的是同等静态路径的手动开关，未修改操作系统偏好。

剩余边界：设计稿中的虚构Logo/文章配图/装饰文案没有照搬；洞察为真实待发布状态；产品预览不接真实界面；SMTP真实投递、CRM和公网域名尚未开通。不存在已知的内容裁切或主要交互故障，不将这些配置缺口算作已上线。
