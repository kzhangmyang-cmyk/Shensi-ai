# 系统默认参考库 Implementation Plan

> 历史中央方案实施计划：D1–D9既有证据保留，D10仅约束未来云部署。2026-10-09用户明确要求服务器审核期间先把21本资料内置应用，并由所有新老用户的六智能体默认调用。当前执行以README、knowledge-base模块文档、DEPLOYMENT和PROJECT_STATUS为准，不重复中央方案审批、不以中央绑定或不打包约束阻塞已获准的内置交付。

**Goal:** 让正常开通的新老客户在不同独立安装上使用中央默认参考库的回答和精确摘录，同时保持私人资料隔离。

**Architecture:** 在现有 Backend 内增加独立系统语料、严格中央授权及只读片段服务；本地业务 Backend 仅投递有限主题编号，并合并本人私有证据。复用既有中文检索、配置回答模型和平台 MFA；不共享真人账号、不增加模型规划或另一套搜索平台。

**Tech Stack:** 现有 Node 22、TypeScript、Express、Zod 3、MySQL 8、AES-GCM/HKDF、MiniSearch 7.2.0、OpenAPI/JSON Schema 生成工具、DOM/React 前端、Electron 源开发。

**Spec:** [已确认设计](system-default-reference-library.md)。2026-10-08 人类“可以可以就这样”确认设计，随后“确认”批准实施计划并沿用 Native。执行范围仅为D1–D9本地合成实现与验收，不是部署、书籍发布或真实模型调用授权。最新执行证据以PROJECT_STATUS及本计划独立ledger为准。

## Global Constraints

- 普通用户只能通过智能体回答与精确引用片段使用，不提供全文阅读、原书下载或遍历整本的接口。
- 用户自行上传的资料、报表、公司事实和历史保持原有私有边界，不随系统书库共享。
- 中央检索只接受最多3个固定主题编号；原问题、公司名称、金额、附件、报表、私有片段、偏好、历史均不进入该服务。
- 合并后总计仍最多6片段、12000字符；单片段最多4000字符，不截断原文凑预算。短回答4000/详细回答12000限制及财务、引用验证不放宽。
- 公网搜索关闭不阻断默认库，关闭知识检索则不访问默认库或私有库；省略知识选项和语音保持原行为。
- 中央 owner 维护不等于客户管理员、operator、本地 admin、同名账号或设备安装凭据；未知 workspace 兼容放行不能授权新服务。
- 模型完成后与历史写入前分别复核权限/版本；失败、取消、不确定均不自动重调模型。
- 不改已发布 Growth1.0.39 字节，不复制私人数据库，不重新 OCR，不新增依赖/云资源/App/DMG，不触碰无关获客和旧数据。
- 保留 HEAD `5cae9045ca01bc02186590407b987dd708cb8b11` 上862条已观察到的 dirty/untracked 及后续用户改动；执行前重读状态，不能重置或整文件认领共享 untracked。
- 本计划任务编号为 D1–D10，不覆盖旧 Task1–8；旧 Task8 未完成，所有旧单次守卫、失败/成功证据不变。
- D1–D9仅在本计划获批后进行本地合成实现/验收；D10真实发布前必须获得具体目的地、维护身份、费用、内容使用权及21份精确清单的独立授权。

## Review Focus

1. 本地同名 admin、未知中央 workspace 与真实中央 owner 混淆：D2 拒绝所有替代身份，D4 再验事务内 owner。
2. 登录/检索迟到响应遇到退出或换号：D3 的代次 fence 与 D8 的界面销毁不得恢复旧主体或旧摘录。
3. 有私有命中时中央离线被总 `used` 掩盖：D6/D8 独立呈现各库状态，不伪称已查默认库。
4. 旧历史 K1/UUID 被当成系统书籍，或新系统引用进入500页私有扫描：D1/D7/D8 判别来源并做零私有请求断言。
5. 累计预算、发布/撤销与两个并发请求竞争：D4/D5 的真实 MySQL 事务测试证明只按当前权限释放，不靠单进程缓存通知。

---

## 计划决策与边界

这是一个互相依赖的书库功能，不拆成独立身份产品、云平台或全文阅读器。D1→D2→D3建立访问边界；D4→D5建立可发布的片段服务；D6→D8接通问答/UI；D9验证源码能力；D10才是单独授权后的真实发布验收。每个任务有独立测试门槛，失败时停在该任务，不跳过测试进入下一项。

### 复用依据

复用仓库已锁定的 [MiniSearch7.2.0](https://github.com/lucaong/minisearch/tree/v7.2.0) 及其 [MIT许可](https://github.com/lucaong/minisearch/blob/v7.2.0/LICENSE.txt)，不升级安装；其内存索引不是持久存储、权限控制或堆内存上限。Open WebUI/Dify只借鉴设计文档所列权限分层，不取用代码/引入依赖。新复用对象须重新审核版本、许可证、维护、安全与适配成本；当前引用不等于完整安全审计。

### 固定术语与合同

- 新模块目录 `backend/src/system-reference/`，客户端组件 `frontend/src/system-reference/`；不将系统 corpus 填入 `knowledge_documents` 的某个假 actor。
- `ReferenceRole` 沿用六角色。词表版本 `finance-topics.v1`，首版12项：`budget_variance`预算偏差、`budget_planning`预算编制、`cost_driver`成本动因、`cost_structure`成本结构、`cashflow_forecast`现金流预测、`working_capital`营运资金、`profitability_analysis`盈利分析、`break_even`盈亏平衡、`statement_analysis`报表分析、`ratio_analysis`财务比率、`tax_document_review`税务资料核对、`tax_risk_review`税务风险核对。
- 每项的中文名称与上列短语是最小匹配词；沿用 NFKC 归一化，并只添加可审查的固定同义词。按不同匹配词数降序、词表顺序打破平局，最多3项；显式用户选择替代自动匹配，不能自由填词。角色不授予书库访问权。
- `ReferenceQuery={vocabularyVersion,topicIds,role,requestId}`，全部 strict，requestId 是后端随机 UUID；不含 question/history/company/document/text/可控 URL。中央仅用自身词表展开检索词。
- `SystemReference={sourceType:'system',sourceId,referenceKey,queryGrantId,referenceId,corpusId,releaseId,sourceHash,chunkHash,excerptRange,sourceLabel,locator,excerpt,warnings}`。`referenceKey=system:<releaseId>:<referenceId>`；sourceId仍为本题 K1–K6，不能用来取源。excerptRange 是该不可变 chunk 的 UTF-16 半开区间，不得切开代理对；不允许客户端修改范围。
- 私有来源保留已有字段和 K 别名，可选 `sourceType:'private'`；缺判别字段只解码为旧私有来源。模型仅接收本题 K、摘录、坐标、warnings，不接收凭据或取源授权。公开 S 引用保持独立。
- `PreparedReferences={evidence,libraryStatus,assertCurrent(signal?):Promise<void>}`；libraryStatus 分别记录 private 和 system，不能用一个 used 隐藏另一库失败。private状态为 `off|used|no_match|unavailable`；system 状态为 `off|unconfigured|unbound|ready|no_match|unavailable|auth_required|forbidden|rate_limited|vocabulary_mismatch`，中央query used映射ready。新协议的回答/历史携带该server派生状态，不让模型填写。
- D1同时定义 `CentralReader={subjectId:string,workspaceId:string,authVersion:number,authorityRevision:number}`、`CentralOwner={userId:string,authVersion:number,platformRevision:number,sessionVersion:number}`、`ReleaseDraft={id:string,corpusId:string,revision:number,status:'staging'|'ready'|'published'|'revoked'|'failed',manifestHash:string}`。`ConnectionStatus={status:'unconfigured'|'unbound'|'pending'|'ready'|'session_ready'|'unconfirmed'|'auth_required'|'forbidden'|'unavailable',generation:number,centralAccountLabel?:string,expiresAt?:string}`；session_ready仅用于中央正常会话，客户端绑定仍为ready，前者无绑定变更操作，旧严格客户端失败关闭为不可用；无凭据字段；时间为ISO8601，ID为UUID，hash为64位小写hex。
- `PublicationManifest={corpusId:string,sources:Array<{sourceHash:string,artifactHash:string,parsedHash:string,parserVersion:string,title:string,roles:ReferenceRole[],coverage:KnowledgeCoverage,warnings:string[]}>}`；`SourcePage={sourceHash:string,pageIndex:number,totalChunks:number,chunks:ParsedKnowledge['chunks']}`，pageIndex从0开始、chunk order贯穿整个source，不接受客户端持久ID。中央由manifest的parserVersion/coverage/warnings与完整页集重建ParsedKnowledge，必须与manifest的parsedHash一致：递归按键名排序对象、数组保留顺序、UTF-8无空白JSON的SHA256，chunkHash同法计算对应chunk。`QueryResult`的status只有used/no_match/rate_limited，失败用固定HTTP错误，不能把auth失败伪装空结果。
- 新客户端四个文字请求携带 `referenceProtocol:'system-v1'`，可选 `referenceTopicIds`；没有该字段的旧客户端只走旧私有协议，单独传referenceTopicIds而无协议声明拒绝。`knowledgeMode:off`或省略优先关闭两库。旧客户端读取带系统引用的历史时返回明确 `reference_client_upgrade_required`，不伪装私有来源，也不静默删字段。

### 运行值（首版计划值；真实容量验证前不开放生产）

- `disabled|central|client` 三种受信配置模式，默认 disabled。client 只有一个预先配置 HTTPS origin；拒绝用户名/密码 URL、非根路径、query/fragment及 redirect。HTTP仅可在显式测试配置下指向精确 loopback，不包含现有公网测试地址。Renderer不能设置 origin。
- 绑定请求5分钟、32随机字节 verifier、S256 challenge；只读凭据最长7天、无静默刷新。中央持久记录凭据 hash、subject/workspace/authVersion、撤销和绑定代次，私有业务后端加密保存原值。普通中央登录/MFA/设备 token 均不能替代 reader token；同一个真正中央 Backend 的 remote 模式可直接使用当前合法 req.user。
- 查询与引用响应最多256KiB/10秒，单次 JSON 请求最多4KiB。总 query/grant 路径响应不重试、不 redirect。查询发生在模型前；若已取得证据后授权检查不确定，整题停止，不降级重新生成。
- 中央查询限每账号10次/分钟、100次/UTC日；每绑定5次/分钟、60次/日；服务端观测IP60次/分钟。引用回查单独60次/账号/分钟，并纳入IP总120次/分钟。不能信任任意 X-Forwarded-For；只采用已配置可信反向代理链。
- 每账号每源hash每天新增释放不超过12个不同chunk且24000字符；滚动30天不超过该源索引字符数的5%与120000字符两者较小值，向下取整。重复相同摘录不重复扣字数但仍计速率；任何一个完整chunk超剩余额度则不释放，不能截断或以换版本/绑定绕过。配额不足是 rate_limited，不是 no_match。
- query grant记录保留30天，只允许已释放集合；记录到期则回查明确失效。历史原快照仍遵循私人历史规则。新查源须当前账号/发布仍有效，绝不以历史快照代替实时授权；发布切换不能自动扩大旧grant。
- 中央候选/当前索引共同的原始输入预算64MiB，最多100个来源、每来源50000 chunks，分页100；V8额外开销另量测。超限拒绝候选，旧版继续，不自动加内存、截断全库或分发全文。D10须核实21份可容纳，否则报告容量阻塞并调整计划。

### 文件职责

| 范围 | 新文件职责 | 现有接缝 |
| --- | --- | --- |
| 合同/主题 | system-reference.v1合同、topics.ts、domain.ts | knowledge/domain.ts与answer.ts、Growth/Decision生成 |
| 中央身份 | authority.ts、binding-service.ts、binding-repository.ts、mysql-bindings.ts | auth.ts、platform-admin-*、正常中央登录 |
| 客户端绑定 | client.ts、connection-service.ts、connection-router.ts、connection-store.ts | 本人scope、logout、runtime-env、desktop-local runtime |
| 系统发布 | crypto.ts、repository.ts、mysql-repository.ts、publication.ts、admin-router.ts | 平台MFA/owner事务、既有提取验证 |
| 检索/授权 | retrieval.ts、grants.ts、router.ts、module.ts | MiniSearch、数据库pool，不复用私有路由 |
| 合并/回答 | composite-retrieval.ts | FinancialCouncilAgentCenter、两个回答适配器、CFO历史 |
| UI | connection-view.ts、binding-page.ts、citation-view.ts、admin-panel.tsx | chat、platform-admin、demo shell、theme |

## Task 1 (D1)：正式合同、有限主题与兼容类型

**Files:** 新建 `contracts/openapi/system-reference.v1.yaml`、`contracts/json-schema/system-reference.v1.schema.json`、`contracts/test/system-reference-contract.test.mjs`、`backend/src/system-reference/{domain,topics,topics-test}.ts`；修改 `contracts/json-schema/{knowledge,cfo-conversation,cfo-session}.v1.schema.json`、`contracts/openapi/{knowledge,platform-admin,decision-simulation}.v1.yaml`、`contracts/openapi/growth-advisor-quote-roi.v1.yaml`、contracts/package.json；生成 `frontend/src/generated/system-reference.ts` 及 knowledge/Growth/Decision/platform-admin派生。

**Interfaces:** 产生上述 ReferenceQuery/SystemReference/PreparedReferences、`projectReferenceTopics(question:string, selected?:ReferenceTopicId[]):ReferenceTopicId[]`、`systemReferenceQuerySchema`。topic常量为单一真源，合同enum与实现一致性测试锁定。来源联合供D6/D7消费，系统来源不拥有私有documentId。

- [ ] RED：增加主题/合同测试，断言 `projectReferenceTopics('甲公司预算偏差987万元，密码secret')` 只返回 `['budget_variance']`；问候返回 `[]`；4个/重复/未知选项拒绝；`systemReferenceQuerySchema.safeParse({...valid,question:'私密'}).success===false`；系统UUID不能parse为私有来源；旧无判别K引用仍parse为私有。
- [ ] 运行 `pnpm --dir contracts test` 与 `pnpm --dir backend exec tsx --test src/system-reference/topics-test.ts`，确认新测试确因缺少新合同/实现失败，记录RED。
- [ ] 实现严格枚举/投影与生成链。Growth源版本预定1.0.40；执行时若已被其他任务占用，选择新的未发布版本并同步本计划，不覆盖。新字段无默认值；协议必须经正常bootstrap发布协商。
- [ ] GREEN：上述测试及 `pnpm --dir contracts check:types`、`pnpm check:growth-contracts`、`pnpm --dir frontend contract:check` 通过；快照断言旧release文件hash不变。
- [ ] 同步 `contracts/README.md`、API_INDEX 与本任务差异清单；只记可分离checkpoint，不提前整体提交共享untracked。

## Task 2 (D2)：严格中央资格与一次性正常登录绑定

**Files:** 新建 `backend/src/system-reference/{authority,binding-service,binding-repository,mysql-bindings,binding-router,binding-test}.ts`；修改 `backend/src/{auth,server,platform-admin-router}.ts`；新增 `frontend/src/system-reference/binding-page.ts` 与其测试。

**Interfaces:** `ReferenceAuthorityReader.current(subjectId:string,workspaceId:string,connection?:PoolConnection):Promise<CentralReader>`；`assertOwner(userId:string,connection?:PoolConnection):Promise<CentralOwner>`。`BindingService.create({challenge:string},ip:string):Promise<{requestId:string,displayCode:string,expiresAt:string}>`、`approve(reader:CentralReader,requestId:string,displayCode:string):Promise<void>`、`exchange({requestId:string,verifier:string}):Promise<{readerToken:string,reader:CentralReader,expiresAt:string}>`、`cancel({requestId:string,verifier:string}):Promise<void>`。exchange是可信后端专用，返回值不得直接代理Renderer；批准端从req.user推导主体。

- [ ] RED：`assert.rejects(unknownWorkspace)`、`assert.rejects(localJwt)`、`assert.rejects(operatorPublish)`；并发两个exchange断言成功恰好1个；错verifier、5分钟到期、第二主体批准、禁用/authVersion变化均拒绝；reader token访问普通业务/发布路由均401/403。
- [ ] 运行 `pnpm --dir backend exec tsx --test src/system-reference/binding-test.ts`，确认RED。
- [ ] 实现中央自己的user/有效成员及明确纳管workspace检查后，再验证 `agents/execute`；不得单看旧 `.allowed`。新路径在auth功能分类中明确归 agents。新增 `POST /api/v1/system-reference/binding-requests` 及 `POST /api/v1/system-reference/binding-requests/:id/approve`、`/exchange`、`/cancel`；仅create/exchange/cancel使用各自受限挑战权限，10次/IP/分钟，exchange/cancel的body只含verifier，requestId取路径。approve使用正常中央登录+CSRF，页面明确显示中央账号和两端匹配码，不能自动批准。没有现成桥，此任务真实实现桥。
- [ ] 凭据为256bit随机opaque值，hash持久查找，记录purpose=`system-reference-reader`、确切issuer与7天过期；pending/approved/consumed/cancelled/expired持久化、事务消费。取消能撤销可能已发出的凭据，不记录secret。匹配码为8位随机十进制字符，仅供两端核对、不是exchange权限。绑定请求无需上送本地账号/企业名；本地绑定在D3私有存储中，中央只显示随机匹配码与自身账号；不同中央主体不得覆盖既有批准。
- [ ] GREEN：binding专项、`pnpm --dir backend test:accounts`、`pnpm --dir backend test:security`通过；正常旧登录与平台MFA回归不变。同步 identity-and-permissions/platform-administration 文档和checkpoint。

## Task 3 (D3)：可信业务后端连接与会话生命周期

**Files:** 新建 `backend/src/system-reference/{client,connection-store,connection-service,connection-router,connection-test}.ts`；修改 `backend/src/{server,runtime-env}.ts`、`scripts/desktop-local-runtime.mjs` 及其测试。不改 Douyin `desktop-central-api-client`/deviceToken 的权限。

**Interfaces:** 以下ctx均为 `KnowledgeScope`、signal均为可选 `AbortSignal`。`ReferenceConnectionService.status(ctx):Promise<ConnectionStatus>`、`begin(ctx,signal?):Promise<{requestId:string,approvalUrl:string,displayCode:string,expiresAt:string}>`、`complete(ctx,requestId:string,signal?):Promise<ConnectionStatus>`、`unbind(ctx,signal?):Promise<ConnectionStatus>`、`clientFor(ctx,signal?):Promise<ReferenceClient>`。`ReferenceClient.query(input:ReferenceQuery,signal?):Promise<QueryResult>`、`assertCurrent(grantId:string,signal?):Promise<void>`、`citation(grantId:string,referenceId:string,signal?):Promise<SystemReference>`。私有scope={backendInstanceId,workspaceId,actorId,authVersion,generation,issuer}由服务器生成；authVersion每次从当前已认证actor的用户存储核对，不能由body指定。

- [ ] RED：在begin与complete间换本地账号/登出/改issuer，断言 `storedTokens===0`；迟到query断言 `releasedSources===0`；redirect和非HTTPS拒绝；响应体未知字段/过大/超时拒绝；网络未知exchange断言 `exchangeCalls===1` 且状态为未确认；remote复用只在显式central模式成立。
- [ ] 运行 `pnpm --dir backend exec tsx --test src/system-reference/connection-test.ts` 与 `node --test scripts/desktop-local-runtime.test.mjs`，确认RED。
- [ ] 实现可信backend保存verifier与AES-GCM加密reader token，AAD含全scope及issuer；原值不进Renderer/日志/URL/普通配置。`GET /api/v1/reference-connection`、`POST /api/v1/reference-connection/begin`、`POST /api/v1/reference-connection/complete`、`DELETE /api/v1/reference-connection`全部本人正常身份+CSRF；安全响应不包含凭据。begin仅返回固定origin下批准URL、requestId、匹配码、expiresAt，原始question不进入URL。用户在真正中央页面登录批准后，手动“完成连接”执行一次exchange，不轮询、不自动重试。
- [ ] 登出/换号/解除绑定先增generation、取消flight和清缓存，再清本地绑定；远端撤销未知时不恢复绑定，保存安全待核对状态。exchange不确定只能由用户执行cancel撤销及核对，再显式新建。请求/消费tombstone保留至少7天；正常重启恢复仅同issuer/账号/authVersion的绑定，使用前重新验权。
- [ ] GREEN：专项、后端/desktop类型、已有runtime与renderer代理测试通过。文档说明未配置不是无书、正常中央开通不复制本地用户表。无真实登录操作，记录checkpoint。

## Task 4 (D4)：独立加密语料和 owner 原子发布

**Files:** 新建 `backend/src/system-reference/{crypto,repository,mysql-repository,publication,admin-router,publication-test,mysql-integration-test}.ts`、`backend/scripts/stage-system-reference-library.ts`；复用 `knowledge/pre-extracted-reader.ts` 的 `validatePreExtractedSource`，不改其私人manifest授权；在 `platform-admin-router.ts` 的真实MFA检查之后挂接管理子路由。

**Interfaces:** `stageRelease(owner:CentralOwner,manifest:PublicationManifest,key:string):Promise<ReleaseDraft>`、`stageSource(owner:CentralOwner,releaseId:string,page:SourcePage,expectedRevision:number,key:string):Promise<ReleaseDraft>`、`publishRelease(owner:CentralOwner,releaseId:string,expectedRevision:number,reason:string,key:string):Promise<ReleaseDraft>`、`revokeRelease(owner:CentralOwner,releaseId:string,expectedRevision:number,reason:string,key:string):Promise<ReleaseDraft>`。Repository提供同一事务内candidate/published pointer、grants、budget和audit的操作，不用原私有repository假scope。

- [ ] RED：原子发布中途抛错，断言 `activeRelease===oldRelease`；只有索引ready且manifest完整才发布；并发相同key同bytes只一版、改bytes冲突；owner在提交前被撤销、operator/MFA例外均拒绝。读取密文不能出现合成正文；AAD跨corpus/release/chunk互换失败。所有测试只用合成ParsedKnowledge。
- [ ] 运行 `pnpm --dir backend exec tsx --test src/system-reference/publication-test.ts`，确认RED；MySQL测试只用显式 `MYSQL_TEST_ADMIN_URL` 创建自己随机命名库，不读DATABASE_URL，不运行时不得声称通过。
- [ ] 实现 `system_reference_releases/sources/chunks/commands/grants/budgets/audits` 独立表与主键，HKDF新purpose、稳定密钥、无明文索引文件。复用纯tokenize/index算法时提取 `knowledge/lexical.ts`，私有权限/缓存/测试不变。索引完整校验后指针CAS与审计同事务，发布/撤销期间fresh owner/authority revision复核，遵循现有单API锁，不声称支持多API写入。
- [ ] 管理路由 `/api/platform/v1/system-reference/releases` 提供草案、质量/版本、publish/revoke；`PUT /api/platform/v1/system-reference/releases/:id/sources/:sourceHash/pages/:pageIndex` 精确路径限2MiB/页、每页100chunks，哈希绑定序号及总数，缺页/重复/最终hash错拒绝。body预算须在现有通用parser前按准确路径应用，且先验证正常登录/真实MFA/owner再接收正文；相邻路径不能获得大body权限。普通读接口永远不能到管理片段。CLI默认干跑、只有已确认manifest和明确apply才用正常独立登录+MFA上传提取产物；不上传PDF、不读取本地DB、不删除原件，不擅自使用旧会话。源PDF与Docling hash由授权发布端本地验证，中央验证传入规范产物hash；不得声称未收到PDF的中央重新核对了PDF字节。
- [ ] GREEN：专项与新 `pnpm --dir backend test:system-reference:mysql`（需本机显式合成库配置）零跳过，重开pool读回发布和审计，回滚/commit不确定不自动重发。同步 DATA_MIGRATION/DEPLOYMENT 的新增表、稳定密钥、仅新增与备份恢复边界，记录checkpoint。

## Task 5 (D5)：中央有限检索、累计预算与精确引用授权

**Files:** 新建 `backend/src/system-reference/{retrieval,grants,router,module,retrieval-test,grants-test}.ts`；扩展D4真实MySQL专项与根测试脚本。

**Interfaces:** `SystemReferenceService.query(reader:CentralReader,input:ReferenceQuery,signal?):Promise<QueryResult>`；QueryResult={status,grantId?,sources:SystemReference[],releaseId?}；`assertCurrent(reader,grantId,signal?):Promise<void>`；`citation(reader,grantId,referenceId,signal?):Promise<SystemReference>`。所有产物先经正式合同校验；服务端选择范围、ID和当前发布，不接受任意chunk或sourceHash查询。

- [ ] RED：仅topicIDs才能查；未知字段/角色/词表版本拒绝；无匹配sources为空；跨账号grant、改release/reference/range拒绝。分别验证同绑定第6次/分钟拒绝，以及同账号经3个绑定分摊后第11次/分钟仍拒绝，不能让绑定限额掩盖账号测试。两个并发释放撞到最后一份预算时只允许一份，重新绑定或同hash新版不重置累计数。正文+坐标+hash+warnings逐字等于合成源。
- [ ] 运行 `pnpm --dir backend exec tsx --test src/system-reference/retrieval-test.ts src/system-reference/grants-test.ts`，确认RED。
- [ ] 实现 `/api/v1/system-reference/query`、`POST /grants/:id/check`、`GET /grants/:id/references/:referenceId`；refreshauthority及当前release后，预算扣减、精确允许集合和安全审计同事务。10秒/256KiB边界、不接收cursor/全文range/下载选项。query grant到期/撤销明确失效，check返回不含正文的有效性结果。
- [ ] 已发布语料按角色及主题词法排名，缓存/候选合计64MiB输入预算；命中前后核对当前指针和授权。不记录query raw文本、摘录、reader token、任意错误；只记固定原因/主体内部ID/release/请求ID/计数。启用检查速率也有独立账号60次/分钟/IP120次/分钟上限，不能借check绕预算或无限占资源。
- [ ] GREEN：专项、真实MySQL并发/重启/30天窗口边界、API response conformance通过；未完成页集不可索引，断网不伪报no_match。同步模块/API/审计字段，记录checkpoint。

## Task 6 (D6)：两库合并和保留现有私人授权证明

**Files:** 新建 `backend/src/system-reference/{composite-retrieval,composite-retrieval-test}.ts`；修改 `knowledge/{domain,answer}.ts`、`growth-financial-council-module.ts`、`financial-council-agent-center.ts`；保留private `KnowledgeRetrievalPort`与其WeakMap证据。

**Interfaces:** `ReferenceRetrievalPort.prepare(ctx:KnowledgeScope,input:{question:string,role:ReferenceRole,knowledgeMode?:'auto'|'off',referenceProtocol?:'system-v1',referenceTopicIds?:ReferenceTopicId[]},signal?:AbortSignal):Promise<PreparedReferences>`，D7注入该口。`prepare`保存未修改的private evidence供旧assertCurrent使用；对合并产物独立digest/proof，不把clone或重编号对象交给旧证明。off/省略返回关闭状态，不调用两库。

- [ ] RED：`knowledgeMode:off/undefined`双库调用0；无新协议字段中央调用0；webSearchMode:off不影响中央；含姓名/金额/私有片段的问题被捕获的中央body只有正式Query字段。无匹配topics时中央query调用0。私有used+中央unavailable保留两状态；篡改合并对象后assertCurrent失败。
- [ ] 运行 `pnpm --dir backend exec tsx --test src/system-reference/composite-retrieval-test.ts`，确认RED。
- [ ] 实现私有/系统候选轮流取用（从私有开始），两侧原排名不变，按规范化摘录去重，超单片/总预算的候选跳过不截断，统一重编号K1–K6。合并最多6/12000，不向中央传private候选、剩余字数或公司上下文。原private证据和system grant各自保存，闭包重验两者及绑定generation。
- [ ] GREEN：新专项及原 `pnpm --dir backend test:knowledge` 通过，包括两库各6候选仍只释放合计6、中央撤销/私人删除任一导致release失败。同步合并方法/独立状态文档，记录checkpoint。

## Task 7 (D7)：四文字路径、两个模型适配器和CFO历史

**Files:** 修改 `backend/src/{financial-council-agent-center,financial-council-agent-center-router,cfo-conversation,finance-document-service,finance-document-model,cfo-conversation-session-repository}.ts`、`knowledge/answer.ts`；新增 `system-reference/agent-integration-test.ts` 并扩展原model-answer/agent/session测试。

**Interfaces:** D6 PreparedReferences进入普通chat与 `FinanceDocumentService.askSelected`；`referenceRelease`同时用于模型后和历史写入前。四路径为普通cfo-conversation、CFO session turns、operating-memory-question无session/有session；有附件/已验证报表分别测试。新libraryStatus仅server派生，不要求模型生成。

- [ ] RED：6角色×附件/报表×四入口的适用知识启用组合捕获实际mock网关请求；断言只一answer调用、repair=false、来源不在system指令/公网planner/后续模型history输入中（本人加密历史的引用快照仍保留）；另测旧省略知识选项的repair语义不改。返回合法K模板后严格财务检查仍拒绝虚构企业金额；root S与nested K作用域不混用。模型后及save前分别撤权，断言 `newHistoryTurns===0`、`modelCalls===1`。
- [ ] 运行 `pnpm --dir backend exec tsx --test src/system-reference/agent-integration-test.ts`，确认RED。
- [ ] 在旧精确短回答/知识schema上接通来源union，保持本题完整闭合JSON示例和server派生元数据。匹配到中央grant后断连不是重放理由；在model前尚未取到证据可明确“不使用默认库”并按原私有能力回答。用新协议保存历史快照和每库状态；legacy历史不加系统猜测，legacy客户端面对系统历史提示升级。
- [ ] GREEN：`pnpm --dir backend test:cfo-conversation`、`test:knowledge`、新agent专项、Growth/Decision合同一致性通过；不运行真实模型、不恢复旧三题。同步 cfo-conversation/knowledge/API 文档，记录checkpoint。

## Task 8 (D8)：用户连接、仅摘录引用、owner发布界面与桌面预算

**Files:** 新建 `frontend/src/system-reference/{api,connection-view,citation-view,admin-panel}.ts`（admin-panel用`.tsx`）及各自`.test.ts`/`.test.tsx`；修改 `growth/agents/{cfo-conversation,cfo-chat-messages}.ts`、`platform-admin/app.tsx`、`demo/demo-app.ts`、主题样式；新增 `frontend/tests/system-reference.spec.ts`和专用Playwright配置/命令；修改 `desktop/src/main/renderer-server.ts`及对应test。

**Interfaces:** `mountReferenceConnection(host,{api,identity}):{dispose():void}`；`mountSystemReferenceCitation(host,{api,identity,citation,historical}):{dispose():void}`；`PlatformReferencePanel({api,platformRevision,role})`。api只消费生成DTO，token/verifier永远不属于安全状态。引用api仅收grant/referenceId，不允许任意URL。

- [ ] RED：system点击断言 `privateApiRequests===0`、`originalLinks===0`、`nextPageControls===0`；旧private点击仍为原私有深链；离页/换本地或中央账号后迟到内容不可见。中央离线+私有命中同时可见“默认参考库不可用”和“使用本人资料”；公网off文案为“未使用公网搜索”，不叫“未联网”。
- [ ] 运行新增前端单测，确认RED；为三个POST路径的代理预算加断言：普通chat、准确UUID session turns、operating-memory-question均130000ms，近似路径/GET仍10000ms，原50MiB上传特例不变。
- [ ] 实现独立默认库状态/连接/解除/手动完成入口及有限主题选择；无下载整书入口。中央批准页正常登录并显示自身账号/匹配码，绑定不自动提交。历史引用标识“历史”，打开时正常回查；失败保留历史标签、不换新版。owner面板显示候选quality/hash和发布/撤回明确确认，operator只读或403，UI隐藏不作为权限控制。
- [ ] GREEN：新增单测与browser（两个主题1440/1024/390、键盘/焦点、正常/disabled/error/success/空态、文字对比度4.5:1）、原knowledge7browser/chat五宽度通过；`pnpm --dir frontend test:types`、`contract:check`、`pnpm --dir desktop exec tsx --test tests/renderer-server.test.ts`通过。新增配置确实匹配system-reference.spec.ts，不能只跑旧7项。
- [ ] 同步用户入口、只摘录限制、独立联网文案、desktop预算文档，记录checkpoint。合成browser不冒充真实原生登录或跨电脑。

## Task 9 (D9)：模块装配、全回归、合成跨安装与源码重启

**Files:** 完成 `system-reference/module.ts`与backend server/runtime装配，修改 `backend/src/growth-commercial-runtime-bridge.ts` 的精确route family及测试；新增 `backend/src/system-reference/runtime-integration-test.ts`、`scripts/verify-system-reference.mjs`；更新根/backend/frontend/contracts验证脚本、README、ARCHITECTURE、API_INDEX、PROJECT_STATUS及相关模块。

**Interfaces:** `createSystemReferenceModule(config:ReferenceRuntimeConfig):GrowthCommercialModule`；`ReferenceRuntimeConfig`为判别联合：`{mode:'disabled'}`、`{mode:'central',pool:Pool,secret:string,issuer:string,corpusId:string,authority:ReferenceAuthorityReader}`、`{mode:'client',pool:Pool,secret:string,backendInstanceId:string,issuer:string,centralOrigin:string}`。disabled不启动网络/worker；无真实配置不得Memory fallback，allowLoopbackTest只有测试factory参数、不是Renderer或生产env。module close取消工作并关自有资源，不关闭共享业务pool。`verify-system-reference.mjs`只编排确定的合成门禁，无书籍/模型/云动作。

- [x] RED：两个独立业务Backend加一个合成中央服务，A/B正常绑定后都取得同版系统引用；A私人资料B读取404；伪本地admin/token拒绝；关闭任一中央服务独立显示unavailable；保存历史与绑定不跨scope。持久schema缺失/密钥缺失不fallback Memory。
- [x] 运行 `pnpm --dir backend exec tsx --test src/system-reference/runtime-integration-test.ts`，确认RED，再完成最小装配。
- [x] GREEN：新增 `test:system-reference`、`test:system-reference:mysql`零跳过、所有合同/类型/前端browser/desktop专项、原知识/金融测试，以及根 `pnpm test`、`pnpm build`、`./scripts/context-check`、`git diff --check`。每份日志记录真test/pass/fail/skip；旧918项结果不代表新代码。有限长门禁由根按CPJ skill启动一次并在后续回合读终态/有界结果，不把服务放CPJ。
- [x] 只在获批范围内，以新合成中央/两套隔离本地runtime验证进程和MySQL真正停止重启后读回；不得用重开pool冒充daemon重启，也不得为B退出/注入A现有会话。源码应用更新时精确核对本人进程，正常退出及 `pnpm desktop:local` 保留原engine/container/volume；原21本私有库hash与历史不变。
- [x] Fresh全分支只读审查，修复相关发现并重跑受影响门禁；记录“合成源码可用、真实21本尚未发布”。按用户要求最终验收前不提前Task8 done/整分支提交/精选备份，不宣称全部客户已可用。

## Task 10 (D10)：另行授权后的真实发布与交付

**Files:** 新建 `docs/operations/system-default-reference-library-release.md`作为未来实际发布runbook和证据索引；更新设计/当前模块/状态。所有真实清单、凭据、批准和结果均在忽略的owner-only目录，不进Git。

**Interfaces:** 消费D3正常绑定、D4受控stage/publish、D5精确引用及审计；没有直写DB/取消owner谓词/重用旧guard的捷径。

- [ ] 先落实并记录人类对确切生产origin/TLS/数据库/存储、预算费用、中央owner及内容使用权、21个source+derived hash清单的批准。未满足即停在此项；不能把本计划批准作为这些资源授权。发布runbook的恢复/备份/告警、单API锁与凭据保管必须通过目标环境检查。
- [ ] 在授权目的地正常MFA维护，先dry-run核对现有提取的4742物理/4709可索引/33缺页及source_incomplete等标记，不重新OCR；核实容量通过后按确切清单stage并原子publish。每个真实写入有新幂等身份，断连先核对状态，不自动重发。源PDF和原私人记录保留，不默默从“我的资料”删除；后续清理私人重复副本须另获明确授权。
- [ ] 两台真实独立安装、两个正常中央客户（覆盖新老账号）验证同一默认库可用、对方私人库不可读；普通用户无全文/下载/分页和发布权。真正原生两主题的连接/引用/离线/换号/历史再次授权验收；需要用户接管账号时停下，不抽Cookie/Profile/凭据。
- [ ] 重新确认真实模型验收的准确角色/问题/次数/费用及来源批准；新独立guard和前后API调用账本逐一验收，成功精确匹配hash/chunk/坐标/摘录/完整warnings；任何失败/不确定停止，不自动重放。旧未用三角色和公开题不自动移作中央发布测试，公开题的repair/私有报表上下文缺口须先单独处理。
- [ ] 验证中央和本地完整服务重启、撤销/旧引用行为、私有历史/发布清单恢复；原PDF人工逐字核对与业务判断审定未做则明确未做。
- [ ] 最后fresh全分支独立审查、相关全门禁、本人可分离提交和task-done；到精选源码备份工作区检查排除资料/secret/runtime/installer，再由既有私有远端确认推送才称备份完成。只有真实入口/安装覆盖均验收才称交付。跟进目前PAUSED，不能因计划批准自行恢复；真正交付也需准确记录状态。

## 主代理自审与执行交接

- Spec覆盖：身份/组件→D2/D3；查询隐私→D1/D6；发布/引用→D4/D5/D8；失败/协议→D1/D3/D7；验收目标→D9/D10，无默许跳过的真实关卡。
- 接口一致性：query只吃ReferenceQuery；取源只吃grant/referenceId；K是模型别名而不是访问权；private原对象与system grant分别复核；所有前端DTO从合同生成。
- 风险测试：上列五项Review Focus均落到对应RED断言。额度/桥接参数是已确认的首版实现值，仍须合成及真实容量验证，不反写成已上线规则。
- 任务checkpoint保留本任务差异、RED/GREEN和文档记录。受用户现有脏工作树/最终验收约束，不在每任务整文件git add；最终仅提交可分离本人变化。没有普通状态不变的重复通知。
- 人类已评审确认，使用 Native：主代理顺序实现，必要只读协助、最后fresh独立全分支审查，不在各任务间重复询问是否继续。执行证据写入本计划独立ledger；已批准的本地范围不跳过D10外部授权。
