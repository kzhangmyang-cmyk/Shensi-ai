# 财务原表读取与明细导入

## 使用入口

通用入口可多选或拖入一批文件：最多10份、合计5MB，逐份解析并显示成功/失败；失败可以单独重试或移除，不覆盖成功预览。新批次取消旧请求，旧响应不能替换当前列表。分析按钮使用勾选的成功资料集合，未勾选及失败文件不发送模型。合并引用为 `file:序号:原始引用`，报告附逐文件名称与hash；同一集合供智能体追问，不暗中只选最后一份。
仍保留总计2000项来源与模型上下文预算，批量按文件分配来源额度，超额明确标记省略；并非无限文档知识库。改变所选集合会使当页旧报告失效，需要重新分析后导出。完整入口清单见 [文件上传入口](file-upload-inventory.md)。

财务经营、ROI 经营分析和财务委员会顶部共用企业资料分析入口，接受原始 CSV/XLS/XLSX、可提取文字的 PDF 和 Word DOCX。选择文件自动只读识别；明确点击“使用当前模型分析并生成报告”才调用已配置的模型，不要求资料分类或三表齐全，不把每行自动当成获客费用。
ROI 资料缺少投入、产出、期间或归因依据时只给定性建议和缺项说明，不生成数值 ROI；既有批次 ROI 计算仍使用核验后的业务数据。
完成并通过来源校验的分析可下载 HTML，桌面版通过既有 PDF 导出桥导出 PDF；报告包含文件名、原文引用及来源位置。报告在当页内存中保留，需导出保存，不自动成为正式委员会历史记录。

模型报告校验失败不表示文件上传失败。共享入口显示固定诊断类别：无效JSON、字段结构、来源引用、正文引用/数量、输出长度或数量限制；文件勾选和来源保留，前端不自动重试。网关既有单次格式修复仍保留。调用审计的`error_json.validationReasons`仅存这些类别，不存模型正文、文件原文或任意校验路径。旧记录只有错误码时不能推断具体原因。多文件提示明确要求完整`file:N:`引用，并说明报告条数、模板长度和引用数量上限。
财务经营的“结构化入账与字段映射（可选）”独立折叠，正式三表专项流程也独立保留；这些写入和计算校验不作为通用资料阅读的前提。
阅读模式显示来源摘要、原始位置、原文和缺项；“让 AI 读取”按钮与状态位于摘要顶部，原文默认折叠，可展开核对。
点击“让 AI 读取”使用当前配置的模型；可以直接向六角色提问，CFO 语音使用同一份选择。
缺少现金流量表、单位或期间不阻止阅读已有资料，但不能推断缺失金额、利润、现金流或跨期可比性。
所有待确认代码都显示为中文非阻塞提示；未知代码不直接展示给用户。

| 格式 | 只读支持与来源位置 |
| --- | --- |
| CSV/XLSX | 原始行列、同 sheet 多区域；利润科目只在“项目”列按完整标签识别，允许行项序号和“减：”前缀，不匹配备注全文，不改原值 |
| XLS | 只读支持 OLE/BIFF 旧版 Excel、UTF-8/UTF-16LE 静态 HTML 表格及 Excel 2003 SpreadsheetML；按文件签名识别，保留中文、多工作表及原值。不执行公式或宏，拒绝宏工作簿、活动HTML、实体声明和外部资源指令；不支持任意文本改后缀、加密工作簿或所有历史编码 |
| PDF | 只提取现有文字层，按页码及该页文本项引用；不推断表格单元格或已验证三表 |
| DOCX | 正文段落及正文表格单元格，引用段落序号或表格/行/格序号；不虚构 Word 页码或 Excel 坐标 |
| 扫描/纯图片 PDF | 本轮不运行 OCR，无可提取文字时明确提示提供文字版或先 OCR，不标记读取成功 |
| DOC、加密文件 | 旧 DOC 需另存 DOCX；加密 PDF 需由用户解密后重试，不猜密码 |

要写入成本或财务事实时，仍只接受 CSV/XLSX；明确选择对应明细用途，核对列映射与预览，再确认写入账本。
空映射自动匹配英文键、中文列名、明确别名和系统下载的双语模板；显式列映射优先。
歧义列不自动取第一列。错误按字段和原因分组显示影响行数、部分行号与修复说明；接受行数为零不可提交。
明细日期与金额使用既有解析和整数精度规则，不因自动识别猜测日期、币种或补金额。

## 数据流与权限

```text
原始 File → POST /api/v1/finance/documents/inspect
  → CSV/XLSX: secure-spreadsheet-artifact → 同 sheet 多区域识别
  → PDF/DOCX: secure-finance-document-text → 有界只读文字提取
  → 原始来源预览 → 明确 readWithModel:true → 当前工作区模型快照 → 带来源引用的观察
  → 前端内存选择 documentId → 现有 /finance/cfo-conversation
     → exact documentId + actor/workspace 校验 → 选中角色方法 → 只读来源回答
```

- 请求只接受文件名、媒体类型、Base64 原文件和 `readWithModel`，不接受调用方声明的归一化财务事实。
- 纯识别允许 `ledger.pending.create` 或 `finance.council.run`；AI 读取与问答必须有 `finance.council.run`。
- 只有明确阅读操作选定短期资料；浏览器只在当前登录/工作区内存保留来源标识，不写 localStorage。
  普通页面切换保留当前来源，账号或工作区变化、退出登录时清除；页面清理只销毁上传文件句柄。
- 后端保存有界解析结果，不保存原文件；有效期一小时，同一 actor/workspace 的新选择替换旧选择。
  活跃容量默认 64 个 scope、总计 16 MiB，过期数据回收。明确 ID 已失效、被替换、被取消或因重启丢失时返回资料不可用，不改读旧三表。
- 问答的 `documentId` 为非空字符串时只读该资料；`null` 或旧调用省略该字段时使用既有已确认报表语义。
  `DELETE /api/v1/finance/documents/selection` 仅清除当前 actor/workspace 选择，拒绝 body/query，返回 204。
- 文字和语音携带同一来源 ID；桌面 Main 在开始语音时冻结 ID，每轮重新核对账号和工作区权限。
  模型只能给出问题，不能选择或改写资料 ID。取消来源后显式切回已确认报表。
- 原始资料不变成 `BusinessReport`、已验证三表 package 或台账。正式委员会分析仍使用已确认三表。

## 原值与模型边界

安全解析器保留既有 `rows` 顺序/压缩方式和明细身份算法，额外提供一基原始行列坐标。
XLSX `!ref` 在遍历前核对行列预算；CSV 坐标是逻辑记录/字段，不是引号内换行的文本行号。
只读资料最多保留 2,000 格、每格 500 字、200 个区域；超出部分明确标注省略，不用截断值冒充原值。
`cell:<工作表序号>:<原行>:<原列>` 与原文件 hash 共同确定来源；左右列、累计/本季和期末/年初不合并。
PDF 使用 `pdf:<页>:<文本项>`；DOCX 使用 `docx:p:<段落>` 或 `docx:t:<表格>:<行>:<格>`。
这些来源在同一 `cells` 联合类型中按原格式给出字段，PDF/Word 不填造 `sheetName`，也不伪装成已验证报表区域。
PDF/Word 单项或段落超过 500 字时分段保留，引用追加 `:s:<片段号>`，附带 `segment`、
`startOffset`、`endOffset`（原文零基 UTF-16 偏移、末端不含）。逐段拼接还原原文，不截断代理对、不吞空白；
总来源达到 2,000 项后仍明确标注省略。Word 表格坐标是 OOXML 表格行内的单元格顺序，合并布局单独提示待核对。

不执行公式、宏或外部链接。公式已有缓存时可作为“工作簿缓存显示，未重算”阅读；没有缓存保持未知。
SheetJS 的无缓存公式 stub (`t:z,v:0`) 不当作实际零。明细入账仍保留原有公式拒绝规则。
Word 域仅保留文件中的可见缓存文本，标记 `docx_field_cache_unverified`，不执行字段指令或重新计算。
DOCX 只读取主正文/表格，不读取页眉页脚、脚注、图片或嵌入对象；嵌套表格省略，已识别省略和合并布局显示中文提示。

PDF/DOCX 解析在可终止 Worker 中进行：10 秒、256 MiB V8 old-generation heap（不是进程总 RSS 保证）、
5 MiB 原文件、100 页 PDF；DOCX 最多 1,000 ZIP 条目、声明展开总量 20 MiB、实际主 XML/内容类型各 4 MiB。
ZIP 懒读取与实际长度验证、严格 XML 命名空间及实体解析共同约束输入；拒绝 DOCTYPE，不跟随外部关系。
PDF 字体与 CMap 只从部署的 `pdfjs-dist` 包加载，路径经过 URL 到文件系统解码，支持中文目录。

模型上下文按区域、问题与角色选择完整行，优先保留各区标题、列头、单位/期间原文与相关科目。
PDF/Word 用有界问题词匹配相关文本项，先保留命中项及附近来源，再补其余原文；长段落不会因超过短科目长度而失去排序资格。
这条文本规则不改变 Excel 短科目识别。模型来源预算为 45,000 个 JSON 字符，超出时只省略完整来源项，不切断其中原值。
上下文中的 coverage 明确区分“原表未识别到”和“原表存在但本次未传入”的内容。
所有工作簿文本均为待核对的数据，不执行其中指令。六角色复用现有职责/方法提示，不要求先通过完整三表事实门禁。
数值输出使用已知 `{{cell:...}}`、`{{pdf:...}}`、`{{docx:...}}` 占位符，服务端替换为来源原文，拒绝不存在的引用、编造数值和擅自改单位。
正常中文的“进一步”“统一口径”“不一定”不按数量误拒绝。
出站消息明确要求 JSON 对象并给出 `observations` 格式示例，与网关的 JSON 输出模式一致；
仅设置 `response_format` 不能替代模型提示词中的输出格式要求。
引用校验能核对原值与位置，不能证明模型的科目理解、所选引用或因果解释一定正确。

## 复用决策

参考 [Tableflow CSV Import](https://github.com/tableflowhq/csv-import) 与
[React Spreadsheet Import](https://github.com/UgnisSoftware/react-spreadsheet-import) 的表头选择、别名映射、预览和少量确认流程；两者采用 MIT。
前者提供 React/JavaScript 接入，后者依赖 React/Chakra/Emotion 等 UI 体系。
本轮不引入它们的解析器或整套组件，不复制其源码；沿用已有安全解析边界与黑绿界面，避免新增依赖和双重解析语义。
原始表格结构依据 [SheetJS 导入说明](https://docs.sheetjs.com/docs/getting-started/examples/import/) 与
[解析选项](https://docs.sheetjs.com/docs/api/parse-options/) 校核。

PDF 复用 [Mozilla PDF.js](https://github.com/mozilla/pdf.js) 的 `getTextContent`，而非自己解析 PDF；
固定 `pdfjs-dist` 6.3.289（Apache-2.0），其 Node 要求与项目 Node 22.22.3 基线兼容。
Word 复用 [yauzl](https://github.com/thejoshwolfe/yauzl) 3.4.0（MIT）懒读取 ZIP 和
[sax](https://github.com/isaacs/sax-js) 1.6.1（BlueOak-1.0.0）读取 OOXML 结构。
比较的 [Mammoth](https://github.com/mwilliamson/mammoth.js) 面向 HTML/图片转换，AST 转换接口不稳定，
不适合本入口的原始结构引用；未引入该转换层。
项目已有前端 Tesseract 与 Sidecar OCR 服务不同于文档解析；扫描 PDF 要先页面渲染、OCR、语言/来源标注，
不能仅复用“已安装”状态宣称支持。旧 DOC 是另一类二进制格式，本轮要求用户另存 DOCX，避免依赖额外 Office 运行时。
依赖许可证和安全说明见 `docs/THIRD_PARTY_NOTICES.md`。

## 验证入口

```bash
pnpm --dir backend test:finance-documents
pnpm --dir backend test:growth-finance:imports
pnpm --dir backend test:cfo-conversation
pnpm --dir frontend exec tsx src/growth/finance/api.self-test.ts
pnpm --dir frontend exec tsx src/growth/finance/import-workflow.self-test.ts
pnpm --dir frontend exec tsx src/growth/finance/view.self-test.ts
pnpm --dir frontend exec tsx src/growth/finance/document-selection.self-test.ts
pnpm --dir frontend test:finance-document-runtime
pnpm --dir frontend exec playwright test --config=playwright.finance-import.config.ts
pnpm --dir desktop exec tsx --test tests/cfo-realtime-service.test.ts tests/cfo-realtime-ipc.test.ts tests/cfo-realtime-config-flow.test.ts tests/renderer-server.test.ts
```

自动测试只使用合成文件、隔离 HTTP 和受控模型返回。真实原始文件、供应商回答与原生 UI 的验收状态见 `docs/PROJECT_STATUS.md`。

## 开发实例加载与原生验收

完成门禁后只加载最新 Backend 源码、`desktop/dist` 和 `frontend/dist-desktop`，不生成安装包。
主验收负责使用已有受控启动器重启，保留当前数据库、登录资料和三项外联关闭设置。
更新前原窗口保持不动；浏览器的 File 句柄不能跨 Renderer/应用重启保留，也不应为此把客户文件写入缓存。
新实例恢复财务页后重新选择同一个原文件，核对文件名与大小；默认请求必须为 `readWithModel:false`。
先核对上下区域、原行列与缺项，不能再出现把整份报表逐行当作费用的通用错误。

PDF/DOCX 的原生读取使用合成夹具，通过应用正常文件选择器操作：核对中文、PDF 页码、
Word 段落/表格位置、同格多段落和长段落末尾；空白页不造内容，纯扫描件显示先 OCR 的提示。
自动预览必须显示尚未请求 AI，AI 主操作位于默认折叠来源之前；最后恢复原 XLSX 的只读预览。
无需用户提供 PDF/Word 才能验证格式支持。最新实例、已通过结果和原生证据统一记录在
[`docs/PROJECT_STATUS.md`](../PROJECT_STATUS.md)，文档收尾不需要再次重启应用。

真实模型验证先用纯合成文件：一次 CFO 试读检查正常中文、原格引用及缺项说明；不使用客户原文件，
不提交账本、不启动正式委员会分析。核对从财务页“向智能体追问”跨页后的来源名称和 ID，
文字与语音选择一致；明确取消后显示已确认报表来源，过期 ID 显示需重新读取，不自动换资料。
客户原文件的模型读取必须另行明确执行，不能由前述纯合成验证代替或顺带触发。
