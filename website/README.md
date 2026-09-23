# 燊锶品牌官网

这是同仓库独立的蓝白品牌官网，不是客户工作台或桌面应用。复用现有 Vite/TypeScript 和后端 Nodemailer，不新增框架依赖，不连接客户数据库。

## 运行

```bash
pnpm website:dev       # http://127.0.0.1:5690，独立官网开发预览
pnpm website:serve     # http://127.0.0.1:5691，构建后的静态页和咨询 API
pnpm website:build     # 类型检查、构建、40 个页面预渲染、内部链接与锚点校验
pnpm website:test      # 表单校验、来源限制、限流、真实发送回执边界
pnpm --dir frontend exec playwright test --config=playwright.website-browsers.config.ts # Chromium/Firefox/WebKit 本机路径
```

开发预览通过 Vite 仅代理 `/api/website-contact` 到 5691。仅运行 `website:preview` 不提供咨询 API。`website:serve` 应在 build 后运行，可作为完整本机验收入口。根 `pnpm build` 包含官网构建，根 `pnpm test` 包含官网接口测试。不运行 `desktop:local` 或 `trial:publish` 来发布官网。
跨浏览器本机测试覆盖首页、移动菜单、英文产品页和未配置邮件时的咨询提示；Safari/Edge 原生浏览器、公网真实收件与官网到安装包链接仍须在发行前另验，见 [浏览器兼容边界](../docs/desktop/browser-compatibility-acceptance.md)。

## 页面与职责

- `/`、`/en`：动态品牌首屏、五大业务滚动故事、需求选择器、产品概念展示、专业洞察预览、信任说明与底部咨询入口。
- `/business` 和 `/business/{digital,simulation,academy,advisory,global}`：业务总览和五个详情。
- `/products` 和 `/products/{acquisition,agents,finance,simulation}`：产品总览和四个产品流程详情；首页产品行、导航和业务页均有入口。
- `/insights/{business-digital,finance-policy,people-growth}`：三类专题方向页，可查看选题范围并进入相关业务；当前无正式文章，不把专题介绍伪装为文章或研究成果。
- `/solutions`、`/insights`、`/about`、`/contact`、`/privacy`：企业方案、待发布洞察、品牌介绍、咨询与隐私说明。
- 所有中文页面具有 `/en` 对应页。未知路径返回 404；构建后的页面含完整 HTML，不依赖 JS 才有正文。
- `src/content.ts`：双语业务与需求映射；`src/render.ts`：共享预渲染/浏览器模板；`src/main.ts`：菜单、需求选择与咨询交互；`src/motion.ts`：装饰性粒子与滚动进度；`server/server.mjs`：独立邮件边界，不挂载客户 API。
- `src/page-content.ts` 和 `src/page-sections.ts`：产品、专题、五业务各自的流程/输出、相关入口和可展开常见问题；`src/pages.css`：延续蓝白山水的内页样式。方案与品牌介绍包含合作路径。构建时检查全部内部链接与锚点，不允许空跳转或缺失目的页面。

映射固定为 AI→数智/智库、决策→沙盘/智库、团队→财智/沙盘、咨询→智库/财智、海外→外贸/智库。需求通过白名单 query 参数传入方案与咨询页面。产品区明确为视觉概念，未连接真实产品界面。没有伪造文章、客户、成果数字、二维码、联系方式或下载包。

## 视觉与动效

首页开场复用 `frontend/src/desktop/startup-splash.css` 的原子、光迹、核心和Logo关键帧，在 `src/brand-entry.ts/.css` 独立适配为蓝白色；不改应用启动流程。原动画概念预览位于 `../docs/design-audit/2026-09-07-erp-redesign/startup-motion/preview.html`，它是HTML动画而非视频。

开场由普通页面滚动驱动：桌面轨道250svh、手机220svh，向下推进、向上回退，停住即保持当前关键帧。前72%映射原动画8.75秒时间线，64%–80%逐渐显露山水首页，随后标题、说明及按钮依次出现；结束后自然进入正文。暂停动态或系统减少动态时直接展示静态首页，不要求滚动播放动画。`intro.css` 管理该滚动布局，正文五业务的手机布局仍为普通内容流。

参考黄雀官网的玻璃导航、居中首屏、全屏滚动叙事和粒子聚合方式；不复制其素材、品牌、文案或代码。蓝白设计稿位于 `design/`。原子 Logo 使用仓库品牌素材完整展示；三条轨道和三个原子随滚动向 Logo 收拢，核心短暂脉冲，文字和按钮依次入场。

桌面五业务场景使用固定视窗和普通页面滚动进度，粒子在轨道、经营曲面、学习展开面、立体结构、球体之间插值，响应鼠标扰动。无滚轮劫持。手机使用普通内容流；`prefers-reduced-motion` 和页脚开关关闭动画并展开全部业务。粒子数量、像素比有上限，离屏/隐藏页面暂停，未激活场景不可聚焦。

兼容验收：2026-09-23 使用静态 Pages 包在 Chromium、Firefox、WebKit 的桌面 1280×720 和手机宽度 390×844 分别验证首页滚动前进/回退、产品总览到智能获客详情、咨询页明确未开放且无表单、系统减少动态效果、无横向溢出及无页面脚本错误；本机 Safari 桌面另做了可见交互检查。Playwright 的 WebKit 手机仿真不等同于真实 iPhone Safari；Edge 和真实移动设备仍需上线后实机抽查。

## 邮件与 CRM

运行环境私下设置 `WEBSITE_SMTP_HOST`、`WEBSITE_SMTP_USER`、`WEBSITE_SMTP_PASSWORD`、`WEBSITE_MAIL_FROM`、`WEBSITE_MAIL_TO`，可选 `WEBSITE_SMTP_PORT`（465 默认或 587）。TLS 至少 1.2，验证证书，不启用不安全兼容。不要把凭据写入 Git、命令历史或文档。未配置返回 503，前端保留输入并说明未发送；邮件服务接受收件后才返回 `sent` 回执，不伪造成功。

API 有前后端共享字段校验、隐私同意、隐藏字段、16 KiB 请求上限、精确来源白名单、单进程每连接 IP 每十分钟最多五次尝试。忽略不可信 `X-Forwarded-For`，反向代理部署需在边缘补真实客户端限流，否则所有代理请求共用一个额度。单机内存限流不是多副本限流。发送不自动重试；传输异常的页面提示不确定，不诱导重复邮件。

`createWebsiteServer({syncCrm})` 是可注入的 CRM 接口，目前不启用，无 CRM 外发。邮件为主回执，CRM 失败不触发重复邮件；将来接入时 adapter 必须拥有有界持久重试和脱敏监控。API 合同见 `../contracts/openapi/website-contact.v1.yaml`。

## SEO 与公开部署

静态官网现已通过 Cloudflare Pages 直接上传发布在 `https://shensi-ai-c4y.pages.dev/`。
公网页面可访问，但该临时地址仍按未配置正式域名的预览规则禁索引；咨询提交、
客户产品、运营后台和安装包均未随静态官网发布。

正式域名确定后，构建环境设置 `WEBSITE_PUBLIC_ORIGIN=https://真实域名`，生成 canonical、双语 alternate 与完整 sitemap；未配置时预览明确 `noindex`、robots 禁止抓取，sitemap 不编造网址。

公开部署前：配置已确认的收件服务、`WEBSITE_ALLOWED_ORIGINS` 精确 HTTPS origin、反向代理 TLS、边缘限流；按实际收件方完善隐私责任人/邮箱和保存期限，核对业务文案及二维码。Node 只监听环回，`WEBSITE_PORT` 默认 5691，由受控反向代理提供公网入口。仅静态托管时须单独接入同源咨询接口；构建产物是 `website/dist/`，不包括源码和凭据。

## 参考与素材

- [黄雀官网](https://huangquechuanmei.com/)：只借鉴交互和视觉组织。
- [Vite](https://github.com/vitejs/vite)：MIT、持续维护，复用仓库已锁版本，避免引入另一套工具链。
- [Astro](https://github.com/withastro/astro) 与 [Astro landing page](https://github.com/mhyfritz/astro-landing-page)：MIT，参考静态输出和内容组织；模板维护频率不等于安全审计，不复制代码。引入 Astro 对当前纯展示页会增加迁移和供应链成本，因此使用已有 Vite 加预渲染。
- 邮件复用后端已有 Nodemailer，开启受限 TLS，不引入外部脚本/CDN/第三方统计。
- `public/assets/shensi-logo.png`：现有品牌资产副本；`mountains.png`、`orbital.png`：内置 Image Gen 生成，提示词与设计检查见 `design/README.md`。
