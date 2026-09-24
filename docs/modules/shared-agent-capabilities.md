# 智能体共享能力

共享模型网关在每次提供商请求（含修复与重试）前重新读取平台企业权限。纳管企业必须有效、套餐已发布且未过期；智能体中心及财务委员会使用 `agents` 功能，星盘五角色使用 `decision`，获客模型使用 `acquisition`。读取失败拒绝请求，已返回结果的保存不重新发送模型请求。未纳管工作区保持原业务权限规则；普通成员权限仍独立校验。

兼容模型入口支持调用方指定功能，官方模型与自定义 Anthropic/Gemini/OpenAI-compatible 协议均在实际 HTTP 请求前复核。旧获客研究入口指定 `acquisition`；CRM 企业事实分析、邮件草稿与客户消息翻译指定 `crm`；连接模型检查使用 `agents`。此兼容入口没有 Growth 业务调用方。

目标：智能体中心六角色和星盘五角色使用相同技术底座，不统一人数、提示词、业务流程或写入权限。以下区分已接通能力和剩余缺口。

## 聊天附件与可溯源联网

聊天附件按账号、工作区、会话和角色隔离，使用短期资料引用；上传仅解析，文字提问才调用模型。新对话和清除解除引用，退出清空内存，过期不回退到其他财务来源。文件限制与接口见 `finance-document-reading.md`。

六角色聊天的“联网查资料”使用显式公开关键词和所选搜索连接。打开面板只读取连接列表；点击“联网并回答”才搜索并调用当前角色模型，不传聊天记录、附件、公司资料或长期偏好。现有百度、腾讯、Tavily、Serper、Brave、SerpAPI 真实搜索适配器可用；模型模拟搜索不在列表中。连接按当前账号/工作区校验，凭据只在服务端解密，模型权限及角色路由沿用现有网关。

`AgentWebResearchService` 最多选取5条去重的公开来源，返回标题、URL、搜索摘要、获取时间和 S1–S5 引用编号。模型只能引用本次来源；没有来源、搜索失败或模型返回未知编号时不生成成功结果。证据属于搜索索引摘要，不声称已抓取或验证全文。结果是独立只读回答，不自动写入企业事实、聊天附件、CRM或知识库。

关键词与已完成结果在同一会话的跨页访问中保留，各角色独立；新对话/切换历史会话清空当前角色查询，退出或工作区变化清空全部。停止、离开页面或切角色中止请求，迟到响应不恢复已取消结果，不自动重试。

入口文件：`backend/src/agent-web-research{,-runtime,-router}.ts`、`frontend/src/growth/agents/web-research.ts`。HTTP 契约见 `docs/API_INDEX.md`。后端服务/路由/受控模型网关测试和前端组件测试纳入根 `pnpm test`；双主题1440/390合成浏览器验证可用 `pnpm --dir frontend exec tsx scripts/test-chat-attachments.mts`。

| 能力 | 智能体中心 | 星盘 | 共用情况与缺口 |
| --- | --- | --- | --- |
| 模型连接/审计 | cfo-conversation、finance-document-model | finance-document-model | 已共用model-providers/runtime、gateway、call-ledger；中心角色路由策略不等于星盘当前活动模型策略 |
| 文件及来源 | FinanceDocumentService显式选取 | DecisionPreparationService多文件校对 | 共用finance-document-inspection和模型来源校验；来源选择/生命周期不同，不混入企业事实 |
| 工具/权限 | finance.council.run；获客独立确认入口 | 只读资料、确定性经营计算 | 授权边界保留，不因共用底座赋予模型写权限 |
| 任务状态/恢复 | CFO阶段流；会话CAS | 准备任务内存、保存报告持久化 | 未统一；进程重启不能恢复进行中的星盘准备任务 |
| 会话/历史 | CFO加密会话，其他五角色页面内历史 | actor/workspace加密不可变报告 | 历史对象不同；中心其他角色持久历史待补 |
| 确认长期偏好 | 六角色文字问答显式选用 | 本次经营方案显式选用 | 共用AgentOperatingMemoryService、经营领域API与前端面板；不应用到获客命令或语音 |
| 执行复盘 | 共用面板读取原星盘建议；advisor真实业务回执保留 | 已保存建议→人工计划→实际对照 | 同一个人复盘记录和CAS；中心聊天自身建议尚未结构化持久化为复盘对象 |
| 错误处理 | 取消、阶段错误、CAS | 取消、准备状态、CAS | 共用网关错误来源，业务错误码保留；不自动重放写入 |

## 增量设计

1. `backend/src/agent-operating-memory.ts`拥有唯一经营偏好/复盘实现；decision-memory保留兼容导出及旧HTTP入口。注册同一单例供中心使用；新增`/api/v1/agent-memory/operating`，未知领域404，现有表及密文身份保持，旧报告不迁移/改写。此表仅存`operating`领域，不创建其他领域档案；今后其他领域需要独立schema/namespace，不复用现金/利润类型。
2. `frontend/src/agents/operating-memory.ts`提供共用API与个人档案/复盘组件，两个入口实际消费。中心在“经营偏好与执行复盘”中编辑/保存档案、显式选用，并读取原星盘建议进行同一复盘。复盘依据仍从原报告读取，不将聊天文本伪装为预测或业务回执。中心独立聊天建议复盘仍是缺口。
3. 中心六角色通过`POST /api/v1/finance/operating-memory-question`显式携带领域/revision，服务端重新校验个人归属、启用状态与CAS。结构化取舍进入已有资料模型或已验证报表模型，并计入既有prompt hash；不是系统指令/企业事实。现金底线不进入中心数字证据，仍由星盘确定性核对。CFO保留原会话CAS，其他角色仍为页面内历史。切角色/新会话清除选用；获客命令和语音不读取它。没有自动学习或模型训练。
4. 之后补六角色持久会话与任务恢复适配；所有旧快照、既有六角色/五角色编排、星系、六模块和外联关闭保持。每阶段单独记录实际验收，不宣称能力全齐。

## 验证要求

- 旧decision-memory七项测试保持通过，共享入口同一revision、未知领域拒绝、不同actor/workspace隔离；关闭、删除与旧写冲突仍成立。
- 两个真实前端组件用隔离合成记录确认读、显式使用、保存计划/结果、确认采用；不在真实客户数据上产生外联或伪造建议。
- 根test/build/context/diff；文档同步。日常只用start-ui，不制作安装包。

## 参考与取舍

已核对[LangGraph](https://github.com/langchain-ai/langgraph)的namespace/人工介入/持久执行模式（MIT）和[Mem0](https://github.com/mem0ai/mem0)的个人记忆CRUD模式（Apache-2.0）。两个项目仍有公开提交/issue活动；活跃不等于安全审计。现有TS服务、加密CAS与调用账本已经覆盖本阶段基础设施，接入新框架会引入状态迁移和额外数据边界，因此只参考模式，不复制代码、不安装新依赖。
