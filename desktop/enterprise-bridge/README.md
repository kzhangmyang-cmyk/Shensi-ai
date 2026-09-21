# 企业查询本机桥接（macOS 开发版）

Chrome 扩展在用户点击后读取爱企查 `/s` 当前页已呈现卡片，通过 Native Messaging 写入当前 macOS 用户私有预览文件；最新 Electron 的企业查询页由用户点击读取。没有自动翻页、Cookie/Profile 读取、云端传输、客户保存或外联行为。单次最多40条，仅保留最近一批，按来源URL与企业名称去重；30分钟后拒绝过期预览。没有href的企业卡片使用搜索页作为来源，不编造详情ID。搜索总数不是可读取数量。

## 构建与安装

1. 仓库根目录运行 `node desktop/enterprise-bridge/build.mjs`。输出 `desktop/enterprise-bridge/dist/`，不生成 App/DMG，不改变浏览器权限。
2. 用户在 Chrome 扩展管理页启用开发者模式，选择“加载已解压的扩展程序”，选输出目录里的 `extension`。权限为爱企查域页面读取/脚本及本机通信；不请求 cookies、history、downloads 或全部站点访问。
3. 复制扩展管理页显示的扩展ID，在终端运行 `node desktop/enterprise-bridge/dist/install.mjs <扩展ID>`。只注册这一个ID，不使用通配来源。安装使用当前Node绝对路径，Node需保持可用。
4. 保留现有Chrome登录，在爱企查搜索结果页打开扩展，点击“发送到本机预览”。进入最新源码Electron的企业查询，点击“读取浏览器预览”。预览展示实际数量、来源、读取时间；关闭预览不会保存客户。正式入池不是此阶段功能。

本机文件在 `~/Library/Application Support/ShensiEnterpriseBridge/`（目录0700，预览0600）。Chrome注册文件在其用户级 `NativeMessagingHosts/com.shensi.enterprise_preview.json`。扩展卸载在Chrome中操作；需要完整卸载时仅移走这两个明确目标，勿删除Chrome目录或用户Profile。浏览器无需重登，也不需要远程调试开关。

## 边界与验证

页面出现登录、验证码、无可识别卡片或改版时返回错误，不假报空结果。当前解析器按可见详情链接和字段标签读取，不获取隐藏应用状态。会员限制不解锁、不改请求参数。预览仅属于本机用户，不是业务账号云端数据。

真实Chrome扩展已安装在 `/Users/mac/shensi-enterprise-extension`，ID `dcbilmbopimhaklodabkemgnkaeojcie`，本机宿主已注册。2026-09-14真实当前页10家已通过扩展→宿主→源码Electron预览，名称、法人、资本及成立日期核对一致。当前解析只读 `.items` 企业卡片，排除页脚；不会连接站点调试器。地址末尾风险统计的截断修正已同步安装目录，但用户操作浏览器中断了最后刷新重取，尚待该字段复验及截图。现有运行实例用 `start-ui` 禁用外联执行，不保存客户。

Chrome安装器和Native Host不在Electron包内容清单内；共享 `extension/capture.js` 同时用于内置浏览器，并复制为 `dist/main/enterprise-capture.js`，与main/preload/shared一起纳入桌面源码构建身份。第一轮全仓 `pnpm test`、`pnpm build`通过；解析修正后针对性测试及源码桌面构建通过。

企业查询也可直接“打开爱企查”，使用独立无Node权限的Electron窗口。该试点无需Chrome或扩展，首次本人登录，按Shensi后端/账号隔离持久会话；仅显式读取当前搜索页进入本机预览。网站登录兼容性须真实验证，不能从Chrome成功推断Electron成功。当前实现依据 [Electron安全指导](https://www.electronjs.org/docs/latest/tutorial/security)，未通过关闭webSecurity、反调试绕过或复制Cookie处理网站限制。

## 产品条件查询

默认非会员入口 `shensi:enterprise:search-local` 仅接受2–200字关键词，复用本人会话打开普通 `/s?q=...` 并等待当前可见页读取，自动回传产品主列表/详情。它不执行地区/行业条件，前端在入口和结果反馈中明确标注。不重试高级接口、不付费、不读取Cookie。原有打开窗口与显式读取作为登录/验证及手动原始详情兜底。

`shensi:enterprise:next-local` 仅接受当前搜索批次ID，同账号/窗口/关键词绑定。用户每次点击加载更多，仅操作可见原生下一页并等待下一页号与卡片变化，逐页校验后交前端去重追加。待完成页重试不再次点击，失败不清已有结果；新搜索或身份变化使旧批次失效。65103原生验收“塑料”四页40条去重39家，第五页权限限制停止；“橡胶”新查询清空旧批次。证据见当前状态文档。

2026-09-15源码59460已原生实测输入“塑料”自动回传10家，点击大连塑料研究所有限公司显示法人、资本、成立时间、地址及网页遮蔽电话，未点手动读取，也未入池。来源截图 `/tmp/shensi-enterprise-nonmember-list-detail.png`；根测试/构建及17项企业前端、7项Main/契约、6项解析测试通过。当前真实高级结果权限阻塞与非会员普通搜索通过是两项独立结论。

`shensi:enterprise:query-local` 只接受关键词、最多两级地区/行业名称路径。Main执行固定 `enterprise-query-page.ts`：在高级页按网站已显示的精确名称选择、核验选中状态并提交，然后复用可见DOM读取脚本回传。每一步检查同一账号/窗口代数；并发查询拒绝，超时不重发查询。省市目录的覆盖不表示网站支持所有地区；缺失同名选项停止，不默认全国。行业四级目录不等于网站高级搜索深度，站点目前仅两级，不自动退到父类。

高级页行业摘要只显示父类，即使仅一个二级节点被选中，因此核验使用展开树的真实checkbox，而非摘要文本。省份行点击会全选下属城市；选择城市时须清除这次宽泛勾选再选目标城市，并验证完整省市标签。来源证据为2026-09-15原生页面及官方公开前端 `advancesearch` 的控件结构，不使用接口参数、Cookie或私有状态。

2026-09-15当前普通账号在郑州/橡胶和塑料制品业筛选后要求开通高级搜索会员。此权限不由Shensi绕过；该账号不能用于宣称高级查询结果成功。结果页解析支持网站 `.advancedsearch-result .items` 已呈现卡片，排除页面样例区，成功回传仍需具备相应网站权限。普通当前搜索/详情显式读取入口保留。

测试：`pnpm --dir desktop exec tsx --test tests/enterprise-browser.test.ts`；`node desktop/enterprise-bridge/build.mjs && node --test desktop/enterprise-bridge/test.mjs`；`pnpm --dir desktop build`；`pnpm --dir frontend exec tsc --noEmit -p tsconfig.json`。

## 参考与许可

参考 [Chrome Native Messaging 官方协议](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)及[官方示例仓库](https://github.com/GoogleChrome/chrome-extensions-samples)（Apache-2.0）。实现独立编写，没有复制示例代码或 `astrbot_plugin_bizjob` 源码；后者MIT，仅用于接口核验。本桥不调用它的验证受限JSON入口。
