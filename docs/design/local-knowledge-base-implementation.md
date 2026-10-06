# Local Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在最新 Shensi 桌面开发版交付可上传、持久、账号隔离的参考知识库，并让六角色先检索再详细回答和标注来源。

**Architecture:** 使用现有本地 MySQL，原件由 Backend 私有加密文件仓储管理，解析在独立本地进程执行。服务端按授权集合建立可重建中文 MiniSearch 索引；当前角色模型接收有限参考片段，原财务事实与语音协议保持。

**Tech Stack:** TypeScript/Node 22、Express、MySQL、现有 DOM/Electron 壳、MiniSearch、Docling/macOS 本地 OCR；复用现有 OpenAPI 生成和 Growth 模块装配。

**Spec:** [已确认设计](local-knowledge-base.md)。计划和 Native 顺序实施方式已获用户批准；按实际验证更新复选框，未勾选步骤尚未完成。

## Global Constraints

- 单文件上限 50MiB、PDF 上限 1,000 个物理页；最多同时选十份、逐文件排队。
- 格式为 PDF、DOCX、XLSX、CSV、TXT、MD；不增加 EPUB、图片集、宏或旧二进制 XLS。
- 状态为 `queued → parsing → indexing → ready`，另有 `failed/cancelled`；上传完成不等于可检索。
- 每次最多取六个去重片段，合计不超过 12,000 字符；详细正文上限 12,000 字符。
- 第一版资料默认为当前 workspace＋上传者 actor 私有；拒绝 `all`，同企业不同账号不自动共享。
- 能力为 `knowledge.read`、`knowledge.upload`、`knowledge.manage_own`；不扩大 `finance.council.run`。
- 原件 root 为 `SHENSI_KNOWLEDGE_STORAGE_ROOT`，绝对路径、目录 0700、文件 0600；没有持久配置时不退回随机密钥。
- 保留旧 `answer` 简短字段和数值校验；实时语音不直接播放新增详细参考回答。
- 不重新提取已有 21 份 PDF，不上传原件/片段到公共搜索、GitHub或安装包，不云同步、不训练模型、不打包 App/DMG。
- 保护现有未提交修改。执行前保存只读 diff 基线，每任务只提交本任务可分离的新文件/hunk；不能 `git add .` 或将已有整文件修改夹带提交。无法安全分离时保留工作区改动并记录验证，不强行凑提交。
- 计划放在 `docs/design/`：仓库约定 `docs/superpowers/` 仅为历史上下文；实际进度只更新 `docs/PROJECT_STATUS.md`。

## Review Focus

- 同企业另一账号／切换工作区：不返回文件名、原件、片段或检索结果；Task 1、2、5、6 验证。
- 上传半途断网／实际字节超过声明：不产生可检索半文件、不自动重放文件上传；Task 3 验证。
- 替换／停用／删除时旧 worker 才完成：不能复活旧版本或覆盖新版本；Task 2、4、5 验证。
- 中文无空格、同义问法、企业名/编号：不会因英文默认分词漏检或错误拼接编号；Task 5 验证。
- 正常可读但带 PDF 加密标志、以及真正需要口令的 PDF：前者正常读取，后者明确请求用户提供可读取文件，不绕过口令；Task 4、8 验证。

## 文件职责与接口约定

新文件均为拟议实现，不代表当前存在。公共 DTO 从合同生成；内部类型定义在 `backend/src/knowledge/domain.ts`。

| 文件 | 单一职责 |
| --- | --- |
| `backend/src/knowledge/domain.ts`、`repository.ts` | 资料/版本/片段/任务 schema、权限和仓储接口；不包含 HTTP 或模型。 |
| `memory-repository.ts`、`mysql-repository.ts` | 测试替身与真实事务持久化；memory 不能作为产品 fallback。 |
| `crypto.ts`、`file-store.ts` | 稳定配置校验、归属 AAD、加密原件的有界读写与临时明文生命周期。 |
| `service.ts`、`router.ts`、`module.ts` | 命令/查询、认证后 HTTP 投影、Growth 安装/关闭与 private service 注册。 |
| `reader-gateway.ts`、`ingestion-worker.ts` | 本地解析协议、超时/取消、持久租约与版本发布；不使用浏览器 Sidecar。 |
| `retrieval.ts`、`answer.ts` | 中文索引和参考回答验证/渲染，彼此不持有原件路径。 |
| `services/knowledge-reader/` | 文档安全读取/OCR/坐标分块，不持有账号/模型/数据库凭据。 |
| `frontend/src/knowledge/{api,view,view-state}.ts`、`knowledge.css` | 生成 DTO 客户端、独立 DOM 页面、生命周期/状态与现有主题样式。 |

公共记录：`KnowledgeDocument` 含 id、revision、title、sourceKind、roles、enabled、activeVersionId、更新时间；`KnowledgeVersion` 含 id、documentId、filename、format、bytes、sourceHash、uploadComplete、status、coverage、warnings、failureCode；`KnowledgeCitation` 含 documentId/versionId/sourceHash/chunkId、sourceLabel、locator、excerpt、warnings，不含路径或凭据。

内部 `KnowledgeScope` 使用现有 `ActiveWorkspaceContext`；`KnowledgeRole` 使用现有六角色枚举。`ParsedKnowledge` 为 `{parserVersion, coverage, warnings, chunks}`，每个 chunk 有 order、text、locator、warnings。`KnowledgeJobClaim` 有 jobId、documentId、versionId、workspaceId、actorId、fence、leaseUntil。`KnowledgeDocumentRecord/KnowledgeVersionRecord` 只在仓储/服务内使用，在公共 DTO 外另持有 workspaceId、actorId、storageKey；HTTP 投影必须移除这些内部字段。所有命令身份与 workspace 来自服务端上下文。

### Task 1: 合同、权限与可测试领域

**Files:** Create `contracts/openapi/knowledge.v1.yaml`、`backend/src/knowledge/{domain,repository,memory-repository}.ts`、`domain-test.ts`、`backend/test/knowledge-fixture.ts`；Modify `contracts/package.json`、`backend/package.json`、`contracts/openapi/growth-advisor-quote-roi.v1.yaml`、`backend/src/growth-capabilities.ts` 及对应测试/生成类型。

**Interfaces:** 产出生成的 `KnowledgeUploadInput`、列表分页、版本/片段/错误投影；输入字段为 title、filename、format、bytes、sourceKind、roles，不接受 owner/path。`KnowledgeRepository` 的所有操作均为 Promise；ctx 为 `KnowledgeScope`、input 为 `KnowledgeUploadInput`、id/key 为 string、revision 为 number。定义 `createDocument(ctx,input,key)` 返回 document/version 记录；`addVersion(ctx,id,input,revision,key)` 返回版本记录；`listDocuments(ctx,{cursor,limit,q,role,status})` 返回分页；`getDocument(ctx,id)`/`getVersion(ctx,documentId,versionId)` 返回记录/null；`listChunks(ctx,versionId)` 返回片段。`mutateDocument(ctx,id,patch,revision,key)` 返回文档记录，patch 仅含 title/sourceKind/roles/enabled/deleted。失败抛既有 `GrowthHttpError`。

任务接口同属该 repository：`completeUpload(ctx,versionId,receipt,revision,key):Promise<KnowledgeVersionRecord>`，receipt 为 `{storageKey,sourceHash,bytes}`；`retryJob(ctx,versionId,revision,key):Promise<KnowledgeVersionRecord>`；`cancelJob(ctx,jobId):Promise<void>`；`claimJob(workerId:string,now:number,leaseMs:number):Promise<KnowledgeJobClaim|null>`；`renewClaim(claim,now,leaseMs):Promise<boolean>`；`commitParsed(ctx,claim,parsed:ParsedKnowledge):Promise<KnowledgeVersionRecord>`；`failJob(ctx,claim,code:string):Promise<void>`；`publishReady(ctx,claim,revision):Promise<KnowledgeVersionRecord>`。只领取 uploadComplete 版本；提交解析保持 indexing 和当前 fence，发布 ready 才结束任务并切换有效版。

- [x] **Step 1: 写失败测试。** 测试名 `knowledge scope and limits`，断言：
  ```ts
  assert.equal(knowledgeUploadInputSchema.safeParse({...validInput, bytes:50*1024*1024+1}).success,false);
  assert.equal(await repo.getDocument(ctxSameTeamOtherActor,document.id),null);
  assert.equal(capabilitiesForHumanRole('sales').includes('finance.council.run'),false);
  ```
  本任务在 fixture 中定义 `validInput`、不同 actor/workspace 的 context；补聚合工作区拒绝、角色标签非法、重复 command 同 ID 与旧 revision 冲突。
- [x] **Step 2: 验证 RED。** `pnpm --dir backend exec node --import tsx --test src/knowledge/domain-test.ts`，应在缺失领域实现/断言处失败，不是测试运行器缺失。
- [x] **Step 3: 实现领域与合同。** 新权限加入各人类角色的本人资料能力，不授予财务权限；新知识库类型用现有 `generate-frontend-contract-types.mjs --input --output` 生成 `frontend/src/generated/knowledge.ts`。Growth 预定义可选 `knowledgeMode: auto|off`（默认 off，文本 UI 后续发送 auto）与 `KnowledgeAnswer` 投影，保持旧 answer/historical payload 合法。当前有效引用协议为1.0.38；既有1.0.37及其他发布字节不可覆盖。新增 `generate:knowledge-types/check:knowledge-types` 并纳入 `check:types`，执行既有 release→import→generate 链。Backend 新增 `test:knowledge`（`NODE_ENV=test node --import tsx --test src/knowledge/*-test.ts`），加入现有根 backend test 链，不让新测试游离于总门禁。
- [x] **Step 4: 验证 GREEN。** 运行领域测试、`pnpm --filter ./contracts check:knowledge-types`、`pnpm check:growth-contracts`、`pnpm --dir frontend contract:check`；schema、旧调用兼容、权限与生成结果通过。
- [x] **Step 5: 仅提交本任务可分离改动。** 消息 `feat: define scoped knowledge contracts`；不得一并提交其他已存在合同/权限修改。

### Task 2: 真实 MySQL 与私有原件生命周期

**Files:** Create `backend/src/knowledge/{mysql-repository,crypto,file-store}.ts`、`storage-test.ts`、`mysql-integration-test.ts`；Modify `backend/package.json`、`desktop/src/main/{app-paths,prepare-local-application,local-application-runtime}.ts`、`scripts/desktop-local-runtime.mjs` 及各自测试。

**Interfaces:** 消费 Task 1 repository。产出 `ensureKnowledgeMysqlSchema(pool):Promise<void>`、`MysqlKnowledgeRepository(pool,crypto)`；`createKnowledgeFileStore({root,secret})` 的 `writeOriginal(ctx,version,source:Readable,signal):Promise<{storageKey,sourceHash,bytes}>`、`withOriginal(ctx,version,consume,signal)`、`removeOriginal(ctx,version)`。后者先验证密文再向有权限消费者提供私有临时路径，finally 清理，不向 Renderer 返回路径。

- [x] **Step 1: 写失败测试。** `knowledge persisted and isolated`：
  ```ts
  assert.equal(reloadedVersion.sourceHash,uploadedHash);
  assert.equal(await restartedRepo.getDocument(otherActor,document.id),null);
  await assert.rejects(()=>fileStore.withOriginal(ctx,tamperedVersion,consume),/authentication|invalid/);
  ```
  用 `createFinancialCouncilMysqlTestDatabase({initializeSchemas:false})` 建自身表，关 pool 后另开 pool；补 AAD 换 actor/version、缺密钥、symlink、旧 worker fence、删除原件不删用户原路径及失败流/临时明文清理。原件写入后数据库提交失败的补偿由 Task 3 service 拥有并测试，file-store 不猜测数据库事务结果。
- [x] **Step 2: 验证 RED。** `pnpm --dir backend exec node --import tsx --test src/knowledge/storage-test.ts src/knowledge/mysql-integration-test.ts`；无显式 `MYSQL_TEST_ADMIN_URL` 时区分跳过，不能称原生 SQL 通过。
- [x] **Step 3: 实现存储。** MySQL 新表只幂等创建；事务控制 command/revision/claim 发布。加密使用明确稳定配置和独立知识文件 AAD；不继承随机 development fallback。Main 新增 `paths.knowledge`，通过可信 runtime environment 注入 root；源开发传自身持久私有目录。测试替身用独立临时 root，正常运行不读业务测试 URL。新增 `test:knowledge:mysql` 精确运行 `NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/knowledge/mysql-integration-test.ts`；原生验收要求实际配置后零跳过。
- [x] **Step 4: 验证 GREEN。** MySQL关闭/重建pool读回与文件测试真实通过，再运行 `pnpm --dir desktop exec tsx --test tests/app-paths.test.ts tests/local-application-runtime.test.ts tests/prepare-local-application.test.ts`、`node --test scripts/desktop-local-runtime.test.mjs`。仅清理测试自行创建的库/目录；完整daemon/Electron退出重启仍属于Task8，未配置的已有原生启动测试明确跳过。
- [x] **Step 5: 提交本任务可分离改动。** 消息 `feat: persist private knowledge versions`。

### Task 3: 认证上传、查询和桌面有界传输

**Files:** Create `backend/src/knowledge/{service,router,module}.ts`、`router-test.ts`、`module-test.ts`；Modify `backend/src/growth-commercial-{application,composition}.ts`、`growth-private-services.ts`、`desktop/src/main/renderer-server.ts` 及对应测试。

**Interfaces:** `createKnowledgeModule(options):GrowthCommercialModule` 初始化 SQL、注册 `KNOWLEDGE_SERVICE`，关闭时停止私有资源；缺 root/key 时返回 unavailable 能力而其他模块可启动。`KnowledgeService` 封装 Task 1 的资料读写，以及 `acceptOriginal(ctx,documentId,versionId,stream,revision,key,signal):Promise<KnowledgeVersion>`、`retry(ctx,documentId,versionId,revision,key)`、`cancel(ctx,jobId)`、`availability()`；成功接收原件后才持久化可领取任务。

- [x] **Step 1: 写失败测试。** `knowledge authenticated binary upload`：
  ```ts
  assert.equal(unauthenticatedResponse.status,401);
  assert.equal(otherActorDownload.status,404);
  assert.equal((await repo.getVersion(ctx,id,versionId))?.uploadComplete,false); // 断网
  assert.equal(ordinaryOversizedPost.status,413);
  ```
  补 CSRF、错误 MIME/文件签名、无 Content-Length 的超限流、声明字节不一致、重复上传 key、客户端中止、redirect、provenance 和 Cookie 保护；不可自动再次上传不确定是否完成的文件。
- [x] **Step 2: 验证 RED。** `pnpm --dir backend exec node --import tsx --test src/knowledge/router-test.ts src/knowledge/module-test.ts` 及 `pnpm --dir desktop exec tsx --test tests/renderer-server.test.ts`，新路由断言失败。
- [x] **Step 3: 实现准确路由。** `/api/v1/knowledge/documents` GET/POST；`/{id}` GET/PATCH/DELETE；`/{id}/versions` POST；`/{id}/versions/{versionId}` GET；该版 `/content` PUT 原始字节和 GET 授权原件；`/chunks` GET；`/retry` POST；`/jobs/{jobId}/cancel` POST；`/availability` GET。普通 JSON 保持 1MiB，PUT content 与 GET content 专用计数限 50MiB、专用传输时限 120 秒，不 Base64、不放宽其他路径。桌面这两个准确 method/path 使用 streaming 分支，普通分支不重写。鉴权前缀加入 `/api/v1/knowledge`；模块在 Council 消费前安装，用真实工作区 resolver、幂等和 ETag，不在 server 另设匿名路由。
- [x] **Step 4: 验证 GREEN。** 原命令、新 HTTP 响应合同检查与 `pnpm --dir backend test:growth-openapi` 通过。文件收完与 worker/索引完成分离，上传/列表/预览没有模型调用。
- [x] **Step 5: 提交本任务可分离改动。** 消息 `feat: expose authenticated knowledge uploads`。

### Task 4: 安全解析、OCR 与可恢复任务

**Files:** Create `backend/src/knowledge/{reader-gateway,ingestion-worker}.ts`、`reader-test.ts`、`worker-test.ts`；Create `services/knowledge-reader/{pyproject.toml,README.md,shensi_knowledge_reader.py}`、`tests/test_reader.py`；Modify Task 3 module/service 的 worker 装配与生命周期。

**Interfaces:** `KnowledgeReader.read({inputPath,format,bytes},signal):Promise<ParsedKnowledge>`；`KnowledgeIngestionWorker({repository,files,reader,authorizeJob,indexVersion,now}).runOnce(signal):Promise<boolean>`，`authorizeJob(claim):Promise<ActiveWorkspaceContext>` 从当前账号/工作区授权重新解析，不复用上传时权限快照。解析用 `commitParsed` 进入 indexing，worker 在检索回调成功且重新授权后调用 `publishReady`；Task 5 之前不提供可发布的索引回调，不显示 ready。

- [x] **Step 1: 写失败测试。** `knowledge reader coverage and fenced publication`：
  ```ts
  assert.equal(parsed.coverage.totalPages,3);
  assert.deepEqual(parsed.chunks.map(c=>c.locator.page),[1,2,3]);
  assert.equal(await staleWorker.runOnce(signal),false);
  assert.equal((await repo.getDocument(ctx,id))?.activeVersionId,newVersionId);
  ```
  fixture 含文本 PDF、扫描页、正常可读加密标志 PDF、需口令 PDF、DOCX 表格、XLSX 缓存公式、CSV/TXT/MD、异常 ZIP/XML。补删除/撤权后晚到结果、取消杀进程、重启租约、partial coverage 与错误不伪装 ready。
- [x] **Step 2: 验证 RED。** `pnpm --dir backend exec node --import tsx --test src/knowledge/reader-test.ts src/knowledge/worker-test.ts`；已有运行时用 `uv run --frozen --no-sync --active --project services/knowledge-reader python -B -m unittest discover -s services/knowledge-reader/tests -v`（锁文件在本任务建立，无需安装pytest）在实现缺失处失败，不重复启动原书籍任务。
- [x] **Step 3: 实现隔离 reader。** 有文本 PDF 使用本地安全读取，扫描页使用本地 Docling/macOS OCR；复用现有 PDF/DOCX/表格解析依赖和安全约束，单独长书预算，不改临时财务 reader。单 worker、租约 60 秒/每 20 秒续约、总解析时限 60 分钟；PDF 以最多 25 页分批，保持原物理页坐标。进程不持有密钥或模型凭据，禁远程解析/外部插件，启动器选择受控解释器；复用已安装工具，不硬编码旧临时 venv，不复制大依赖目录。OCR/表格/公式继承不确定性，无文本不是成功。正常可读的加密 PDF 走普通解码，不解密口令保护。
- [x] **Step 4: 验证 GREEN。** reader/worker/真实多格式 fixture 通过；`pnpm --dir backend test:finance-documents` 验证旧限制不变。记录所用依赖锁、模型资源来源和许可证，不将本地模型缓存打入本次产品包。
- [x] **Step 5: 提交本任务可分离代码/fixture。** 消息 `feat: parse knowledge with recoverable local jobs`；仅合成测试资料可进源码。

### Task 5: 可重建中文检索

**Files:** Create `backend/src/knowledge/retrieval.ts`、`retrieval-test.ts`；Modify `backend/package.json`、`pnpm-lock.yaml`、Task 3 module 和 Task 4 index 回调。

**Interfaces:** `KnowledgeRetriever.retrieve(ctx,{question,role},signal):Promise<KnowledgeEvidence>`；`indexVersion(ctx,versionId):Promise<void>`、`invalidate(ctx,documentId):void`。`KnowledgeEvidence` 是 `{status:'used'|'no_match'|'unavailable',sources:KnowledgeCitation[]}`；正文只在 server 已验证 sources 中，外层无路径。缓存从 scoped repository 重建，不能成为唯一持久来源。

- [x] **Step 1: 写失败测试。** `knowledge Chinese retrieval with scope and budget`：
  ```ts
  assert.equal((await retriever.retrieve(otherActor,{question:'全面预算',role:'cfo'})).sources.length,0);
  assert.ok(result.sources.length<=6);
  assert.ok(result.sources.reduce((n,s)=>n+s.excerpt.length,0)<=12000);
  assert.equal(deletedDocumentHit,false);
  ```
  增加无空格中文、现金流/回款近义问题、财务专业术语、企业名与连续编号、纯问候/无关题、角色过滤在 top-k 前、去重、索引重建不调用模型、异常返回 unavailable 而非 no_match。
- [x] **Step 2: 验证 RED。** `pnpm --dir backend exec node --import tsx --test src/knowledge/retrieval-test.ts`。
- [x] **Step 3: 实现检索。** 固定核验过的 MiniSearch 版本，使用一致中文分词、标题/章节权重和正常术语归一化；禁止无关匹配 fallback。两份 scoped 索引的 LRU 缓存，不持久化明文索引；已建和构建中索引的原始UTF-8输入合计上限 64MiB（不是V8堆硬上限），超限明确 unavailable，不隐藏截断。再次校验每条 hit 的当前权限/版本/启用状态；完成 indexing 后原子切换 activeVersion，旧版失效；停用/删除立刻失效缓存。
- [x] **Step 4: 验证 GREEN。** 检索测试与 Task 4 publication 测试通过；先对合成中文问答语料验证召回，再用私有首批资料抽查。若同义问题实测不满足此阶段标准，报告具体漏检例子，不无依据宣称语义检索已实现。
- [x] **Step 5: 提交本任务可分离改动。** 消息 `feat: retrieve scoped Chinese knowledge references`。

### Task 6: 知识库真实页面与状态

**Files:** Create `frontend/src/knowledge/{api,view,view-state}.ts`、`knowledge.css`、`view-state.test.ts`、`frontend/tests/knowledge-library.spec.ts`、`frontend/playwright.knowledge.config.ts`；Modify `frontend/index.html`、`src/app-route.ts`、`src/demo/{demo-types,demo-router,demo-app}.ts`、`frontend/package.json`。

**Interfaces:** `createKnowledgeApi({http,fetchImpl,csrf,workspaceId}):KnowledgeApi` 复用 JSON helper，新增 `uploadContent({documentId,versionId,file,etag,key,signal})` 的 binary helper。`mountKnowledgeLibrary(host,{api,onOpenCitation}):{dispose():void}`；统一使用生成 DTO、limit/cursor 服务端分页，不发全库到 Renderer。

- [x] **Step 1: 写失败测试。** `knowledge route lifecycle and upload states`：
  ```ts
  assert.equal(normalizeAppHash('#knowledge'),'#knowledge');
  assert.equal(await page.getByText('知识库',{exact:true}).count()>0,true);
  assert.equal(await page.locator('[data-knowledge-state="ready"]').count(),1);
  assert.equal(staleIdentityResultVisible,false);
  ```
  补同路由更新不重复 mount、离页/登出取消请求、工作区变化清除、失败可重试、原件已上传但索引未完不可用于问答、十份限制、角色/版本编辑、停用/删除，以及 inspector 不残留。
- [x] **Step 2: 验证 RED。** `pnpm --dir frontend exec tsx --test src/knowledge/view-state.test.ts`；`pnpm --dir frontend exec playwright test --config=playwright.knowledge.config.ts`，新页面断言失败。
- [x] **Step 3: 实现页面。** 沿真实模块壳挂载 `#knowledge`，复用 `mountEnterpriseQuery` 的 DOM 生命周期与现有上传 generation/cancel 思路。列表和详情独立，真实服务状态轮询仅更新变化部分，不抢焦点/滚动；显示书籍/公司资料/其他参考分类、六角色、来源位置和缺失提示。用现有 CSRF、workspace、幂等键及错误 envelope；不把 File 交给 JSON.stringify helper。
- [x] **Step 4: 验证 GREEN。** 两项新测试、`pnpm --dir frontend test:theme`、`pnpm --dir desktop exec tsx --test tests/renderer-server.test.ts` 通过；黑绿/蓝白在 1440、1024、390 宽度分别验证正常/选中/禁用/失败/成功状态。
- [x] **Step 5: 提交本任务可分离改动。** 消息 `feat: add persistent knowledge library workspace`。

### Task 7: 六角色详细回答、数值边界与引用历史

**Files:** Create `backend/src/knowledge/answer.ts`、`answer-test.ts`、`agent-integration-test.ts`；Modify `growth-financial-council-module.ts`、`financial-council-agent-center.ts`、`cfo-conversation.ts`、`finance-document-{service,model}.ts`、`cfo-conversation-session-repository.ts`；Modify 前端 `growth/agents/{cfo-conversation,cfo-chat-messages,cfo-session-view}.ts` 及对应测试。

**Interfaces:** Council 注入 Task 5 `KnowledgeRetriever`。`buildKnowledgeModelEvidence(evidence:KnowledgeEvidence):BoundedKnowledgeEvidence` 返回只含本次合法片段的源 ID/text/locator/warnings；`renderKnowledgeAnswer(raw:unknown,{evidence,renderCompanyText:(template:string)=>string}):KnowledgeAnswer`，raw schema 为 `{template:string,citationIds:string[]}`。后者产出 `{status,detailedText,sources,warnings}`，detailedText 最多 12,000 字符，sources 最多六条。`{{knowledge:sourceId}}` 只替换本次服务端精确摘录；其他模板段委托既有 `renderFinancialAnswer` 或原件 observation validator，分别保留 `{{fact:id}}` 和 `{{cell/pdf/docx:...}}` 规则，不将上传资料升格为企业事实。替换后的总字数再次校验，不静默截断。CFO turn 可选保存同版 `knowledge` 快照，旧 text 限制和旧历史仍有效。

- [ ] **Step 1: 写失败测试。** `six roles retrieve before model and preserve financial authority`：
  ```ts
  assert.deepEqual(order,['retrieve','model']);
  assert.equal(result.knowledge?.sources[0]?.versionId,expectedVersionId);
  assert.equal(result.answer.length<=4000,true);
  assert.equal(result.knowledge!.detailedText.length<=12000,true);
  assert.throws(()=>renderKnowledgeAnswer({template:'{{knowledge:missing}}',citationIds:['missing']},renderContext),/source|reference/);
  ```
  参数化六角色、显式附件和已核实报表两条模型路径；补书籍年份/税率/金额精确引用、模型编造金额拒绝、文档提示注入、冲突资料、不将私有片段送 public search、角色切换取消、CFO 重启恢复与删除来源提示，语音/旧 payload 不启用新详细模式。模型返回前资料被停用/删除或权限撤销时，复核拒绝该参考回答与历史写入，不自动重放模型。
- [ ] **Step 2: 验证 RED。** `pnpm --dir backend exec node --import tsx --test src/knowledge/answer-test.ts src/knowledge/agent-integration-test.ts`；对应 frontend 引用/历史 self-test。
- [ ] **Step 3: 实现接入。** 文本 UI 默认发送 Task 1 `knowledgeMode:'auto'`，其问答和 CFO session turn 都在模型前执行检索；旧 caller/语音默认 off。参考数据独立于 system/verified financial facts，保留角色和企业来源优先级。模型一次结构化回答同时生成简短 answer 与可选详细投影，不额外扇出六模型。`no_match` 可显示明确无命中再一般回答，unavailable 明确降级；引用来源由 server 生成，不接收模型文件路径/链接。前端可打开知识库同版片段，历史带 snapshot；不能将内部引用塞进仅接受公开 http 来源的 research 面板。
- [ ] **Step 4: 验证 GREEN。** 新专项、`pnpm --dir backend test:cfo-conversation`、`pnpm --dir backend test:finance-documents`、`pnpm --dir frontend exec tsx scripts/test-agent-chat-layout.mts`、`pnpm check:growth-contracts` 通过；双主题长回答/引用/输入可达，不滚动跳回，不改变正式委员会三表要求。
- [ ] **Step 5: 提交本任务可分离改动。** 消息 `feat: ground specialist answers in private references`。

### Task 8: 私有书籍导入、实机验收与当前文档

**Files:** Create `backend/scripts/import-knowledge-references.ts`、`backend/src/knowledge/pre-extracted-reader.ts`、`pre-extracted-reader-test.ts`、`docs/modules/knowledge-base.md`；Modify README、PROJECT_STATUS、ARCHITECTURE、API_INDEX、`docs/modules/{agent-specialist-skills,finance-document-reading,file-upload-inventory}.md`、`scripts/source-content-manifest.mjs`/测试及需要纳入新源码的构建清单。

**Interfaces:** `validatePreExtractedSource({sourcePath,artifactPath,expectedHash}):Promise<ParsedKnowledge>` 核对真实源 hash、页数、Docling page provenance、覆盖与限制，不宣称文字全精确。私有 CLI 仅接受已授权的精确 manifest 和正常配置身份，调用知识服务/worker，不开公开 pre-extracted 上传后门、不手写产品表或替换数据库。CLI 参数为 `--manifest <private-manifest> --workspace <id> --account <name>`，凭据按正常登录获取而不放在参数/源码/日志；干跑列数后才实际导入。

- [ ] **Step 1: 写失败测试。** `pre-extracted imports preserve provenance without reparsing`：
  ```ts
  assert.equal(parsed.coverage.totalPages,fixturePhysicalPages);
  assert.equal(parsed.warnings.includes('table_unverified'),true);
  assert.equal(ocrCallCount,0);
  await assert.rejects(()=>validatePreExtractedSource(changedFixture),/hash|source/);
  ```
  补少页/错页/缺章不补写、同 hash 重复导入不多造版本、已有源文件不修改、生成文件/安装清单不含私有书籍和衍生正文。
- [ ] **Step 2: 验证 RED。** `pnpm --dir backend exec node --import tsx --test src/knowledge/pre-extracted-reader-test.ts`；`node --test scripts/source-content-manifest.test.mjs` 的新排除断言。
- [ ] **Step 3: 实际导入与验收。** 复用现有私有提取成果，仅给批准的本地账号/工作区导入21份；自动角色归类是用户可编辑建议。用正常开发窗口验证上传新合成文件、退出重启、停用/删除、书籍页码和六角色各一条真实当前配置模型回答；历史书籍/公式/税法是否适用逐案判断。另一独立账号从 API/页面均不可读。保存有界私有验收结果，不能用 fixture 成功替代真实模型或全部书籍质量审核。
- [ ] **Step 4: 收尾验证与同步。** 运行新知识库专项/真实 MySQL专项、双主题 browser 测试、根 `pnpm test`、`pnpm build`、`./scripts/context-check`、`git diff --check`。源码窗口用 `pnpm desktop:local`，不打安装包。当前模块文档写实际能力和限制；按 AGENTS 精选源码备份排除私有资料/运行数据/依赖缓存，确认远端 revision 后才报告备份成功。
- [ ] **Step 5: 提交本任务可分离改动并交付。** 消息 `docs: document and verify local knowledge workflow`；说明实际入口、21份覆盖、未可靠提取部分及已验证/未验证边界，实际全部完成后停用知识库跟进。

## 执行建议

采用已批准的 **Native**：由主代理在本聊天顺序实现八个相互依赖的任务，最后独立审查；不会每个阶段再打开新聊天或打包应用。只读上下文调查可以并行，生产实现由主代理完成。
