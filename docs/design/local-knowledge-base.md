# 本地参考知识库与六角色问答设计

日期：2026-10-06。阶段：初版范围及书面设计已获用户确认，[实施计划](local-knowledge-base-implementation.md) 待审核及执行方式选择；尚未实现。
本文件描述待实现功能，不替代 `docs/PROJECT_STATUS.md` 的实际进度。

## 1. 目标与范围

用户可在 Shensi 上传书籍、文件及公司内部资料。六角色文字提问先检索有权限的相关知识，再由当前配置的模型结合实际情境分析，输出详细回答和可定位的来源。书籍是参考材料，不是硬性指令、现行法规证明或已核实的企业事实。

第一版交付独立知识库页面、持久文件与版本、解析任务、中文检索、六角色文字问答及引用。使用最新前后端和本地桌面运行，不恢复旧界面、不迁移旧数据库、不新增 App/DMG。云同步、跨设备共享、向量数据库、额外 embedding Key、模型训练、自动写入企业账目和其余五角色完整持久会话均不在本阶段。

现有六角色职责、模型路由、财务事实校验、临时附件、报告及委员会流程保持。实时语音本阶段继续现有简短回答协议，不直接播放新增详细参考回答。

## 2. 现状与复用选择

| 现有部分 | 实际能力与接入边界 |
| --- | --- |
| `backend/src/finance-document-service.ts` | 进程内解析结果，一小时过期；不保存原件。不能直接改名为持久知识库。 |
| `backend/src/types.ts` 的 `KnowledgeAsset` / legacy `/api/knowledge/assets` | 只有标题、分类和发布元数据，没有正文、文件或索引；不沿用其全表快照存储及默认团队权限。 |
| `FinancialCouncilAgentCenter.ask`、`cfo-conversation.ts`、`finance-document-model.ts` | 真实六角色入口、模型和数值校验可复用；新增参考证据依赖，不把书籍塞进 verified facts。 |
| CFO 会话仓储 | 现有 workspace＋actor、加密和 revision 模式可借鉴；现有历史只支持 CFO，不能宣称其他五角色已有重启恢复。 |
| 文件交互与桌面代理 | 可复用逐文件状态和上传交互；现有附件 5MiB/100 页及代理请求预算不适合长书，知识库必须有独立入口。 |

采用“现有本地 MySQL＋私有原件目录＋轻量服务端检索”，不接入另一整套聊天产品。已对比 [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) 的本地文档问答和 [RAGFlow](https://github.com/infiniflow/ragflow) 的文档解析/检索部署。两者分别为 MIT、Apache-2.0；本项目已有认证、六角色与模型配置，整套引入会新增重复集成，RAGFlow 的部署要求也不适合此阶段的轻量桌面范围。此为适配判断，不是第三方安全认证。

检索采用 [MiniSearch](https://github.com/lucaong/minisearch)（[MIT](https://github.com/lucaong/minisearch/blob/master/LICENSE.txt)）：可在 Node 内运行、无外部依赖、支持字段权重和增删。其默认分词不能直接处理无空格中文，索引和问题采用相同的 `Intl.Segmenter('zh')` 归一化，并复用现有中文源文观察匹配思路。第一版是中文关键词检索，不冒充语义向量检索；同义提问和专业术语必须单独验收。版本按实施时核验的官方 package/lockfile 固定，不用 GitHub 页面星数或活动量替代依赖审核。

长 PDF/OCR 使用独立本地 [Docling](https://github.com/docling-project/docling) 解析适配器，借鉴其[结构化分块](https://docling-project.github.io/docling/concepts/chunking/)，不自行重写 OCR。保留已有提取结果，产品运行不硬编码本次预处理的临时 venv 路径。依赖、模型资源及许可证在实施阶段固定和登记；不调用远程文档解析服务。

## 3. 页面与数据流

左侧在智能体中心附近增加 `#knowledge`“知识库”，复用现有壳、DOM 模块路由、黑绿/蓝白主题，不引入第二套前端框架或共享 inspector 残留。

- 顶部：搜索、上传资料；第一版格式为 PDF、DOCX、XLSX、CSV、TXT、MD。暂不承诺 EPUB、图片集、宏或旧二进制 XLS。
- 列表：文件名、分类、适用角色、版本、更新时间及真实处理状态。支持启用/停用、替换版本、重试及删除。
- 详情：原件信息、正文预览、页码/章节/表格坐标、覆盖和待核对提示。宽屏列表＋详情，窄屏独立详情。
- 上传：最多同时选十份、逐文件排队；区分“上传完成”“解析完成”“可检索”。没有可计算的总量时不显示虚假百分比。
- 问答：自动检索启用资料；显示命中来源与“知识库参考”，可以打开同版片段。无命中、解析未完成和检索故障分别说明，不伪装成有来源的回答。

```text
上传文件 → 本地私有原件 → 持久解析任务 → 带来源片段 → 中文索引就绪
提问 → 认证/工作区/角色过滤 → 检索相关片段 → 当前角色模型 → 详细回答＋来源
```

上传、解析、索引不自动调用回答模型。每次回答只向用户配置的回答模型发送问题、必要企业证据和少量命中片段，不发送整本书。知识库原件和片段不进入公共搜索服务、GitHub、分析遥测或客户安装包；并非承诺云端回答模型完全离线。

## 4. 持久化、版本与权限

新增独立知识库仓储，不重建数据库。MySQL 保存 document、不可变 version、chunk、ingestion job；原件用服务端生成的 opaque storage key 存入私有目录。正文和敏感元数据采用带归属 AAD 的加密 payload，原件采用独立二进制加密文件适配器，不把大型二进制塞进现有 JSON 加密 API 或 64KiB 的 Main private-storage。

Backend 当前没有通用原件 root。新增 `SHENSI_KNOWLEDGE_STORAGE_ROOT`，由可信启动器配置绝对路径：独立应用从现有 `paths.userData` 派生 `knowledge/`，源开发运行从 `.runtime/desktop-local/` 派生私有目录；不使用源码、public、release 或浏览器 Profile 目录。目录 0700、文件 0600，禁止符号链接逃逸及 Renderer 指定路径。缺少 root 或持久密钥时只禁用知识库并明确原因，不破坏其他模块启动，也不退回随机密钥。

第一版资料默认为当前 workspace＋上传者 actor 私有；个人与企业工作区彼此隔离，同企业不同账号不自动共享。分类“公司资料”不授予其他成员读取权。角色标签仅限制六专家的适用范围，不是账户授权。跨用户发布/共享不在初版。

独立能力为 `knowledge.read`、`knowledge.upload`、`knowledge.manage_own`，沿用已认证工作区的服务端能力分配。不得通过上传扩大 `finance.council.run`；六角色问答仍遵循现有问答权限。list、download、preview、retrieve、delete、worker 发布和引用取回都复核真实身份；客户端不能声明 owner 或工作区归属，拒绝聚合工作区 `all`。

每版保留 source hash、格式、解析器版本、页数/覆盖、片段顺序、物理页/章节/偏移/表格坐标和提取限制。自动识别章节不冒充已核验目录。替换文件创建新版本：旧有效版可继续使用，新版完整提交并可检索后原子切换。失败不覆盖旧版。

停用立刻排除未来检索；删除先撤销访问并取消未完成任务，再清理库内片段/缓存/本地副本，不删除用户原路径的文件。CFO 已有历史可保留当次有限引用快照；停用不修改过去回答，删除后不再打开原件，历史注明来源已删除，快照随用户删除该会话清除。

## 5. 解析任务与检索

独立上传路由使用有界流式文件接收，不提高整个 Backend 或 Electron 网关的请求上限。单文件上限 50MiB、PDF 上限 1,000 个物理页，能容纳本批书籍；超限、需要口令且无法正常读取、伪造格式、ZIP 膨胀或异常 XML 明确失败，不执行宏、字段、外部关系或文档内指令。带加密标志但可直接正常读取的 PDF 使用普通解码，不因解析依赖缺失误判为口令限制，也不绕过口令保护。

状态为 `queued → parsing → indexing → ready`，另有 `failed/cancelled`。持久任务一次一个解析 worker，使用隔离进程、分页处理和可取消总时限，原件解密仅发生于私有临时目录。重启按任务租约恢复；取消、停用、删除与新版本 fencing 防止晚到结果复活资料。只有完整版本发布后才能进入问答；部分提取必须记录覆盖缺口。

有正文的 PDF 优先正文提取，扫描页走本地 OCR。文字可索引，但不可靠 OCR、表格和公式携带待核对标记，不能作为精确财务计算或现行税率证据。CSV/XLSX 保留表格坐标与公式缓存状态；TXT/MD 保留行号，DOCX 保留段落/表格坐标，不臆造分页。

现有 21 份 PDF 的源身份和 4,742 个物理页覆盖已核验，但没有证明全书逐字正确。首批导入复用本地结构化结果、继承质量标记，重新关联真实文档版本和页码；不重复 OCR、不用估算全文生成 token 数作为入库前置条件。原文件本来缺失的章节不能补写。

MySQL 是资料事实源，MiniSearch 索引是可重建缓存。索引按 workspace＋actor 的授权集合建立，取回片段时再次检查版本、权限、启用状态；角色过滤在排序前应用。缓存失效不意味着资料丢失，索引重建不调用模型。服务端按需载入、有界分页，不把全库发给 Renderer。

每次最多取六个去重片段，合计不超过 12,000 字符，按题目/章节/正文相关度排序；提供不足时明确无有效命中，不因“知识库优先”强塞不相关资料。只有检索就绪的授权版本参与，检索器故障与无命中是不同状态。书籍参考、企业资料陈述和已核实企业财务事实使用不同证据类型。

## 6. 详细回答与来源协议

提问入口先检索，再保留当前显式附件或已核验报表的选择规则。已核实企业数据和用户本次明确选定资料优先解释企业现状；书籍补充方法与适用条件，不静默覆盖企业数据。资料矛盾或缺少主体、期间、地区时指出冲突并追问。

知识库材料作为不可信参考数据传给模型，不进入 system instructions；文档中的“忽略规则”、外发、读取其他文件或执行命令均无效。公开搜索继续只接收既有允许的公共主题，不接收原件、命中正文或企业内部信息。

保留旧 `answer` 简短字段和数值校验。新增可选的独立知识回答投影，详细正文上限 12,000 字符，来源由服务端合法命中片段生成；同步生成合同、前端显示和 CFO 历史的可选快照，不简单放宽所有聊天/语音/财务 schema。

模型可以解释、比较和建议，但书中数字、年份、公式及案例金额必须经受限原文引用显示，不能转成 `{{fact:id}}` 的企业事实，也不能通过关闭数值校验让模型自由编造。回答尽量包含“结论、参考依据、结合情况的分析、建议及缺失信息”，不强制无关长模板。

引用至少包含 documentId、versionId/hash、chunkId、来源名、物理页/章节/坐标、精确片段及不确定性。模型只能引用本次提供的 source IDs，未知引用失败；原件链接由授权 API 生成，不接收模型生成的 file:// 或任意外链。税法书籍仅是历史参考，现行适用性需当前权威依据，找不到则保持未确认。

## 7. 修改边界

以下是拟议实现范围，不是已有文件或已完成接口：

| 范围 | 准确接入位置 / 新模块 |
| --- | --- |
| 数据、任务、文件及检索 | 新增 `backend/src/knowledge/`；经 `server.ts` 调用的 `growth-commercial-composition.ts` 和 `growth-commercial-application.ts` 接入，SQL 初始化在新模块 `install()`，知识服务先于 Council 装配；新前缀纳入统一鉴权，不改 legacy 资产语义。 |
| 本地解析 | 新增 `services/knowledge-reader/`，与浏览器/MediaCrawler 生命周期分离，不改抖音执行器。 |
| 问答 | `backend/src/financial-council-agent-center.ts`、`cfo-conversation.ts`、`finance-document-model.ts` 及 `cfo-conversation-session-repository.ts`。 |
| 合同 | 新增 `contracts/openapi/knowledge.v1.yaml` 及对应生成目标；问答可选投影走 Growth 新版本发布，不修改已发布版本字节。 |
| 页面 | 新增 `frontend/src/knowledge/`；接入 `frontend/index.html`、`src/app-route.ts`、`src/demo/demo-types.ts`、`demo-router.ts`、`demo-app.ts`，复用现有实际模块壳而非旧演示内容。 |
| 引用与聊天 | `frontend/src/growth/agents/cfo-conversation.ts`、`cfo-chat-messages.ts`、`cfo-session-view.ts`；知识库引用与 public research 分开。 |
| 桌面与源开发 | `desktop/src/main/app-paths.ts`、`prepare-local-application.ts`、`local-application-runtime.ts`、`renderer-server.ts`；`scripts/desktop-local-runtime.mjs`，仅增加知识文件根目录及精确上传路由预算。 |
| 文档 | 实施时更新 README、PROJECT_STATUS、ARCHITECTURE、API_INDEX，以及知识库、资料读取、角色与上传清单的当前说明。 |

## 8. 验收与实施顺序

按合同/仓储与私有文件 → 解析和状态 → 页面和中文检索 → 六角色与引用 → 本批资料导入/实机验收推进；先书面设计确认，再形成有序实施计划。每步有独立测试，不以解析结束代替产品完成。

必须验证：重启后原件/版本/检索仍可用；跨账号/工作区检索、预览和原件均拒绝；旧版本/停用/删除后不再进入新回答；取消与晚到 worker 不复活资料；大文件与格式异常的真实拒绝；引用精确定位；中文术语和同义问法召回；无命中/检索失败区分；文档提示注入不改变职责；精确书籍引用与企业数值不串用；六角色和已配置模型路由都使用真实检索结果。

双主题在宽/窄窗口验证上传、排队、失败/重试、选中/停用、长回答滚动和来源打开。真实 21 份资料仅私有入库，抽查正文/OCR/表格缺失和页码，不把受控模型 fixture 当成真实回答质量验收。书籍自动归类只作可修改建议，用户可调整角色标签。

现有回归入口为 `pnpm --dir backend test:cfo-conversation`、`pnpm --dir backend test:finance-documents`、frontend 测试、desktop 网关/路径测试，以及根 `pnpm test`、`pnpm build`、`./scripts/context-check`、`git diff --check`。新增知识库专项命令随模块落地，不宣称现在已经存在或通过。首个实际入口在最新 `pnpm desktop:local` 开发窗口验证，不重复打包。
