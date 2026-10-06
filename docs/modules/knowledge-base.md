# 本地参考知识库

当前阶段：合同、领域、加密原件、MySQL 仓储、认证 HTTP 上传/查询、本地解析、中文检索及真实索引发布已通过专项和回归验证。最新 DOM 业务壳的独立知识库页面、完整前端与桌面代理回归通过；六角色问答、详细投影和历史引用通过完整问答/财务校验、六项知识页浏览器与双主题五宽度长回答回归。实施依据为 [设计](../design/local-knowledge-base.md) 和 [计划](../design/local-knowledge-base-implementation.md)，实际进度见 [PROJECT_STATUS](../PROJECT_STATUS.md)。

问答联合门禁通过58项知识库（另7项需专用MySQL配置）、57项CFO、55项原财务资料、28项网关和45项Growth回归，前后端类型/context/diff检查通过。实际 macOS 沙箱中的扫描页、正常可读加密标志、需口令拒绝、缺页、取消、撤权、旧租约、网络和无关私有文件读取限制均有合成fixture证据；锁定依赖与现有运行时版本一致。运行边界见 [reader README](../../services/knowledge-reader/README.md)。受控解释器的产品配置、真实书籍导入及完整应用/数据库重启验收仍未完成。

## 已实现边界

`backend/src/knowledge/domain.ts` 定义资料、版本、原文坐标和处理状态。仓储接口所有用户操作携带已认证的 `ActiveWorkspaceContext`，workspace＋actor 双重隔离，拒绝 `all`。角色标签仅决定六专家适用性，不授予账户访问权。

`MemoryKnowledgeRepository` 是领域测试替身，不是产品存储 fallback。命令验证幂等键和 revision；未收完原件不可领取任务，解析进入 indexing 后才可发布 ready。租约 fence、替换、停用、删除和取消阻止旧任务发布；替换就绪之前保留上一有效版本。

三个本人资料能力为 `knowledge.read`、`knowledge.upload`、`knowledge.manage_own`；它们不授予 `finance.council.run`。原件和正文不暴露存储 key、actor 或私有路径。

## 本地持久存储

`MysqlKnowledgeRepository` 仅幂等创建 `knowledge_documents`、`knowledge_versions`、`knowledge_chunks`、`knowledge_jobs`、`knowledge_commands` 五表，不迁移或删除现有业务表。资料 metadata、版本 metadata、正文片段和命令结果使用独立 AES-256-GCM 加密；可查询的 owner、记录标识、revision、处理状态及租约仅服务权限筛选和调度。每个写入事务锁定所属资料，复核 revision 与 worker fence/lease；ready 的版本发布和有效版切换在同一事务完成。

`createKnowledgeCrypto` 必须收到明确稳定密钥（至少32字符），以 HKDF 分离 metadata、原件和分页签名用途；没有随机开发 fallback。接入模块将消费本地安装的稳定 `AGENT_JOB_ENCRYPTION_KEY`。丢失该密钥不能恢复私有资料，不应自动替换密钥或改为明文。

`createKnowledgeFileStore` 使用可信的绝对 root，目录0700、文件0600、拒绝软链接和跨 owner 访问。原件按50MiB上限流式加密，附加数据绑定 workspace、actor、document、version、格式和原始字节数。消费者只能在 GCM 及 SHA-256 全部校验之后拿到临时原件；正常结束、解析异常或取消后 finally 清理私有临时目录。删除仅作用于 opaque key 对应的私有副本，不能删除用户上传前的原始路径。`KnowledgeService` 在数据库成功读回、证明新副本未被引用时补偿删除；提交结果不确定或数据库不可读时保留加密副本并返回 unavailable，不能自动重传或删除可能已提交的原件。该不确定分支尚无自动孤儿清扫器。显式删除先撤销读取，再清理本人副本；相同删除命令可手动重试清理。

Main 的 `paths.knowledge` 固定为 `userData/knowledge`，单机启动准备创建该私有目录并通过后端环境 `SHENSI_KNOWLEDGE_STORAGE_ROOT` 注入；源码开发 launcher 使用自身 `.runtime/desktop-local/knowledge`。生产、开发和测试目录互不共用。Renderer 不能指定此路径；源开发也不继承外部同名环境变量。现有安装凭据和业务数据库身份保持不变。

## 合同

独立定义在 `contracts/openapi/knowledge.v1.yaml`；共享公共 schema 为 `contracts/json-schema/knowledge.v1.schema.json`，前端使用生成的 `src/generated/knowledge.ts`。

支持上传格式 PDF/DOCX/XLSX/CSV/TXT/MD，单文件上限50MiB。资料 metadata 与原件字节分开提交，签名/文本编码验证通过及收完文件仅进入 queued，真实解析/索引未完成不能用于问答。公共 document 包含 activeVersionId 和 latestVersionId；版本包含自身 revision、opaque jobId 与真实状态。文档编辑/替换使用文档 revision，原件上传/重试使用版本 revision。

## HTTP 与桌面传输

`createKnowledgeModule` 在财务委员会之前安装，注册私有 `KNOWLEDGE_SERVICE`，只有真实 MySQL＋可信 root＋稳定密钥才启用；缺配置只使知识库 unavailable，不使用内存 fallback。现有平台功能授权仍适用（当前沿 CRM 功能门禁），没有新增授权绕过。

`/api/v1/knowledge` 接入既有 requireAuth、Cookie CSRF 及真实 workspace resolver。入口先鉴权再读取 body；普通 JSON 上限1MiB。只有准确 UUID 版本路径的 PUT/GET `/content` 流式传原始字节、上限50MiB和120秒；桌面代理保留来源、Cookie、CSRF、构建身份及禁止 redirect，邻近路径/其他 method 保留原预算。取消、断网及字节不符不会产生可领取的半文件。片段预览每页最多100条，cursor 签名绑定本人和文档版本。

写操作使用 Idempotency-Key 与带引号的 If-Match revision。收到不确定结果应先查文档/版本；产品不自动重传文件。人工使用原 key/revision 重试只接受相同字节，不重复创建原件；不同内容返回409。

Growth 1.0.38 为当前引用协议：CFO 文字输入及 session ask 可选 `knowledgeMode: auto|off`，省略保持旧调用/语音行为；最新文本界面发送auto，可选knowledge包含详细正文、来源及不确定性，旧answer仍限4000字符。实际运行还要求配置本地知识存储与受控解析器，原件接收并完成索引后才参与检索。

书籍仅为不可信参考数据，不是系统指令、企业已核实事实或现行法规证明。最多六个命中片段，合计12000字符；详细正文最多12000字符，来源须带文档版本、hash、片段与物理页/章节/坐标。

## 中文检索边界

`KnowledgeRetriever` 使用固定 [MiniSearch7.2.0](https://github.com/lucaong/minisearch/tree/v7.2.0)（MIT、无运行时依赖）与 Node22 `Intl.Segmenter`。标题/章节加权；NFKC和大小写归一化，现金回款、回款、货款回收、资金回笼归一到现金流。索引与问题使用同一分词，不启用模糊编号或前缀匹配；包含连续编号的问题必须精确命中该编号。首版是词法检索及这组有限近义词，不是任意语义检索。

资料先由workspace＋actor筛选，再以角色过滤排名结果；最多六条、总摘录12000字符，正文不截断以凑预算。空问候或无词法命中返回no_match；存储、索引或容量失败返回unavailable，不自动用无关资料凑答案。每条引用保留有效版本/hash、原文、页码/章节和不确定性。应用装配注入当前账户、成员关系与平台权限校验，取片段前后重新授权，不将旧HTTP权限快照当永久授权。

索引只在本地进程内按需从加密仓储重建，最多两份具体归属的LRU缓存；已建和构建中的索引原始UTF-8输入合计上限64MiB，分页读取，超限明确失败。这是输入容量而非V8堆的硬上限；引擎对象和临时查询有额外开销。没有明文索引文件、模型建索引、向量服务或embedding凭据。新版本在indexing阶段先构建完整候选，成功且重新授权后才由持久任务原子发布ready；候选不会提前用于问答。修改、替换、停用、删除、取消会使归属缓存失效；查询仍复核当前revision/有效版，不只依赖缓存通知。

合成中文检索、编号、权限撤销、角色排名、去重、容量和旧版本专项通过。现有首本私有书籍提取中的881个正文片段，仅在临时内存仓储抽查预算/编制/差异三个问题，引用均能定位物理页和精确原文；没有重复OCR、持久导入、模型调用或回显书籍全文。这不替代21本实际入库及智能体回答验收。引擎接口和许可证见[官方文档](https://lucaong.github.io/minisearch/)与[LICENSE](https://github.com/lucaong/minisearch/blob/v7.2.0/LICENSE.txt)，低频维护及无公告不等于已经证明无漏洞。

## 知识库页面

最新源码业务壳的侧栏入口为 `#knowledge`，页面自行承载列表和详情，不使用共享 inspector。登录并选择具体工作区后读取可用性；未配置本地服务时明确显示不可用，不伪造资料或进度。列表按服务端 cursor 每页20份，正文预览每次20片段，按需继续加载。支持分类、角色与状态筛选、资料标题/分类/适用角色编辑、文件替换、启停、删除、解析重试/取消及当前版本原件下载；角色名称复用现有六智能体。

每批最多10份非空文件，逐份发送原始字节。上传完成仅表示原件已接收，解析和索引状态另由版本显示；新版处理期间保留上一有效版本。网络结果不确定时保留待核对状态，不自动重传；人工核对发现已接收则不重复 PUT。取消上传会终止当前请求和等待队列，不等同于取消已经持久化的解析任务。

同一知识库路由复用页面实例；状态轮询只更新变化区域，不覆盖正在编辑的标题，不重建未变化预览。离页、登出或账号/工作区改变会取消请求并清除正文；迟到结果不能恢复旧资料。问答引用深链携带document/version/chunk/hash，只打开同版同hash的原文片段；分页寻找时只保留目标页，不把整本书装进Renderer。定位一次后不会由轮询反复抢焦点。删除、撤权、片段缺失或hash不符明确提示，不回退最新版。物理页、章节、坐标、hash、版本、缺页及OCR/表格/公式待核对标记按实际数据展示，不捏造版本序号或提取百分比。

## 六角色问答与历史引用

`FinancialCouncilAgentCenter`在模型前检索当前账号/工作区和角色适用的有效版本，参考数据与已确认报表、临时附件和公开搜索分别传递。参考片段不进入公共搜索或系统指令，也不加入后续聊天history。每题由当前配置的角色回答模型一次产生短摘要及详细投影；知识库问答禁用网关的输出修复调用，校验失败明确返回，不自动重放。公开主题判断仍沿现有独立流程，知识库不增加模型扇出。

模型仅提供详细模板和本次K来源编号。服务端在完整公司模板通过既有fact/原件坐标数值校验后，才将knowledge占位替换为精确原文；书籍年份、税率和金额仅作为原文引用，不升格为公司数字。引用展开后再次检查12000字符上限，不静默截断。无词法命中以no_match明确说明后一般回答；知识服务失败以unavailable明确降级。

模型返回后重新核对账户/成员权限、资料启停/删除、角色、有效版本、hash和revision；返回回答及写入CFO历史各有释放检查。变化使本题失败，不保存过期参考或重调模型。CFO的可选knowledge快照沿既有加密payload和revision CAS保存，恢复历史不重新搜索或换版。其他五角色完成消息和来源仍只在Renderer会话内保留；此功能没有增加它们的持久聊天历史。

13项页面状态/API单元测试通过。完整前端测试、主题切换/浏览器重启、三套类型检查、协议生成一致性、5项隔离浏览器和37项桌面代理测试均通过。浏览器覆盖上传/就绪与长预览轮询保留滚动、失败重试、身份变化、最新业务壳生命周期、角色和替换版本；黑绿/蓝白在1440、1024、390三宽度检查正常、选中、禁用、失败和可检索状态，关键文字对比度至少4.5:1。浏览器使用合成 HTTP 响应，不替代真实 Electron 上传、完整退出重启或21本入库验收。

## 验证命令

```bash
pnpm --dir backend test:knowledge
# 仅在显式配置 MYSQL_TEST_ADMIN_URL 后运行；不得回退 DATABASE_URL。
pnpm --dir backend test:knowledge:mysql
pnpm --filter ./contracts check:knowledge-types
pnpm check:growth-contracts
pnpm --dir frontend contract:check
pnpm --dir frontend test:knowledge
pnpm --dir frontend test:e2e:knowledge
pnpm --dir frontend test:theme
```

MySQL 专项会随机创建/删除自己的测试库，关连接后另开 pool 验证读回；该证据不等于整个 MySQL daemon 或 Electron 已完整退出重启。2026-10-06 已验证 MySQL 8.4.11 三项真实专项、零跳过；桌面路径/启动准备专项通过，原生应用完整重启测试未配置资源时明确跳过。

私有21份PDF及4742页提取结果保留在本机，不进源码、公共搜索或客户安装包；当前尚未导入产品知识库。
