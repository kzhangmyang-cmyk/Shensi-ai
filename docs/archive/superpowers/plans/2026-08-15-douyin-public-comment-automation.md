# 抖音公开评论获客自动化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让获客中心在计划批准后真实、自动地读取公开抖音视频的一级评论样本，形成不可变平台事件、可审计需求信号和 AI 资格研判，并以深绿/暖白的现有风格展示服务端真实执行时间线、计数、证据和失败原因。

**Architecture:** 在现有 Plan → Run → Shard → Evidence → Candidate → Qualification 链路中增加可替换的 `experimental_public_sample` 来源适配器。适配器只做“`videoId` → 有界的公开一级评论样本”；评论先写入租户隔离的不可变事件与采集观测，再转成 Discovery Evidence，以 `sec_uid`/公开 handle 聚合为个人候选人，进入现有研究、资格判断、作战卡和人工审核。Run Presentation 从已持久化的分片、采集观测、事件和候选投影组装自动化时间线；前端不设假计时器、假评论或假数量。

**Tech Stack:** TypeScript 5.7，Node.js 22，Express，MySQL 8 / in-memory repositories，Zod，JSON Schema / OpenAPI，Vite，现有 DOM 视图控制器，Node test runner，Playwright。

## Global Constraints

- 公开评论 Provider 固定标识为 `experimental_public_sample`，覆盖语义固定为 `public_top_level_sample`；客户文案不得出现“全量评论”“扫描整个抖音”。
- Provider 只允许访问代码内固定的 HTTPS 抖音公开主机；不接收用户自定义 endpoint，不使用 Cookie、登录态、私有签名、代理池、验证码或浏览器模拟。
- 第一阶段只读一级评论正文；二级回复只记录公开返回的 `replyCount`，不读取回复正文。
- 不保存或展示评论者头像，不下载人脸资产，不做人脸识别；`ipLabel` 只用于证据展示和用户配置的粗粒度地区匹配。
- 事件幂等键固定为 `ownerId + teamId + platform + platformEventId`；缺少平台评论 ID 时记录 `source_payload_invalid`，不创建事件。
- 事件原文不可覆盖。重新采集只新增 observation；若公开原文哈希变化，新证据通过 `supersedesEvidenceId` 关联，历史事件保持不变。
- 定性规则只提取正向、负向和噪音信号。单条“多少钱”不得直接标为已确认高意向客户；身份未核验的强信号只显示“高潜需求信号”。
- 一个视频失败不得丢弃同 Run 已采集的其他事件；时间线必须保留稳定错误码，并以 `partial_success` 结束。
- CI 和普通单元测试只使用固定 fixture，不访问真实抖音。真实网络验证只能通过显式的手工 smoke 命令执行。
- 新增计划限制不得绕过现有 Run 预算：评论 HTTP 请求计入 `maxRequests`，接受的评论计入 `maxResults`，并额外限制每 Run 视频数、每视频评论数和页数。
- 正式页面只渲染 API 真实数据；运行中只轮询服务端状态，不用前端随机数或倒计时增加评论数。
- 前端修改保持当前深绿/暖白、圆角卡片、紧凑商务信息密度；不引入第二套 UI 框架。
- 不修改或提交 `GoodJob-marketing-system-frontend` 工作树中执行前已记录的用户文件（当前为未跟踪 `package-lock.json`）。
- 移植或改写开源实现时，必须在 `THIRD_PARTY_NOTICES.md` 中记录仓库、commit、原文件、许可证、用途和改动。

---

### Task 1: 可替换的抖音公开评论样本 Provider

**Files:**
- Create: `backend/src/douyin-public-comment-provider.ts`
- Create: `backend/src/douyin-public-comment-provider-test.ts`
- Create: `backend/src/douyin-public-comment-live-smoke.ts`
- Modify: `backend/package.json`
- Create: `THIRD_PARTY_NOTICES.md`

**Interfaces:**
- `resolveDouyinVideoId(sourceUrl)` 只从 `douyin.com/video/<digits>`、`iesdouyin.com/share/video/<digits>` 和经现有受控短链解析后的 final URL 取 ID；不依赖作品元数据解析。
- `DouyinPublicCommentProviderPort.fetchTopLevelSample(input)` 输入 `videoId`、`sourceUrl`、`cursor`、`count`、`signal`；输出 `DouyinPublicCommentSamplePage`。
- `DouyinPublicCommentSamplePage` 包含 `comments`、`nextCursor`、`hasMore`、`reportedCommentCount`、`capturedAt`、`rawArtifactHash`、`providerVersion`、`coverage` 和 `replyBodiesIncluded: false`。
- `DouyinPublicComment` 只含 `commentId`、`text`、`occurredAt`、`likeCount`、`replyCount`、`ipLabel`、`actor.displayName`、`actor.handle`、`actor.secUid`；显式忽略 avatar 字段。
- 稳定错误码：`public_sample_unavailable | access_restricted | rate_limited | video_id_unresolved | source_payload_invalid | no_public_comments`。

  ```ts
  export interface DouyinPublicCommentProviderPort {
    fetchTopLevelSample(input: {
      videoId: string;
      sourceUrl: string;
      cursor: number;
      count: number;
      signal?: AbortSignal;
    }): Promise<DouyinPublicCommentSamplePage>;
  }
  ```

- [ ] **Step 1: 写 URL 解析、字段归一化、去重、游标保护和错误映射失败测试**

  在测试内嵌入最小脱敏 JSON fixture，覆盖：直接视频 URL、分享 URL、非抖音 URL、同页重复 `cid`、跨页重复、游标不前进、429 + `Retry-After`、受限响应、空评论和缺少 `cid`。断言输出中没有 avatar URL、Cookie 或任何登录字段。

- [ ] **Step 2: 运行 RED**

  Run: `npm exec --workspace backend -- tsx --test src/douyin-public-comment-provider-test.ts`

  Expected: FAIL，因为 Provider 类型和实现尚不存在。

- [ ] **Step 3: 实现最小 Provider**

  将 HTTP transport 注入构造器，生产适配器只请求代码内固定的抖音公开评论列表 endpoint。对每页以 `commentId` 去重；下一游标与已访问游标相同时立即停止并标记部分成功。重试只允许临时网络失败、429 和 5xx，上限 2 次，遵守 `Retry-After`。

  手工 smoke 脚本必须要求 `DOUYIN_PUBLIC_COMMENT_SMOKE=1` 和 `DOUYIN_VIDEO_ID`，否则不发网络请求并以明确说明退出。

- [ ] **Step 4: 运行 GREEN 与类型检查**

  Run: `npm exec --workspace backend -- tsx --test src/douyin-public-comment-provider-test.ts && npm run build --workspace backend`

  Expected: PASS；测试运行时网络请求数为 0。

- [ ] **Step 5: 记录开源来源并提交**

  `THIRD_PARTY_NOTICES.md` 记录 `JNHFlow21/social-media-toolkit@ed2f3cbdc47e6761736e915cfeb1ce1fbb364d96` 的 `social_media_toolkit/platforms/core.py` 和 `tests/test_social_extractor.py` (Apache-2.0)，以及 `jiji262/douyin-downloader@ad7338fdc474c14e2063370540a362cd8a953b43` 的 `core/comments_collector.py` 和 `tests/test_comments_collector.py` (MIT)；只记录实际改写的窄范围，不纳入其 Cookie/签名/规避代码。

  ```bash
  git add backend/src/douyin-public-comment-provider.ts backend/src/douyin-public-comment-provider-test.ts backend/src/douyin-public-comment-live-smoke.ts backend/package.json THIRD_PARTY_NOTICES.md
  git commit -m "feat: add bounded douyin comment provider"
  ```

### Task 2: 评论样本计划策略与版本化合同

**Files:**
- Modify: `backend/src/acquisition-plan-run-repository.ts`
- Modify: `backend/src/acquisition-plan-contract.ts`
- Modify: `backend/src/acquisition-plan-contract-test.ts`
- Modify: `contracts/json-schema/acquisition-plan.v1.schema.json`
- Create: `contracts/json-schema/douyin-comment-event.v1.schema.json`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `contracts/test/schema-registry.test.mjs`
- Modify: `contracts/README.md`
- Modify (generated): `frontend/src/features/ai-growth/generated/ai-acquisition.ts`

**Interfaces:**
- `AcquisitionPlanPayload.douyinPublicCommentSample` 为可选严格对象：`enabled`、`maxVideosPerRun` (1..20)、`maxCommentsPerVideo` (1..100)、`maxPagesPerVideo` (1..5)；非抖音计划禁止启用。
- `douyin-comment-event.v1` 按已批准设计定义 `eventId/platform/eventType/platformEventId/videoId/parentCommentId/text/textHash/occurredAt/capturedAt/likeCount/replyCount/ipLabel/actor/sourceUrl/coverage/accessStatus/providerVersion/rawArtifactHash`。
- 现有 `platform-event.v1` 作为通用平台信封保持向后兼容；新评论 schema 是其 `platformEventRef/platformContentRef/platformSubjectRef` 的抖音具体负载，不破坏已发布 v1。

  ```ts
  export interface DouyinPublicCommentSamplePolicy {
    enabled: boolean;
    maxVideosPerRun: number;
    maxCommentsPerVideo: number;
    maxPagesPerVideo: number;
  }
  ```

- [ ] **Step 1: 先写 schema 和 Zod 失败测试**

  断言允许合法的抖音样本策略，拒绝超上限、额外字段和 web 计划启用评论。对事件 schema 断言 `parentCommentId` 必须为 null、`coverage` 只能为 `public_top_level_sample`、没有 avatar 字段，且摘要为 `sha256:` + 64 位小写十六进制。

- [ ] **Step 2: 运行 RED**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-plan-contract-test.ts && npm run test:contracts`

  Expected: FAIL，因为计划字段和评论事件 schema 尚不存在。

- [ ] **Step 3: 实现合同并保持旧计划兼容**

  字段保持可选：旧计划没有它时等价于 `enabled: false`；新抖音计划由前端明确提交策略。运行层以服务端上限和计划值取更严者。

- [ ] **Step 4: 运行 GREEN 与合同漂移检查**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-plan-contract-test.ts && npm run test:contracts && npm run generate:frontend-contract-types && npm run check:generated-acquisition-types`

  Expected: PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add backend/src/acquisition-plan-run-repository.ts backend/src/acquisition-plan-contract.ts backend/src/acquisition-plan-contract-test.ts contracts/json-schema/acquisition-plan.v1.schema.json contracts/json-schema/douyin-comment-event.v1.schema.json contracts/openapi/ai-acquisition.v1.yaml contracts/test/schema-registry.test.mjs contracts/README.md frontend/src/features/ai-growth/generated/ai-acquisition.ts
  git commit -m "feat: define douyin comment sample contracts"
  ```

### Task 3: 不可变评论事件、采集观测和 MySQL 持久化

**Files:**
- Create: `backend/src/acquisition-douyin-comment-events.ts`
- Create: `backend/src/acquisition-douyin-comment-events-test.ts`
- Create: `backend/src/acquisition-douyin-comment-events-mysql-repository.ts`
- Create: `backend/src/acquisition-douyin-comment-events-mysql-repository-test.ts`
- Modify: `backend/src/acquisition-application.ts`

**Interfaces:**
- `AcquisitionDouyinCommentEventRepository.appendObservation(input)` 返回 `{ event, observation, eventCreated, contentChanged, contentVersion, ingestionSaga }`。
- `getRunCommentPresentationProjection(scope, runId)` 在仓储内聚合整个 Run 的 fetch attempt、终态候选、错误和 saga/link 完整度；`listRunCommentSignalsForPresentation` 使用 10001 条探针执行 10000 条硬保护，公开 `commentSignals` 仍只取最近 50 条。每个 event link 固定关联当次 `observationId`，同 Run 同事件多次观测按规范化 `capturedAt` 和确定性 ID 顺序取最新值，后续 Run 不改变历史 Run 快照。
- `DouyinCommentFetchAttempt` 持久化 `runId | null`、`shardId | null`、`discoveryOperationId | null`、`sourceUrl`、`videoId | null`、`status`、`errorCode | null`、`requestedCount`、`returnedCount`、`reportedCommentCount | null`、`pagesFetched`、`startedAt`、`completedAt`。
- MySQL 表：`acquisition_douyin_comment_events`、`acquisition_douyin_comment_observations`、`acquisition_douyin_comment_content_versions`、`acquisition_douyin_comment_ingestion_sagas`、`acquisition_douyin_comment_event_links`、`acquisition_douyin_comment_fetch_attempts`；所有查询带 `owner_id + team_id`。

  ```ts
  export interface AcquisitionDouyinCommentEventRepository {
    appendObservation(
      input: AppendDouyinCommentObservationInput
    ): Promise<{
      event: DouyinCommentEvent;
      observation: DouyinCommentObservation;
      eventCreated: boolean;
      contentChanged: boolean;
      contentVersion: DouyinCommentContentVersion;
      ingestionSaga: DouyinCommentIngestionSaga | null;
    }>;
    getRunCommentSummary(
      scope: AcquisitionScope,
      runId: string
    ): Promise<DouyinRunCommentSummary>;
  }
  ```

- [ ] **Step 1: 写内存仓储合同失败测试**

  覆盖同租户同 `cid` 幂等，不同租户不冲突，重新采集新增 observation，原文变化返回 `contentChanged: true` 但不覆盖 event.text，点赞/回复计数投影取最新 observation，跨租户 Run 查询返回空。

- [ ] **Step 2: 运行 RED**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-douyin-comment-events-test.ts`

  Expected: FAIL，因为 repository 不存在。

- [ ] **Step 3: 实现内存仓储，再写 MySQL 失败测试**

  MySQL 测试使用现有测试数据库约定，断言唯一索引 `owner_id, team_id, platform, platform_event_id`、事务内幂等竞争、按 Run 聚合计数与租户隔离。

- [ ] **Step 4: 实现 MySQL repository 并挂载 schema**

  不向已经超大的 `acquisition-mysql-repositories.ts` 继续堆表；使用独立 `ensureAcquisitionDouyinCommentEventsMysqlSchema(pool)` 和 repository，在 application factory 中与其他聚焦仓储同级注入。Schema 在专用连接上以固定 migration advisory lock 串行；旧 saga 表的恢复列通过 `information_schema.columns` 精确检查，pending 索引通过 `information_schema.statistics` 按列顺序校验并从旧三列形状重建为五列形状，仅使用固定白名单 `ALTER TABLE`，并在首次 recovery sweep 前完成 schema。

- [ ] **Step 5: 运行 GREEN 并提交**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-douyin-comment-events-test.ts src/acquisition-douyin-comment-events-mysql-repository-test.ts && npm run build --workspace backend`

  ```bash
  git add backend/src/acquisition-douyin-comment-events.ts backend/src/acquisition-douyin-comment-events-test.ts backend/src/acquisition-douyin-comment-events-mysql-repository.ts backend/src/acquisition-douyin-comment-events-mysql-repository-test.ts backend/src/acquisition-application.ts
  git commit -m "feat: persist douyin comment events"
  ```

### Task 4: 评论证据、主体聚合与确定性需求信号

**Files:**
- Create: `backend/src/acquisition-douyin-comment-ingestion.ts`
- Create: `backend/src/acquisition-douyin-comment-ingestion-test.ts`
- Modify: `backend/src/acquisition-domain.ts`
- Modify: `backend/src/acquisition-domain-test.ts`
- Modify: `contracts/json-schema/discovery-evidence.v1.schema.json`
- Modify: `contracts/json-schema/individual-demand-signal.v1.schema.json`
- Modify: `contracts/test/schema-registry.test.mjs`

**Interfaces:**
- 新证据 provenance `platform_public_event` 包含 `sourceUrl`、`platformEventId`、`providerVersion`、`coverage`；`accessStatus` 为 `public_content`。
- `classifyDouyinCommentIntent(text)` 返回 `band: strong_signal | potential_signal | noise | negative`、`positiveSignals`、`negativeSignals`、`reasons`、`buyingStage`、`confidence`。
- `AcquisitionDouyinCommentIngestionService.ingestSample(input)` 输入 scope/run/shard/discovery operation 上下文、来源 URL 和 Provider sample；输出 `eventCount`、`evidenceCount`、`candidateIds`、`unresolvedActorCount`、`strongSignalCount`、`invalidCommentCount`。
- 主体键：`douyin:sec_uid:<secUid>`；无 `secUid` 但有 handle 时用 `douyin:handle:<normalized-handle>` 且保持 `needs_research`；两者都无时用 `unmergeable:douyin:comment:<cid>`。

  ```ts
  export type DouyinCommentIntentBand =
    | "strong_signal"
    | "potential_signal"
    | "noise"
    | "negative";

  export function classifyDouyinCommentIntent(
    text: string
  ): DouyinCommentIntentDecision;
  ```

- [ ] **Step 1: 写规则与聚合失败测试**

  黄金样本至少覆盖询价、报价/预算、采购/供应商、加盟/合作、交付时间、业务痛点、反营销/勿扰、纯表情、抽奖互动、复制灌水和单独“多少钱”。断言单独“多少钱”最多为 `potential_signal`；同 `secUid` 多评论聚合为同一候选，无身份评论不相互合并。

- [ ] **Step 2: 运行 RED**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-douyin-comment-ingestion-test.ts src/acquisition-domain-test.ts`

  Expected: FAIL，因为新 provenance、分类器和 ingestion service 尚不存在。

- [ ] **Step 3: 实现证据与主体聚合**

  每条有效评论先在事件仓储的同一本地事务中持久事件、当次观测、`eventId + textHash` 首次内容版本和 `pending` ingestion saga。内容版本保留精确有界原文、首次观测 ID 和真实 Provider 页面制品哈希。随后以 `comment:<eventId>:evidence:<textHash>` 追加 Discovery Evidence，并通过现有 `AcquisitionIndividualSignalIngestionPort` upsert 候选。同一内容版本的后续页面制品只新增观测，不改变证据原文、制品哈希或已持久主体。证据、Domain 幂等记录、候选与目录索引、事件链接及 saga `committed` 在共享 ingestion unit of work 中原子提交；内存实现使用串行化快照事务，MySQL 实现使用同一连接与数据库事务。内存完成边界与独立个人信号入库统一按 `CandidateDirectory → Domain → Events` 取锁，嵌套事务复用当前上下文；各内存仓储的独立写方法也排入同一事务串行队列，防止回滚快照覆盖并发成功写。任一侧失败都恢复失败前候选/证据/审计/幂等/目录快照并不生成 Run 成功事实。MySQL 命名锁释放必须返回 `1`，查询失败、`0` 或 `NULL` 都销毁连接而不放回池。Recovery sweeper 持久租约、尝试次数、下次时间和非 PII 错误码，逐条隔离故障并退避；诊断回调只接收 code/stage/attempt/不可逆 saga hash，不接收原始异常、评论、主体标识或 URL；应用在 schema 完成后执行首次 sweep，定时恢复，关闭时排空。已有个人候选合并后续需求摘要、只升不降的购买阶段和负向信号并集，不覆盖主体身份字段。`demandSummary` 保留有界公开原文和可审计信号理由，不将规则推断写成客户身份事实。

- [ ] **Step 4: 运行 GREEN 与合同测试**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-douyin-comment-ingestion-test.ts src/acquisition-domain-test.ts && npm run test:contracts`

  Expected: PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add backend/src/acquisition-douyin-comment-ingestion.ts backend/src/acquisition-douyin-comment-ingestion-test.ts backend/src/acquisition-domain.ts backend/src/acquisition-domain-test.ts contracts/json-schema/discovery-evidence.v1.schema.json contracts/json-schema/individual-demand-signal.v1.schema.json contracts/test/schema-registry.test.mjs
  git commit -m "feat: aggregate douyin comment demand signals"
  ```

### Task 5: 把评论富化接入搜索和用户链接的真实 Run

**Files:**
- Create: `backend/src/acquisition-douyin-comment-enrichment.ts`
- Create: `backend/src/acquisition-douyin-comment-enrichment-test.ts`
- Modify: `backend/src/acquisition-search-shard-processor.ts`
- Modify: `backend/src/acquisition-search-shard-processor-test.ts`
- Modify: `backend/src/acquisition-discovery-operations.ts`
- Modify: `backend/src/acquisition-discovery-operations-test.ts`
- Modify: `backend/src/acquisition-discovery-mysql-repository.ts`
- Modify: `backend/src/acquisition-discovery-mysql-repository-test.ts`
- Modify: `backend/src/acquisition-douyin-comment-events.ts`
- Modify: `backend/src/acquisition-douyin-comment-events-mysql-repository.ts`
- Modify: `backend/src/acquisition-douyin-comment-events-mysql-repository-test.ts`
- Modify: `backend/src/douyin-public-comment-provider.ts`
- Modify: `backend/src/douyin-public-comment-provider-test.ts`
- Modify: `backend/src/acquisition-pi-tools.ts`
- Modify: `backend/src/acquisition-tool-executor.ts`
- Modify: `backend/src/acquisition-discovery-recovery-sweeper.ts`
- Modify: `backend/src/acquisition-discovery-recovery-sweeper-test.ts`
- Modify: `backend/src/acquisition-discovery-shard-processors.ts`
- Modify: `backend/src/acquisition-discovery-shard-processors-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-discovery-operations-router-test.ts`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `backend/src/acquisition-openapi-response-conformance-test.ts`
- Modify: `contracts/json-schema/content-fetch-operation.v1.schema.json`

**Interfaces:**
- `AcquisitionDouyinCommentEnrichmentPort.enrich(input)` 输入 scope、run/shard 可空上下文、来源 URL/candidate IDs、计划策略、剩余预算和 AbortSignal；输出新候选 IDs、usage、计数和部分错误。
- 搜索分片次序：`search_public_sources` → 验证完整且与当前 owner/team、连接及查询匹配的 `search_result` Evidence → 筛出抖音视频 URL → 评论富化 → 验证真实 usage 未越过传入预算 → 合并/去重 candidate IDs → 现有 `AcquisitionCandidateProcessingPipeline.process`。Run worker 使用内部 tenant-scoped projection，普通工具返回不包含 owner/team。跨页评论/游标状态只在当次 enrichment 内存在，HTTP 重试及响应后解析/归一化失败都按真实 transport 请求数计费。
- content-fetch 原页执行与评论富化分离。每个 direct 或 `runId + shardId` 调用方持久独立 execution context、策略、剩余预算、租约、退避和终态 summary；不能复用另一调用方的 running/terminal 结果。用户显式提交单独链接时在 operation create 同一写入中持久 `1/30/3` intent；Run 使用自身计划和剩余预算。Recovery sweeper 无需调用方 replay 即可恢复，逐项隔离 poison work，公开 DTO 不暴露内部 execution 状态。
- standalone intent 纳入版本化 request hash，同键切换值稳定冲突；原页失败或无 final URL 时评论 execution 以 `BASE_CONTENT_FETCH_FAILED` 终止。单 operation 最多 1000 个 execution，MySQL 对 ID、context 与状态/租约组合严格验证。
- 每个视频的首次终态 attempt 持久 transport/耗时、event/evidence/candidate 和聚合计数；精确重放只聚合该投影，MySQL 重启或评论变化均不再请求 Provider/ingestion。旧 attempt 无投影时仅保守使用已有终态计数。
- 计划未启用评论策略或来源不是抖音视频时为安全 no-op，不影响旧计划。
- `no_public_comments` 是可解释空覆盖而不是 failed result；混合成功仍为 succeeded，全部为空为 `succeeded_empty`。
- 内置评论连接只信任 canonical `douyin-public-comments + experimental_public_sample + content_fetch + active + credentialVersion=1`。Discovery MySQL schema 在 recovery 前使用专用连接和 advisory lock 串行升级，锁失败会销毁会话。
- Content-fetch 公共 schema 要求 `candidateCount === candidateIds.length`，合法上限为 101。

  ```ts
  export interface AcquisitionDouyinCommentEnrichmentPort {
    enrich(
      input: AcquisitionDouyinCommentEnrichmentInput
    ): Promise<AcquisitionDouyinCommentEnrichmentResult>;
  }
  ```

- [x] **Step 1: 写编排失败测试**

  断言评论富化发生在资格研判前；新候选与搜索候选去重；评论请求/结果计入分片 usage；达到 max videos/comments/pages 或 Run 剩余预算时立即停止；单视频 429/受限保留其他视频成果；AbortSignal 不再开新请求。补充 direct-first/Run-first 并发、terminal 后另一 context、crash replay、transport retry 记账、严格 Evidence、canonical connection、schema migration lock、candidateCount 关系和空覆盖组合状态。

- [x] **Step 2: 运行 RED**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-douyin-comment-enrichment-test.ts src/acquisition-search-shard-processor-test.ts src/acquisition-discovery-operations-test.ts src/acquisition-discovery-operations-router-test.ts src/acquisition-discovery-shard-processors-test.ts`

  Expected: FAIL。

- [x] **Step 3: 实现搜索分片的纵向链路**

  `AcquisitionSearchShardProcessor` 增加可选 comment enrichment port，并在严格结果验证之后、candidate pipeline 之前执行。分片最终 status 为搜索和评论富化的组合结果；有已接受证据且有局部失败时为 `partial_success`。

- [x] **Step 4: 实现 content-fetch/单独用户链接链路并注入 application**

  Discovery operation 返回增加 `commentSampleSummary`；content-fetch shard processor 把当前 Run execution 产生的 candidate IDs 送入现有 pipeline。内部持久 execution saga 支持 tenant-scoped lease、bounded backoff、restart recovery 和 caller-specific projection。Application 在 memory/MySQL 两种模式下注入同一 Provider、event repository 和 enrichment service，并在 schema 完成后启动 recovery lifecycle。

- [x] **Step 5: 运行 GREEN、应用测试并提交**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-douyin-comment-enrichment-test.ts src/acquisition-search-shard-processor-test.ts src/acquisition-discovery-operations-test.ts src/acquisition-discovery-operations-router-test.ts src/acquisition-discovery-shard-processors-test.ts src/acquisition-application-test.ts src/acquisition-openapi-test.ts src/acquisition-openapi-response-conformance-test.ts && npm run build --workspace backend`

  ```bash
  git add backend/src/acquisition-discovery-mysql-repository-test.ts backend/src/acquisition-discovery-mysql-repository.ts backend/src/acquisition-discovery-operations-test.ts backend/src/acquisition-discovery-operations.ts backend/src/acquisition-douyin-comment-enrichment-test.ts backend/src/acquisition-douyin-comment-enrichment.ts backend/src/acquisition-douyin-comment-events-mysql-repository-test.ts backend/src/acquisition-douyin-comment-events-mysql-repository.ts backend/src/acquisition-douyin-comment-events.ts backend/src/acquisition-pi-tools.ts backend/src/acquisition-search-shard-processor-test.ts backend/src/acquisition-search-shard-processor.ts backend/src/acquisition-tool-executor.ts backend/src/douyin-public-comment-provider-test.ts backend/src/douyin-public-comment-provider.ts contracts/README.md docs/superpowers/specs/2026-08-15-douyin-public-comment-automation-design.md docs/superpowers/plans/2026-08-15-douyin-public-comment-automation.md .superpowers/sdd/2026-08-15-douyin-public-comment-automation/task-5-report.md
  git commit -m "feat: automate douyin comment enrichment"
  ```

### Task 6: 真实自动化时间线、高潜评论与 OpenAPI

**Files:**
- Modify: `backend/src/acquisition-run-presentation.ts`
- Modify: `backend/src/acquisition-run-presentation-test.ts`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `backend/src/acquisition-openapi-response-conformance-test.ts`
- Modify: `contracts/json-schema/acquisition-run-presentation.v1.schema.json`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify (generated): `frontend/src/features/ai-growth/generated/ai-acquisition.ts`

**Interfaces:**
- `AcquisitionRunPresentation.automationSteps[]` 固定步骤 ID：`discover_video_urls`、`resolve_video_ids`、`fetch_public_comment_samples`、`normalize_platform_events`、`aggregate_actor_signals`、`qualify_candidates`、`refresh_run_presentation`。
- 每步包含 `status: pending | running | succeeded | partial_success | failed | skipped`、`startedAt`、`completedAt`、`durationMs`、`processedCount`、`errorCode`、`message`；全部由持久化事实派生。
- `summary` 增加 `discoveredVideos`、`commentsSampled`、`validDemandSignals`、`unresolvedActors`、`highPotentialSignals`。
- `commentSignals[]` 最多返回 50 条，包含 `eventId`、`candidateId`、`displayName`、`handle`、`text`、`occurredAt`、`likeCount`、`replyCount`、`ipLabel`、`sourceUrl`、`intentBand`、`reasons`、`confidence`、`identityStatus`、`evidenceId`；不包含头像。
- 评论自动化是否适用只由 Run 引用的不可变计划版本决定：目标必须为 douyin 且公开评论策略明确启用；否则固定七步全部 skipped，普通网页搜索 shard 不计为视频发现。
- fetch attempt 在 repository 内全量聚合，第 101 条及以后同样参与状态、错误、时间和资格完整度；候选与信号事实设 10000 条硬保护。有效需求排除 negative 与 `do_not_contact`，未核验主体按稳定公开主体在整个 Run 去重。
- 发现步骤只使用 `shard.started` 与终态 shard 事件时间；标准化、主体聚合、资格研判和刷新没有独立时间事实时返回 null。event 已存但 saga/link 未提交时，主体聚合不得显示 succeeded。
- 高潜评论必须同时通过真实 scoped individual candidate、真实 Evidence 和 candidate 对 evidenceId 的归属。Evidence 的 source platform、access status、content hash、provider version、coverage、platform event ID 与 source URL 必须与事件逐项精确一致，candidate 的严格 secUid/规范化 handle/comment-scoped public actor key 必须标识同一主体；悬空、交叉链接或主体错配全部 fail closed。
- 取数失败不伪造 0：对应步骤为 failed/partial_success 并带错误码。
- 时间线可见错误码至少覆盖 `public_sample_unavailable`、`access_restricted`、`rate_limited`、`video_id_unresolved`、`source_payload_invalid`、`no_public_comments`、`model_output_invalid`；多步骤有成有败时使用 `partial_success` 状态而不是另造错误。

  ```ts
  export interface AcquisitionAutomationStep {
    id: AcquisitionAutomationStepId;
    status: "pending" | "running" | "succeeded"
      | "partial_success" | "failed" | "skipped";
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    processedCount: number;
    errorCode: string | null;
    message: string;
  }
  ```

- [x] **Step 1: 先写 Run Presentation 行为失败测试**

  构造运行中、全成功、部分 429、全部受限、无公开评论、事件已保存但资格研判未完成、身份未核验强信号等情形。断言时间线顺序稳定，高潜评论证据可回溯，跨租户不可见。

- [x] **Step 2: 运行 RED**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-run-presentation-test.ts`

  Expected: FAIL，因为新展示字段尚未组装。

- [x] **Step 3: 实现投影组装和严格 OpenAPI schema**

  `AcquisitionRunPresentationService` 注入 Task 3 读 repository，并与现有 shard execution/candidate summary 并行读取。保持现有 candidate cursor 语义；`commentSignals` 是有界最新投影，不挤占 candidate pagination cursor。

- [x] **Step 4: 运行 GREEN、OpenAPI 一致性和合同检查**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-run-presentation-test.ts src/acquisition-openapi-test.ts src/acquisition-openapi-response-conformance-test.ts && npm run generate:frontend-contract-types && npm run check:acquisition-contracts`

  Expected: PASS。

- [x] **Step 5: 提交**

  ```bash
  git add backend/src/acquisition-application.ts backend/src/acquisition-domain-repository.ts backend/src/acquisition-douyin-comment-events-mysql-repository-test.ts backend/src/acquisition-douyin-comment-events-mysql-repository.ts backend/src/acquisition-douyin-comment-events-test.ts backend/src/acquisition-douyin-comment-events.ts backend/src/acquisition-douyin-comment-ingestion-test.ts backend/src/acquisition-mysql-repositories-test.ts backend/src/acquisition-mysql-repositories.ts backend/src/acquisition-openapi-response-conformance-test.ts backend/src/acquisition-openapi-test.ts backend/src/acquisition-openapi.ts backend/src/acquisition-run-presentation-test.ts backend/src/acquisition-run-presentation.ts backend/src/acquisition-task-overview-router-test.ts contracts/README.md contracts/json-schema/acquisition-run-presentation.v1.schema.json contracts/test/openapi.test.mjs docs/superpowers/plans/2026-08-15-douyin-public-comment-automation.md docs/superpowers/specs/2026-08-15-douyin-public-comment-automation-design.md frontend/src/features/ai-growth/components.test.ts frontend/src/features/ai-growth/demo/fixture.ts frontend/src/features/ai-growth/generated/ai-acquisition.ts frontend/src/features/ai-growth/poll-run.test.ts frontend/src/features/ai-growth/view-model.test.ts .superpowers/sdd/2026-08-15-douyin-public-comment-automation/task-6-report.md
  git commit -m "feat: project douyin automation results"
  ```

  ```bash
  git add backend/src/acquisition-run-presentation.ts backend/src/acquisition-run-presentation-test.ts backend/src/acquisition-openapi.ts backend/src/acquisition-openapi-test.ts backend/src/acquisition-openapi-response-conformance-test.ts contracts/json-schema/acquisition-run-presentation.v1.schema.json contracts/openapi/ai-acquisition.v1.yaml frontend/src/features/ai-growth/generated/ai-acquisition.ts
  git commit -m "feat: expose acquisition automation evidence"
  ```

### Task 7: 保持现有风格的前端自动化体验

**Repository:** `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`

**Files:**
- Modify: `index.html`
- Modify: `src/acquisition/task-creation-api.ts`
- Modify: `src/acquisition/task-creation-api.self-test.ts`
- Modify: `src/acquisition/task-creation-controller.ts`
- Modify: `src/acquisition/task-creation-controller.self-test.ts`
- Modify: `src/acquisition/runtime-api.ts`
- Modify: `src/acquisition/runtime-api.self-test.ts`
- Modify: `src/acquisition/detail-center-api.ts`
- Modify: `src/acquisition/detail-center-api.self-test.ts`
- Modify: `src/acquisition/detail-center-controller.ts`
- Modify: `src/acquisition/detail-center-controller.self-test.ts`
- Modify: `src/acquisition/detail-center-view.ts`
- Modify: `src/acquisition/detail-center-view.self-test.ts`
- Modify: `src/acquisition/runtime-presenter.ts`
- Modify: `src/acquisition/runtime-presenter.self-test.ts`
- Modify: `src/replica-dashboard.css`

**Interfaces and UI:**
- 任务创建表单增加“公开评论样本”开关与有界上限，默认 `10 个视频 / 每视频 30 条 / 最多 3 页`，显示“一级公开样本，非全量”。
- 开关位于 AI 创建与手动创建共用区；两条提交路径都必须应用同一个纯函数策略，不得让默认 AI 模式静默丢失评论配置。
- 启用时只能由前端附加服务端固定的 `douyin-public-comments / experimental_public_sample / content_fetch / active / credentialVersion=1` snapshot；不在 Provider 列表暴露或让用户选择该内置连接。
- 详情运行面板首屏增加七步自动化时间线和五项计数带；仅根据 `automationSteps/summary` 渲染。
- 高潜评论卡显示评论原文、公开主体、视频来源、时间、意愿标签、理由、置信度、身份状态，点击打开现有候选/证据检视器。
- 身份未核验且信号强时使用“高潜需求信号”；只有资格等级 S/A 且通过硬门禁时显示“高意向”。
- 对 `public_sample_unavailable/access_restricted/rate_limited/no_public_comments/partial_success` 显示可行的中文状态，不把来源受限误写为“没有客户”。
- 保留现有暂停、继续、取消、再次运行和人工核验；不增加伪周期调度。
- 保留现有智能体员工卡通头像资产，但不得将员工头像冒充公开评论用户头像；`commentSignals` 使用中性 initials/现有图标。

- [ ] **Step 1: 写前端合同、渲染和交互失败测试**

  测试正常运行、部分失败、无评论、身份未核验高潜信号、已资格评估高意向、HTML 转义、缺失可选新字段的旧后端兼容、轮询时数量不随前端时间增加。

- [ ] **Step 2: 运行 RED**

  Run: `npm exec -- tsx src/acquisition/detail-center-view.self-test.ts && npm exec -- tsx src/acquisition/detail-center-controller.self-test.ts && npm exec -- tsx src/acquisition/task-creation-controller.self-test.ts`

  Expected: FAIL，因为新合同和视图尚不存在。

- [ ] **Step 3: 实现表单和 API/controller 合同**

  `buildDouyinPlanInput` 只对抖音计划提交 `douyinPublicCommentSample`；AI draft 与 manual input 在最终提交前共用同一策略应用函数。Controller 轮询合并 `automationSteps` 时以 step ID 替换最新服务端投影，`commentSignals` 以 event ID 去重；不生成本地模拟事件。

- [ ] **Step 4: 实现时间线、计数带、高潜卡和响应式样式**

  扩展现有 `.replica-acquisition-*` 命名空间，使用当前 CSS 变量。在 1440/1366/1024/768 宽度下不出现横向滚动；必须修正现有 1024 宽度仍保留 `min-width:1280px` 的全局壳层裁切，并在 768 宽度前将详情网格、五项计数和七步时间线折叠为无溢出布局。焦点、`aria-live` 和按钮禁用状态沿用当前可访问性约定。

- [ ] **Step 5: 运行 GREEN、完整前端测试与构建**

  Run: `npm run test && npm run test:types && npm run build`

  Expected: PASS；只允许已知 Vite chunk warning。

- [ ] **Step 6: 仅提交本任务文件**

  ```bash
  git add index.html src/acquisition/task-creation-api.ts src/acquisition/task-creation-api.self-test.ts src/acquisition/task-creation-controller.ts src/acquisition/task-creation-controller.self-test.ts src/acquisition/runtime-api.ts src/acquisition/runtime-api.self-test.ts src/acquisition/detail-center-api.ts src/acquisition/detail-center-api.self-test.ts src/acquisition/detail-center-controller.ts src/acquisition/detail-center-controller.self-test.ts src/acquisition/detail-center-view.ts src/acquisition/detail-center-view.self-test.ts src/acquisition/runtime-presenter.ts src/acquisition/runtime-presenter.self-test.ts src/replica-dashboard.css
  git commit -m "feat: show douyin acquisition automation"
  ```

### Task 8: 端到端自动化证明与真实页面视觉检查

**Repository:** `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`

**Files:**
- Create: `tests/acquisition-comment-automation.spec.ts`
- Modify: `playwright.config.ts` to add `acquisition-comment-automation.spec.ts` to the existing explicit `testMatch` allowlist; keep the existing deterministic Vite server.

**Scenario:**
- fixture 中的 Run 由测试显式 commit 不可变的 queued、running、partial_success 服务端快照，再推进伪时钟触发真实轮询；不得按 GET 次数自动切换状态。每次 API 轮询返回服务端已持久的新步骤/事件；未声明获客请求一律 501。
- 用户能看到任务已自动完成搜索、解析、公开评论读取、事件归一化、主体聚合和研判；点击评论后能回溯证据和身份状态。
- 请求记录断言除 GET/HEAD/OPTIONS 外没有写请求，且不存在自动评论、私信、加好友、群发、CRM 自动转换或任何抖音外网请求。

- [ ] **Step 1: 先写 Playwright 失败测试**

  覆盖 1440、1024、768 视口，键盘打开评论证据，刷新后保留同一 plan/run，部分失败仍展示已采集结果，无横向溢出。

- [ ] **Step 2: 运行 RED**

  Run: `npm run test:e2e -- acquisition-comment-automation.spec.ts`

  Expected: FAIL，直到 Task 7 的真实渲染与导航完成。

- [ ] **Step 3: 完成最小集成修正并检查真实本地页面**

  启动后端 4190 和前端 5191，使用当前应用浏览器打开 `#acquisition`。人工检查深绿/暖白风格、时间线信息密度、长评论折行、空态、部分失败态和证据检视器。此步不需要也不触发真实抖音网络。

- [ ] **Step 4: 运行 GREEN 并提交**

  Run: `npm run test:e2e -- acquisition-comment-automation.spec.ts && npm run test && npm run build`

  ```bash
  git add tests/acquisition-comment-automation.spec.ts playwright.config.ts
  git commit -m "test: verify douyin comment automation ui"
  ```

### Task 9: 文档同步、发布门禁与手工 Beta smoke

**Repository:** `/Users/mac/Documents/新项目/GoodJob-growth`

**Files:**
- Modify: `README.md`
- Modify: `docs/product/ai-acquisition-agent.md`
- Modify: `docs/product/2026-08-05-douyin-ai-acquisition-prd.md`
- Modify: `THIRD_PARTY_NOTICES.md` if implementation paths differ from Task 1.

**Documentation outcome:**
- 当前执行文档直接说明真实规则：公开搜索/用户公开链接入口、一级评论样本覆盖、experimental provider、计划限制、身份核验、错误语义、再次运行和人工 smoke 方法。
- `docs/product/ai-acquisition-agent.md` 把“客户授权的抖音官方连接器”和“持久化周期调度”保留为后续任务，不宣称本期已实现。不修改仓库外的归档交接文件 `../GoodJob-Growth-Handoff-2026-08-14/NEXT_AI_TASKS.md`。
- 历史设计文档不追加补丁式“修订说明”；当前 README/PRD 正文改成当前真实能力。

- [ ] **Step 1: 先运行两个仓库的全量确定性验收**

  Backend repository:

  ```bash
  npm run test:acquisition --workspace backend
  npm run check:acquisition-contracts
  npm run build
  git status --short
  ```

  Frontend repository:

  ```bash
  npm run test
  npm run test:e2e -- acquisition-comment-automation.spec.ts
  npm run build
  git status --short
  ```

  Expected: 除 ledger 已记录的两项 Pi `MODEL_TOOL_DEFINITION_INVALID` 基线外无新失败；contracts/E2E/build 必须 PASS。前端 `git status` 仅保留执行前已记录的用户文件（当前为未跟踪 `package-lock.json`）及本计划尚未提交的文件。

- [ ] **Step 2: 更新当前文档并运行文档/合同门禁**

  Run: `npm run test:contracts && npm run check:acquisition-contracts`

  Expected: PASS；仓库中不存在“全量抖音评论”或绕过平台限制的客户承诺。

- [ ] **Step 3: 可选执行一次受控 Beta 手工 smoke**

  Run: `test -n "$DOUYIN_VIDEO_ID" && DOUYIN_PUBLIC_COMMENT_SMOKE=1 npm run smoke:douyin-comments --workspace backend`

  Expected: 只输出视频 ID、状态、评论数、页数、覆盖语义、provider version 和错误码；不在终端输出完整评论者个人字段，不写入 CI 快照。如 endpoint 不可用，保持 Beta 熵断状态，不改为 Cookie/签名方案。

- [ ] **Step 4: 检查文档与实现一致后提交**

  ```bash
  git add README.md docs/product/ai-acquisition-agent.md docs/product/2026-08-05-douyin-ai-acquisition-prd.md THIRD_PARTY_NOTICES.md
  git commit -m "docs: document douyin comment automation beta"
  ```

- [ ] **Step 5: 最终状态核对**

  对两仓库分别运行 `git status --short` 和 `git log -10 --oneline`，确认九个任务的提交边界清晰，用户原有文件未被带入。
