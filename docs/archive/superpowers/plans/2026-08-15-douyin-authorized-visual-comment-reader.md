# 抖音授权浏览器视觉评论读取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在客户明确授权的本地 Chrome 抖音标签页中，以 DOM/ARIA 为主、评论卡截图 OCR 为兜底，读取当前实际可见的一级评论并形成可审计观察、需求信号和真实运行时间线；不上传 Cookie、完整页面截图或浏览器配置，不伪造平台评论 ID，也不执行评论、私信、点赞、关注或验证码处理。

**Architecture:** 增加一个 Manifest V3 客户侧读取器。GoodJob 网页通过短生命周期的页面通道与扩展通信，扩展仅在用户选定的抖音标签页执行有界只读操作；DOM/ARIA 提取失败时，扩展在本地截取当前视口、裁剪评论卡、用不透明遮挡移除头像和无关区域，再运行本地 OCR。GoodJob 网页收到严格结构化观察后，使用现有登录态和 CSRF API 写入租户隔离的视觉会话、观察与可选遮挡裁剪制品。服务端先保存观察，再按置信度和可验证身份升级为 Evidence / `needs_research` 候选；没有真实 `platformCommentId` 的观察永不写成 `douyin.comment.v1`。

**Tech Stack:** TypeScript 5.7，Chrome Manifest V3，Vite 6，Canvas/Offscreen Document，Tesseract.js 7.0.0 + `@tesseract.js-data/chi_sim` 1.0.0，Sharp 0.35.3，Express，MySQL 8 / in-memory repositories，Zod，JSON Schema / OpenAPI，现有 GoodJob DOM 视图控制器，Node test runner，Playwright。

**Prerequisite:** 先完成并复审通过 `2026-08-15-douyin-public-comment-automation.md` 的 Task 1–9；本计划复用其 Run、Evidence、Candidate、评论富化和展示模型，不平行复制第二条获客内核。

## Open-source decision record

- `browser-act/skills@8f287271faa0c1df79a44578cb059102ff004da2`（MIT）只借鉴“浏览器侧授权、窄 Skill 输出、可替换执行器”方法。现版本没有抖音评论 Skill，且完整 CLI 还包含本计划禁止的 Cookie 会话、隐身指纹、代理和验证码能力，因此不作为生产运行依赖。
- [`naptha/tesseract.js@7.0.0`](https://github.com/naptha/tesseract.js/tree/v7.0.0)（Apache-2.0）支持浏览器 WebAssembly，依赖边界小，适合在扩展 Offscreen Document 中按需复用单个 worker；选作 OCR 兜底。
- [`@tesseract.js-data/chi_sim@1.0.0`](https://github.com/naptha/tessdata)（MIT）只随扩展本地制品发布，不从 CDN 运行时下载。构建产物记录模型哈希。
- [`WebReflection/linkedom@0.18.13`](https://github.com/WebReflection/linkedom)（ISC）只用作 Node 测试中的静态 DOM fixture 解析器，不进入扩展生产 bundle。
- [`lovell/sharp@0.35.3`](https://github.com/lovell/sharp)（Apache-2.0）只在服务端对有界 WebP 执行安全解码、像素遮挡校验和元数据剥离；不接受 URL 或文件路径输入。
- [`PaddlePaddle/PaddleOCR`](https://github.com/PaddlePaddle/PaddleOCR)（Apache-2.0）中文场景能力强，但官方浏览器包仍较新，当前 npm 包加 ONNX Runtime Web、OpenCV.js 和模型后的体积与供应链面明显更大。本期不采用；若真实固定集上 Tesseract 召回率达不到门禁，再以独立 ADR 和可替换 `VisualOcrPort` 评估。
- DOM 文本和 ARIA accessible name 是权威首选；OCR 只转录评论卡内真实可见像素。模型不得补全被截断或不可见文字。

## Global constraints

- 能力默认关闭，只能由已登录 GoodJob 用户在获客页面主动创建视觉读取会话，并在扩展弹窗再次确认当前抖音标签页。
- 扩展禁止声明 `cookies`、`webRequest`、`debugger`、代理或下载权限；禁止读取、导出或上传 Cookie、localStorage、浏览器指纹、网络响应和完整页面 HTML。
- 允许的浏览器动作仅为定位/打开当前视频评论区、在评论容器内有界滚动、展开当前评论卡已渲染的只读正文。禁止输入、表单提交、评论、私信、点赞、关注、发布、上传、验证码处理和自动登录。
- 原始视口截图只存在于扩展内存。上传前必须裁剪到单个评论卡并用不透明色块遮挡头像、导航、通知和评论卡外所有像素；服务端拒绝超过边界或未带遮挡证明的图片。
- 默认限制：每会话最多 10 个视频、每视频 30 条观察、5 次评论容器滚动、10 次 OCR、120 秒；服务端限额更严时取更严者。
- 覆盖语义固定为 `authorized_visible_top_level_sample`。客户文案不得出现“全量评论”“扫描整个抖音”或暗示读取了当前会话不可见的内容。
- `platformCommentId`、`publicProfileUrl` 和 `secUid` 只能来自可验证的 DOM 属性/公开链接；OCR 或模型不得生成这些身份字段。
- 没有真实 `platformCommentId` 时只保存 `douyin.visual-comment-observation.v1`。没有 `secUid`/公开资料链接时产生不可合并的 `needs_research` 信号，不得仅凭昵称合并主体。
- 低置信度、DOM/OCR 冲突、文字截断、安全校验失败或用户接管时安全停止；保留原因，不产生自动资格结论。
- 已批准设计中的远程 `vision` 方法只保留为合同枚举，本计划默认会话不启用、扩展也不产生；后续必须经过独立连接器、数据传输和模型供应链复审才能开启。
- 网页是唯一 API 客户端：扩展不持有 GoodJob Cookie、CSRF token、JWT 或长期配对密钥。网页收到扩展事件后使用现有授权 API 提交。
- CI 使用静态 DOM、图片和浏览器消息 fixture；不访问真实抖音。真实页面只允许显式手工 Beta smoke。
- 两仓库的当前深绿/暖白风格、现有 UI 控制器和无障碍约定保持不变；不引入第二套 UI 框架。
- 不修改或提交前端仓库用户现有的 `pnpm-workspace.yaml` 与 `debug-agents.mts`。

---

### Task 1: 视觉会话、观察和制品合同

**Repository:** `/Users/mac/Documents/新项目/GoodJob-growth`

**Files:**
- Create: `contracts/json-schema/douyin-visual-comment-observation.v1.schema.json`
- Create: `contracts/json-schema/acquisition-visual-reader-session.v1.schema.json`
- Modify: `contracts/json-schema/acquisition-run-presentation.v1.schema.json`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `contracts/test/schema-registry.test.mjs`
- Modify: `contracts/test/openapi.test.mjs`
- Modify: `contracts/test/generated-types.test.mjs`
- Modify: `contracts/README.md`
- Modify: `backend/src/acquisition-openapi.ts`（仅同步可选 Run Presentation 视觉投影；六条运行时路由在 Task 3 挂载）
- Modify (generated): `frontend/src/features/ai-growth/generated/ai-acquisition.ts`

**Interfaces:**

```ts
export type VisualExtractionMethod = "dom" | "accessibility" | "ocr" | "vision";

export interface OpaqueRectRedactionProofV1 {
  version: "opaque-rect-v1";
  maskColorRgba: [17, 61, 51, 255];
  avatarBounds: { x: number; y: number; width: number; height: number } | null;
  visibleRegions: Array<{ x: number; y: number; width: number; height: number }>;
  maskedRegions: Array<{ x: number; y: number; width: number; height: number }>;
}

export interface DouyinVisualCommentObservationV1 {
  observationId: string;
  sessionId: string;
  sourceUrl: string;
  videoId: string;
  visibleText: string;
  textHash: `sha256:${string}`;
  displayName: string | null;
  visibleTimeText: string | null;
  likeCount: number | null;
  replyCount: number | null;
  platformCommentId: string | null;
  publicProfileUrl: string | null;
  secUid: string | null;
  extractionMethod: VisualExtractionMethod;
  fieldConfidences: Record<string, number>;
  viewportHash: `sha256:${string}`;
  cardBounds: { x: number; y: number; width: number; height: number };
  redactedCropHash: `sha256:${string}` | null;
  readerVersion: string;
  capturedAt: string;
}

export interface VisualObservationSubmission {
  clientObservationKey: string;
  sourceUrl: string;
  videoId: string;
  visibleText: string;
  displayName: string | null;
  visibleTimeText: string | null;
  likeCount: number | null;
  replyCount: number | null;
  platformCommentId: string | null;
  publicProfileUrl: string | null;
  secUid: string | null;
  extractionMethod: VisualExtractionMethod;
  fieldConfidences: Record<string, number>;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  cardBounds: { x: number; y: number; width: number; height: number };
  readerVersion: string;
  capturedAt: string;
  redactedCrop: {
    mediaType: "image/webp";
    contentBase64: string;
    redactionProof: OpaqueRectRedactionProofV1;
  } | null;
}
```

- 创建请求固定为 `{ runId, artifactUploadEnabled }`；Plan、PlanVersion、平台、覆盖语义、授权时间和最终限额由服务端从 Run 推导，客户端不能上送。
- `VisualReaderSession` 公开投影固定包含 `sessionId/runId/planId/planVersionId/platform/coverage/status/artifactUploadEnabled/limits/usage/outcome/lastErrorCode/createdAt/authorizedAt/updatedAt/expiresAt/completedAt`。`outcome` 在终态前为 `null`，终态计数由服务端持久事实派生。
- `VisualReaderLimits` 固定包含 `maxVideos/maxCommentsPerVideo/maxScrolls/maxOcrCalls/maxDurationMs`；`VisualReaderUsage` 固定包含视频、观察、滚动、OCR、DOM、accessibility、低置信度和制品计数。
- 批量请求只包含 `observations`；响应固定为 `{ session, accepted, duplicates }`，其中 `accepted` 项为 `{ clientObservationKey, observation }`，`duplicates` 只返回已持久化的 client key。完成请求只接受 `status = completed | partial_success` 和稳定 `errorCodes`；中止请求只接受 `reasonCode = user_requested | visual_reader_user_takeover`。
- Run Presentation 的兼容字段为可选 `authorizedVisualReader` 对象，包含 session/coverage/status、服务端计数、稳定错误和固定五步视觉时间线；字段缺失表示旧 Run 或未创建视觉会话，不能由前端本地推导。
- 制品 GET 只返回 `image/webp` 二进制与私有 no-store/nosniff/CSP 响应头，不把密文字节、明文图片或内部存储字段包装进 JSON。

- 会话状态固定为 `created | collecting | completed | partial_success | aborted | expired`。
- 会话限制包含 `maxVideos/maxCommentsPerVideo/maxScrolls/maxOcrCalls/maxDurationMs`；所有字段有硬上限且 `additionalProperties: false`。
- 批量观察每次最多 20 条、其中带图片的观察最多 5 条；单条 `visibleText` 最多 2,000 字符，裁剪 WebP 最多 256 KiB，字段置信度为 0..1。输入不接受服务端 `observationId/textHash/viewportHash/redactedCropHash`，这些字段由服务端规范化后生成。
- 所有 client/session/run/plan/observation ID 使用现有 ASCII extensible-identifier 闭集，拒绝控制符、换行、NUL 和路径分隔语义。`secUid` 与公开资料 URL 的 user key 必须以 ASCII 字母或数字开头，拒绝 dot segment 和纯标点。
- `contentBase64` 必须是唯一 canonical Base64：除长度、字符和 padding 外还要约束未使用 pad bits；同一 WebP 字节不能以第二种文本表示通过合同。
- 裁剪制品使用 `opaque-rect-v1` 遮挡证明：固定 RGBA `[17, 61, 51, 255]`、avatar bounds、允许保留的文字/元数据矩形和客户端实际遮挡矩形；矩形全部以裁剪像素坐标表示。
- Run Presentation 增加 `authorizedVisualReader` 摘要和视觉时间线步骤，但旧 Run 缺少新字段时保持兼容。
- 视觉时间线 schema 使用 `minItems = maxItems = 5` 与五个 step ID 的闭集，保持与现有 OpenAPI 3.0 runtime builder 可转换；固定顺序、无重复且每个 ID 恰好一次由 Task 7 服务端投影强制并测试，不使用转换器不支持的 `prefixItems`。
- 标准 Draft 2020-12 schema 分别严格校验 Douyin URL、videoId 和 session 结构；URL 路径 videoId 必须等于兄弟字段、path sessionId 必须等于目标会话这两项动态一致性由 Task 3 service 在写 repository 前强制。合同 description 和测试必须保留该运行时不变量，不引入 Ajv `$data` 或非标准 keyword。
- OpenAPI named response/request components 不得把 JSON Schema 的 `$defs` 元数据生成为实例字段；新视觉 helper 使用全局唯一名称，不能抢占既有 Copilot `components.schemas.usage`、digest 或其他公开生成类型。生成类型测试必须用合法 session/observation fixture 证明真实响应可赋值且旧名称未漂移。

- [ ] **Step 1: 写严格 schema 和 OpenAPI 失败测试**

  覆盖合法 DOM/OCR 观察和保留的 `vision` 枚举；拒绝未知提取方法、非抖音 HTTPS URL、视频 ID 不匹配、额外字段、伪造评论 ID、超长文字、置信度越界、头像 URL、Cookie/header/networkResponse/html 字段、未遮挡图片以及跨会话观察。

- [ ] **Step 2: 运行 RED**

  Run: `npm run test:contracts`

  Expected: FAIL，因为新 schema 尚未注册。

- [ ] **Step 3: 实现合同、OpenAPI 路径和生成类型**

  API 路径固定为：

  ```text
  POST /api/v1/acquisition/visual-reader-sessions
  GET  /api/v1/acquisition/visual-reader-sessions/{sessionId}
  POST /api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch
  POST /api/v1/acquisition/visual-reader-sessions/{sessionId}:complete
  POST /api/v1/acquisition/visual-reader-sessions/{sessionId}:abort
  GET  /api/v1/acquisition/visual-reader-artifacts/{artifactId}
  ```

- [ ] **Step 4: 运行 GREEN 和漂移检查**

  Run: `npm run test:contracts && npm run generate:frontend-contract-types && npm run check:generated-acquisition-types && npm run test:contract-drift --workspace backend`

  Expected: PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add contracts/json-schema/douyin-visual-comment-observation.v1.schema.json contracts/json-schema/acquisition-visual-reader-session.v1.schema.json contracts/json-schema/acquisition-run-presentation.v1.schema.json contracts/openapi/ai-acquisition.v1.yaml contracts/test/schema-registry.test.mjs contracts/README.md frontend/src/features/ai-growth/generated/ai-acquisition.ts
  git commit -m "feat: define authorized visual reader contracts"
  ```

### Task 2: 租户隔离的视觉会话、观察和遮挡制品持久化

**Repository:** `/Users/mac/Documents/新项目/GoodJob-growth`

**Files:**
- Create: `backend/src/acquisition-visual-reader-sessions.ts`
- Create: `backend/src/acquisition-visual-reader-sessions-test.ts`
- Create: `backend/src/acquisition-visual-reader-mysql-repository.ts`
- Create: `backend/src/acquisition-visual-reader-mysql-repository-test.ts`
- Create: `backend/src/acquisition-visual-artifact-crypto.ts`
- Create: `backend/src/acquisition-visual-artifact-crypto-test.ts`
- Create: `backend/src/acquisition-visual-artifact-expiry-sweeper.ts`
- Create: `backend/src/acquisition-visual-artifact-expiry-sweeper-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`（验证 memory/MySQL 注入及到期 sweeper 生命周期）

**Interfaces:**

```ts
export interface AcquisitionVisualReaderRepository {
  createSession(input: CreateVisualReaderSessionInput): Promise<VisualReaderSession>;
  appendObservationBatch(input: AppendVisualObservationBatchInput): Promise<{
    accepted: VisualCommentObservation[];
    duplicates: string[];
  }>;
  completeSession(scope: AcquisitionScope, sessionId: string,
    outcome: VisualReaderOutcome): Promise<VisualReaderSession>;
  getSession(scope: AcquisitionScope, sessionId: string): Promise<VisualReaderSession | null>;
  listRunObservations(scope: AcquisitionScope, runId: string,
    options: { limit: number }): Promise<VisualCommentObservation[]>;
  getArtifact(scope: AcquisitionScope, artifactId: string): Promise<VisualReaderArtifact | null>;
  deleteExpiredArtifacts(input: { before: string; limit: number }): Promise<number>;
}
```

- MySQL 表固定为 `acquisition_visual_reader_sessions`、`acquisition_visual_comment_observations`、`acquisition_visual_reader_artifacts`。
- 所有主键/唯一键含 `owner_id + team_id`；观察幂等键为 `ownerId + teamId + sessionId + sourceUrl + viewportHash + cardBoundsHash + textHash`。
- schema migration 使用共享 acquisition MySQL named-lock 生命周期；lock acquisition 或 release 失败的连接必须 destroy，不能回池。append/complete/get 的 transaction rollback 失败也必须 destroy，只有确定可复用的连接才 release。
- 所有 repository public 方法共用 closed scope/identifier/batch/outcome/session/artifact/expiry validators。显式 `artifact` 属性必须是精确闭合制品对象，`null`/`false`/`undefined` 和 URL、路径、ciphertext、IV、tag、key 等未知字段一律稳定拒绝；到期删除只接受 `{ before, limit }`。规范观察按 Task 1 normalized schema 逐字段 fail-closed 校验顶层、`fieldConfidences` 和 `cardBounds`，所有 JSON Schema `maxLength` 按 Unicode code point 计数；`sourceUrl-videoId` 与 `publicProfileUrl-secUid` 的动态 sibling 相等仍由 Task 3 service 负责。
- 内部制品输入同时携带明文 `Buffer`、`sha256` 和精确 `byteLength`，repository 在加密前独立重算并校验三者一致。
- 为保持固定三表，scoped `clientObservationKey` 的首次不可变绑定保存在加锁 session 行的 `client_bindings_json`；每个 session 最多 1000 个绑定，canonical JSON 的 UTF-8 字节数最多 262144。新绑定在任何状态/SQL 写入前整批校验，超限稳定返回 `VISUAL_READER_BUDGET_EXHAUSTED`并不改变用量、观察或已有绑定；精确 replay 在上限处仍可用。
- MySQL JSON 行从 `unknown` 解析，并交叉校验 scope、session/status/run/client key、所有 denormalized hash/date 列、envelope 版本和 binary view；矛盾行只返回稳定 integrity error。
- 任一 `getSession`、append 或 complete 首次触达到期都原子持久化 `expired`，`updatedAt/completedAt` 固定为 `expiresAt`；错误响应不能回滚该 transition，后续时钟回退也不能复活会话。
- 新接受的每条 OCR observation 至少派生一次 OCR call 消耗；调用方报告更高消耗时取较高值，duplicate replay 不重复计费，`maxOcrCalls = 0` 拒绝 OCR observation。
- 制品只保存 `image/webp` 的遮挡裁剪，记录 `sha256`、字节数、宽高、遮挡矩形数量、创建/到期时间；默认 30 天到期。
- 制品字节用现有 `ACQUISITION_MASTER_SECRET` 经固定版本 salt/info 的 HKDF-SHA256 派生独立子密钥，执行 AES-256-GCM envelope encryption；AAD 固定绑定 envelope/key/algorithm 版本、owner/team/session/observation/artifact、media type、明文 hash 和字节数，MySQL 不保存明文图片。
- 图片字节不写审计日志、错误消息或 JSON 响应；下载响应设置 `private, no-store`、`nosniff` 和严格 CSP。

- [x] **Step 1: 写内存 repository RED 测试**

  覆盖状态机、同批/跨批幂等、不同租户隔离、过期会话拒写、预算递减、低置信度保留、相同昵称不合并、制品哈希/媒体类型/大小校验、AAD 防换租户/换制品、密文篡改失败和到期不可读。

- [x] **Step 2: 运行 RED**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-visual-reader-sessions-test.ts`

  Expected: FAIL，因为 repository 不存在。

- [x] **Step 3: 实现内存 repository，再写 MySQL RED 测试**

  MySQL 测试覆盖唯一索引竞争、事务内批量观察+加密制品一致提交、所有 `ArrayBufferView` SQL value 都不含明文 WebP、滚回不留孤立 BLOB、named-lock/transaction poisoned connection、矛盾行 fail-closed、绑定 count/UTF-8 双上限、持久到期、OCR 计费、租户条件和 memory/MySQL 合同行为一致。存在 `MYSQL_TEST_ADMIN_URL` 时创建并清理随机隔离数据库，运行真实 memory/MySQL 合同矩阵；pool 关闭或 DROP 失败也必须继续后续清理。缺少变量时明确 conditional skip。

- [x] **Step 4: 实现 MySQL repository 和 application 注入**

  使用独立 `ensureAcquisitionVisualReaderMysqlSchema(pool)`，不继续扩大通用 `acquisition-mysql-repositories.ts`。在应用启动时注入 memory/MySQL 同一 port；artifact expiry sweeper 每次最多删除 100 条到期密文，失败只记录数量和错误码，不记录图片或正文。sweeper 把同步 `now`/repository 异常纳入 Promise 路径，并隔离 `onError` 自身异常，周期 `void` callback 不得产生 unhandled rejection。

- [x] **Step 5: 运行 GREEN 并提交**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-visual-reader-sessions-test.ts src/acquisition-visual-reader-mysql-repository-test.ts src/acquisition-visual-artifact-crypto-test.ts src/acquisition-visual-artifact-expiry-sweeper-test.ts && npm run build --workspace backend`

  ```bash
  git add backend/src/acquisition-visual-reader-sessions.ts backend/src/acquisition-visual-reader-sessions-test.ts backend/src/acquisition-visual-reader-mysql-repository.ts backend/src/acquisition-visual-reader-mysql-repository-test.ts backend/src/acquisition-visual-artifact-crypto.ts backend/src/acquisition-visual-artifact-crypto-test.ts backend/src/acquisition-visual-artifact-expiry-sweeper.ts backend/src/acquisition-visual-artifact-expiry-sweeper-test.ts backend/src/acquisition-application.ts
  git commit -m "feat: persist authorized visual observations"
  ```

### Task 3: 已授权 API、CSRF、会话预算和安全拒绝

**Repository:** `/Users/mac/Documents/新项目/GoodJob-growth`

**Files:**
- Create: `backend/src/acquisition-visual-reader-router.ts`
- Create: `backend/src/acquisition-visual-reader-router-test.ts`
- Create: `backend/src/acquisition-visual-reader-service.ts`
- Create: `backend/src/acquisition-visual-reader-service-test.ts`
- Create: `backend/src/acquisition-visual-artifact-validator.ts`
- Create: `backend/src/acquisition-visual-artifact-validator-test.ts`
- Modify: `backend/src/acquisition-visual-reader-sessions.ts`
- Modify: `backend/src/acquisition-visual-reader-sessions-test.ts`
- Modify: `backend/src/acquisition-visual-reader-mysql-repository.ts`
- Modify: `backend/src/acquisition-visual-reader-mysql-repository-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `backend/src/acquisition-openapi-response-conformance-test.ts`
- Modify: `backend/src/acquisition-openapi-contract-test-helpers.ts`
- Create: `backend/src/acquisition-openapi-contract-test-helpers-test.ts`
- Modify: `backend/src/acquisition-openapi-contract-drift-test.ts`
- Modify: `backend/src/security-test.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/package.json`
- Modify: `package-lock.json`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `contracts/test/openapi.test.mjs`
- Modify (generated): `frontend/src/features/ai-growth/generated/ai-acquisition.ts`

**Behavior:**

- 创建会话必须绑定现有 Plan/Run、平台 `douyin`、服务端预算和用户授权时间；Run 不存在、跨租户、计划未启用或已结束时拒绝。
- 本期“计划已启用”固定指 approved Run 的不可变 PlanVersion 同时满足 `targetPlatform = douyin` 与 `douyinPublicCommentSample.enabled = true`；只允许 `queued | running` Run 创建视觉会话。最终视觉限额取视觉硬上限与该不可变评论策略的更严值。
- create session 的 `sessionId` 只由服务端以租户、Run 和 `Idempotency-Key` 的加密摘要确定；repository 原子返回 created/replayed。观察批次也把哈希后的 header key 与整批 canonical request hash 在同一 session transaction 内绑定；同 key 同请求安全重放，同 key 不同请求冲突，原始 key 不落库。
- 服务端重新解析 `sourceUrl/videoId`，重新计算 `textHash/cropHash/cardBoundsHash`；不信任扩展提供的哈希。
- `AcquisitionVisualArtifactValidator` 只把请求内存 Buffer 交给 `sharp@0.35.3`，设置 1 megapixel 输入上限并输出有界 raw RGBA；检查 WebP、真实宽高、字节数和裁剪宽高比，拒绝 EXIF/额外页面、动画和超限图。
- 服务端要求 `redactionProof.version = "opaque-rect-v1"`。avatar bounds 和所有允许矩形之外的每个像素都必须是固定不透明遮挡色 `[17,61,51,255]`，允许矩形总面积不得超过裁剪面积 80%；没有图片时允许纯 DOM 观察。
- 批量请求使用 `Idempotency-Key`，现有 auth + CSRF；扩展无直连 API 能力。
- 每个至少接受一条新观察的批次记作一次有界 capture cycle，并消耗一个 `scrollCount`；
  同 header 的精确重放和只含重复观察的批次不重复计数，第六个产生新观察的 capture
  cycle 在整个批次写入前以预算冲突拒绝。该计数是服务端有界读取周期，不宣称客户端
  真实发生了一次 DOM 滚动。
- 观察批次路由使用独立 2 MiB JSON body 上限，即使通用 `JSON_BODY_LIMIT` 被配置得更大也不能放宽；图片数超过 5、解码后制品总字节超过 `5 * 256 KiB` 或正文批次超过 20 时，在进入 repository 前拒绝。
- 稳定错误码：`visual_reader_not_enabled | visual_reader_session_expired | visual_reader_budget_exhausted | visual_source_invalid | visual_observation_invalid | visual_artifact_invalid | visual_extraction_method_disabled | visual_extraction_low_confidence | visual_reader_user_takeover`。默认会话只允许 `dom | accessibility | ocr`，保留的 `vision` 输入返回 `visual_extraction_method_disabled`。
- OpenAPI drift helper 在 dereference 和视觉 schema 恢复前验证静态源文件：六条视觉路由的请求/成功响应 schema 节点必须存在，组件 `$ref` 必须精确指向 Task 1 的 session/observation fragment，错误 fragment、错误 route schema 或额外 schema 关键字均 fail-closed，不能被恢复步骤掩盖。

- [x] **Step 1: 写 service/router RED 测试**

  覆盖未登录、缺 CSRF、跨租户、Run 不匹配、非抖音 URL、客户端哈希欺骗、图片炸弹、动画 WebP、伪造宽高、未遮挡头像、卡外残留像素、允许区面积过大、重复幂等键、完成后追加、预算竞争和响应字段最小化。

- [x] **Step 2: 运行 RED**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-visual-reader-service-test.ts src/acquisition-visual-reader-router-test.ts src/acquisition-visual-artifact-validator-test.ts src/security-test.ts`

  Expected: FAIL。

- [x] **Step 3: 实现 service/router 并挂载 application**

  `POST observations:batch` 先完成整批验证，再在同一 repository 事务内写入；任一观察/制品非法时整批不落库。合法低置信度记录可落库但标记 `manual_review_only`。

- [x] **Step 4: 运行 GREEN、OpenAPI 与构建**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-visual-reader-service-test.ts src/acquisition-visual-reader-router-test.ts src/acquisition-visual-artifact-validator-test.ts src/security-test.ts src/acquisition-openapi-test.ts src/acquisition-openapi-response-conformance-test.ts && npm run build --workspace backend`

  Expected: PASS。

- [x] **Step 5: 提交**

  ```bash
  git add backend/src/acquisition-visual-reader-router.ts backend/src/acquisition-visual-reader-router-test.ts backend/src/acquisition-visual-reader-service.ts backend/src/acquisition-visual-reader-service-test.ts backend/src/acquisition-visual-artifact-validator.ts backend/src/acquisition-visual-artifact-validator-test.ts backend/src/acquisition-application.ts backend/src/acquisition-openapi.ts backend/src/acquisition-openapi-test.ts backend/src/acquisition-openapi-response-conformance-test.ts backend/src/security-test.ts backend/package.json package-lock.json THIRD_PARTY_NOTICES.md frontend/src/features/ai-growth/generated/ai-acquisition.ts
  git commit -m "feat: expose authorized visual reader sessions"
  ```

### Task 4: GoodJob 网页通道和深绿/暖白授权控制面

**Repository:** `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`

**Files:**
- Create: `src/acquisition/visual-reader-api.ts`
- Create: `src/acquisition/visual-reader-api.self-test.ts`
- Create: `src/acquisition/visual-reader-bridge.ts`
- Create: `src/acquisition/visual-reader-bridge.self-test.ts`
- Create: `src/acquisition/visual-reader-controller.ts`
- Create: `src/acquisition/visual-reader-controller.self-test.ts`
- Modify: `src/acquisition/detail-center-controller.ts`
- Modify: `src/acquisition/detail-center-controller.self-test.ts`
- Modify: `src/acquisition/detail-center-api.ts`
- Modify: `src/acquisition/detail-center-view.ts`
- Modify: `src/acquisition/detail-center-view.self-test.ts`
- Modify: `src/acquisition/runtime-api.ts`
- Modify: `src/replica-dashboard.css`
- Modify: `src/self-test.ts`
- Modify: `README.md`

**Page bridge protocol:**

```ts
type VisualReaderPageCommand =
  | { version: "goodjob.visual-reader.bridge.v1"; type: "probe"; channelNonce: string }
  | { version: "goodjob.visual-reader.bridge.v1"; type: "start"; channelNonce: string;
      sessionId: string; limits: VisualReaderLimits; artifactUploadEnabled: boolean }
  | { version: "goodjob.visual-reader.bridge.v1"; type: "acknowledge_batch";
      channelNonce: string; sessionId: string; batchId: string }
  | { version: "goodjob.visual-reader.bridge.v1"; type: "abort"; channelNonce: string;
      sessionId: string };

type VisualReaderExtensionEvent =
  | { version: "goodjob.visual-reader.bridge.v1"; type: "ready";
      channelNonce: string; extensionVersion: string }
  | { version: "goodjob.visual-reader.bridge.v1"; type: "observation_batch";
      channelNonce: string; sessionId: string; batchId: string;
      observations: VisualObservationSubmission[] }
  | { version: "goodjob.visual-reader.bridge.v1"; type: "terminal";
      channelNonce: string; sessionId: string;
      status: "completed" | "partial_success" | "aborted";
      errorCodes: VisualReaderStableErrorCode[] };
```

- 页面用 `crypto.getRandomValues` 为每次详情页生命周期生成 256-bit `channelNonce`；扩展事件必须匹配 `event.source === window`、当前 origin、协议版本、nonce、sessionId 和严格 schema。
- 网页不接受任意扩展 ID 的“已完成”消息直接改变 UI；每批观察必须先由 API 成功持久化，随后从服务端 session/Run Presentation 刷新。
- 网页仅在批次 API 成功后发送 `acknowledge_batch`；失败批次不 ACK。批次、terminal 和服务端停止在同一 session 内串行，用户主动停止会废弃未确认批次并立即停止扩展，再以稳定幂等键中止服务端 session。
- `start.artifactUploadEnabled` 必须来自服务端 session。关闭制品时扩展不得运行 OCR 或生成上传裁剪，网页提交前仍把任何裁剪强制置空作为纵深防御。
- UI 增加“授权读取当前抖音页面”卡片、扩展连接状态、剩余预算、DOM/OCR 数量、低置信度数量、停止按钮和隐私说明。状态只来自扩展事件与服务端事实，不用模拟计时器。
- 不上传图片前展示“仅上传已遮挡评论卡裁剪”；用户可关闭制品上传而只提交文字观察。
- 网页 API 使用 `POST /api/v1/acquisition/visual-reader-sessions` 创建 session，使用 session 子路由提交批次、完成和中止，使用 `GET /api/v1/acquisition/visual-reader-artifacts/:artifactId` 读取当前租户范围内的 WebP 制品。

- [x] **Step 1: 写 bridge、API、controller 和 view RED 测试**

  覆盖扩展缺失、nonce 错误、旧 session 重放、跨 origin 消息、超限批次、API 失败不显示成功、用户停止、页面刷新恢复、HTML 转义、键盘操作和旧后端无新字段兼容。

- [x] **Step 2: 运行 RED**

  Run: `npm exec -- tsx src/acquisition/visual-reader-bridge.self-test.ts && npm exec -- tsx src/acquisition/visual-reader-controller.self-test.ts && npm exec -- tsx src/acquisition/detail-center-view.self-test.ts`

  Expected: FAIL。

- [x] **Step 3: 实现 API/bridge/controller**

  API 继续使用现有 same-origin auth/CSRF。Bridge 只处理结构化克隆对象；拒绝字符串 JSON、函数、Blob URL、HTML 和未知字段。每批成功后清除客户端队列；网络失败只按同一 Idempotency-Key 重试。

- [x] **Step 4: 实现现有风格 UI**

  扩展 `.replica-acquisition-*` 命名空间。1440/1024/768 宽度无横向滚动；状态更新使用 `aria-live="polite"`，授权/停止按钮有明确焦点与禁用态。

- [x] **Step 5: 运行 GREEN 和前端构建**

  Run: `npm run test && npm run test:types && npm run build`

  Expected: PASS；只允许已有 Vite chunk warning。

- [x] **Step 6: 仅提交本任务文件**

  ```bash
  git add README.md src/self-test.ts src/acquisition/visual-reader-api.ts src/acquisition/visual-reader-api.self-test.ts src/acquisition/visual-reader-bridge.ts src/acquisition/visual-reader-bridge.self-test.ts src/acquisition/visual-reader-controller.ts src/acquisition/visual-reader-controller.self-test.ts src/acquisition/detail-center-api.ts src/acquisition/detail-center-controller.ts src/acquisition/detail-center-controller.self-test.ts src/acquisition/detail-center-view.ts src/acquisition/detail-center-view.self-test.ts src/acquisition/runtime-api.ts src/replica-dashboard.css
  git commit -m "feat: add visual reader authorization controls"
  ```

  Implemented in frontend commits `8167ead`, `f351261`, and `e032683`. Fresh verification passed all five focused self-tests, `npm run test` with 125 checks, `npm run test:types`, `npm run build`, and `git diff --check`; the only build message was the existing Vite chunk-size warning. Independent review approved the stable semantic keys, ordered mutation queue, monotonic session reconciliation, strict authorization eligibility, and stop-recovery barrier.

### Task 5: Manifest V3 只读扩展、DOM/ARIA 提取和有界滚动

**Repository:** `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`

**Files:**
- Create: `browser-extension/douyin-visual-reader/manifest.template.json`
- Create: `browser-extension/douyin-visual-reader/vite.config.ts`
- Create: `browser-extension/douyin-visual-reader/src/protocol.ts`
- Create: `browser-extension/douyin-visual-reader/src/service-worker.ts`
- Create: `browser-extension/douyin-visual-reader/src/goodjob-bridge-content.ts`
- Create: `browser-extension/douyin-visual-reader/src/douyin-content.ts`
- Create: `browser-extension/douyin-visual-reader/src/douyin-extractor.ts`
- Create: `browser-extension/douyin-visual-reader/src/douyin-extractor.self-test.ts`
- Create: `browser-extension/douyin-visual-reader/src/douyin-reader.ts`
- Create: `browser-extension/douyin-visual-reader/src/session-coordinator.ts`
- Create: `browser-extension/douyin-visual-reader/src/runtime-transport.ts`
- Create: `browser-extension/douyin-visual-reader/src/restart-recovery.ts`
- Create: `browser-extension/douyin-visual-reader/src/tab-guard.ts`
- Create: `browser-extension/douyin-visual-reader/src/popup-model.ts`
- Create: `browser-extension/douyin-visual-reader/src/popup.ts`
- Create: `browser-extension/douyin-visual-reader/src/popup.html`
- Create: `browser-extension/douyin-visual-reader/src/popup.css`
- Create: `browser-extension/douyin-visual-reader/fixtures/*.html`
- Create: `scripts/build-visual-reader-bundles.mts`
- Create: `scripts/build-visual-reader-manifest.mts`
- Create: `scripts/check-visual-reader-bundle.mts`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `package.json`

**Manifest permissions:**

```json
{
  "permissions": ["activeTab", "scripting", "storage", "offscreen"],
  "host_permissions": ["https://www.douyin.com/*"]
}
```

- GoodJob 页面 origin 由 `scripts/build-visual-reader-manifest.mts` 从 `GOODJOB_APP_ORIGINS` 生成 `content_scripts.matches`；开发默认仅 `http://127.0.0.1:5191/*`。发布构建缺少显式 HTTPS 生产 origin 时失败，不生成广域 `https://*/*` 权限。
- manifest 测试明确拒绝 `cookies`、`webRequest`、`debugger`、`proxy`、`downloads`、`<all_urls>`、后台网络 endpoint 和不受控 content-script origin。
- DOM 提取器只读取当前可见一级评论卡的 `innerText`、ARIA label、公开计数文本、时间文本和卡内公开链接；忽略 `img/src/srcset/style`、脚本数据、闭包变量和网络缓存。
- 选择器采用版本化多信号策略：评论容器/卡片语义、可见文本、层级和卡片几何同时满足；选择器失效返回稳定错误，不扩大到整页文本。
- 打开评论区或展开正文只允许点击同时满足 button role、可见、位于当前视频容器且 accessible name 精确匹配版本化只读标签的元素；任何歧义都停止，不使用坐标点击。
- 无公开评论 ID 时，观察 key 是正文、公开可验证身份和稳定可见元数据的本地 SHA-256；不含卡片索引或坐标，卡片移动不改变 key，同位置出现新正文会生成新 key。
- 可见正文严格沿用 Task 4 的 2000 字符上限；Task 5 只发送 DOM/ARIA 观察且 `redactedCrop: null`，不进入截图、OCR 或视觉模型。
- 批次在网页 ACK 前保留同一 `batchId`；转发失败、`accepted:false` 和 ACK 丢失会在绝对会话时限内重放同一批次。所有 extract、DOM 稳定、发送、ACK 与滚动等待共享绝对 deadline；terminal 使用有界超时和同事件重试。
- 虚拟列表每次滚动后等待 DOM 稳定，按观察指纹去重；最多 5 次滚动，光标不推进两次立即停止。用户输入、绑定标签页在同一窗口被替换、URL 变化、关闭或窗口焦点真实离开时触发 `visual_reader_user_takeover`；关闭弹窗不会停止，其他窗口的后台 tab activation 不会误杀。
- 弹窗确认后重新校验 tab/window/canonical URL，先激活目标窗口和标签页，再次校验 active 状态后才注入。MV3 service worker 重启会清除残留授权并通知存活 content script 失败关闭，不持久化 raw nonce、批次或正文。
- 测试固定使用 `linkedom@0.18.13` 解析 HTML fixture；它只放在 devDependencies，生产构建检查必须证明扩展 bundle 不包含 linkedom。

- [x] **Step 1: 写 manifest/protocol/extractor RED 测试**

  固定 fixture 覆盖普通卡、折叠正文、虚拟列表节点复用、昵称缺失、评论 ID 缺失、二级回复、广告卡、登录弹窗、验证码、安全验证和 selector drift。断言不读取头像 URL、不把回复正文当一级评论、不伪造 ID。

- [x] **Step 2: 运行 RED**

  Run: `npm exec -- tsx browser-extension/douyin-visual-reader/src/douyin-extractor.self-test.ts`

  Expected: FAIL。

- [x] **Step 3: 实现 build/manifest/protocol 和只读提取器**

  Service worker 只路由当前 GoodJob tab 与用户确认的 Douyin tab。`chrome.storage.session` 只保存 sessionId/tabId/预算/nonce 哈希，不保存评论正文、图片或认证材料。

- [x] **Step 4: 实现弹窗、只读滚动和安全停止**

  弹窗展示选中标签 URL、允许动作、剩余预算和停止按钮；用户必须点击一次“开始读取”。遇到登录/验证码/安全验证立即停止，不尝试处理。

- [x] **Step 5: 运行 GREEN 和扩展构建**

  Run: `npm run test:visual-reader && npm run verify:visual-reader-build-order`

  Expected: PASS；`dist-visual-reader/douyin-visual-reader/manifest.json` 没有禁止权限，内容脚本 origin 严格有界；主站 build 后扩展制品仍存在并通过只读审计。

- [x] **Step 6: 提交**

  ```bash
  git add .gitignore README.md browser-extension/douyin-visual-reader scripts/build-visual-reader-bundles.mts scripts/build-visual-reader-manifest.mts scripts/check-visual-reader-bundle.mts THIRD_PARTY_NOTICES.md package.json
  git commit -m "feat: add bounded douyin visual reader extension"
  ```

  Implemented in frontend commits `fc378c3`, `1732163`, `cdbb176`, `c52a2d9`, `7ae7945`, `8c1ba35`, `b566cd5`, and the user-authorized ownership repair `1c00cbf`; independent review approved the final lifecycle behavior with no new Critical or Important finding. Development origin rendering is fixed to `http://127.0.0.1:5191/*` and rejects every other supplied origin; the current audit rejects any complete-manifest drift from the template and rendered build origins. Target `loading` lifecycle/replacement events abort even for a same canonical URL; restart expiry is a `partial_success` completion rather than user takeover. The unchanged server-authorized total deadline reserves its final 20% (maximum 1 second, minimum 1ms) for terminal delivery. Reader work stops at the derived earlier deadline, and budget exhaustion queues terminal exactly once at the expired-budget check or timer callback before asynchronous rejection settlement; even `maxDurationMs = 1` therefore makes its first transport attempt before the total deadline. Hung sends and retries still stop at that unchanged deadline. Every accepted content-script start owns a monotonic generation plus a unique owner object, so stale empty-window, fallback, normal-reader, or unavailable cleanup cannot clear a replacement reader/session/transport even when `sessionId` is reused; every superseded transport still closes itself. The ownership RED reproduced a stale fallback settlement erasing replacement batch-2 ACK routing; GREEN and independent replay cover fallback success, rejection/retry, timeout/retry, ACK/abort routing, replacement terminal delivery, and timer/unhandled cleanup. Fresh verification passed all ten extension self-test groups, the 125-check frontend self-test, strict type checks, the real extension-build/main-build/read-only-audit sequence, the final read-only audit, and `git diff --check`. The frontend worktree retained only the user's untracked `package-lock.json`, which was not read, edited, staged, deleted, or committed. No real Douyin request was made and Task 6 screenshot/OCR work had not started at Task 5 completion.

### Task 6: 本地裁剪、头像遮挡和 OCR 兜底

**Repository:** `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`

**Files:**
- Create: `browser-extension/douyin-visual-reader/src/offscreen.html`
- Create: `browser-extension/douyin-visual-reader/src/offscreen.ts`
- Create: `browser-extension/douyin-visual-reader/src/visual-pipeline.ts`
- Create: `browser-extension/douyin-visual-reader/src/visual-pipeline.self-test.ts`
- Create: `browser-extension/douyin-visual-reader/src/ocr-port.ts`
- Create: `browser-extension/douyin-visual-reader/src/tesseract-ocr.ts`
- Create: `browser-extension/douyin-visual-reader/src/tesseract-ocr.self-test.ts`
- Create: `browser-extension/douyin-visual-reader/src/tesseract-worker.ts`
- Create: `browser-extension/douyin-visual-reader/src/visual-capture-guard.ts`
- Create: `browser-extension/douyin-visual-reader/src/visual-capture-runtime.ts`
- Create: `browser-extension/douyin-visual-reader/src/visual-content-fallback.ts`
- Create: `browser-extension/douyin-visual-reader/src/webp-redaction-policy.ts`
- Create: `scripts/test-visual-reader-ocr-smoke.mts`
- Create: `browser-extension/douyin-visual-reader/fixtures/*.webp`
- Modify: `browser-extension/douyin-visual-reader/src/service-worker.ts`
- Modify: `browser-extension/douyin-visual-reader/src/douyin-content.ts`
- Modify: `browser-extension/douyin-visual-reader/vite.config.ts`
- Modify: `package.json`
- Modify: `THIRD_PARTY_NOTICES.md`

**Pipeline:**

```text
captureVisibleTab (memory only)
→ clamp card bounds to viewport
→ crop one comment card
→ opaque-mask avatar and all pixels outside text/metadata bounds
→ mask metadata again and OCR body rectangles only when DOM/ARIA text is missing or truncated
→ compare DOM/OCR normalized text
→ emit structured observation + optional redacted WebP
→ release raw resources before OCR; independently validate the WebP against the authorized request
```

- `VisualOcrPort.recognize(redactedCrop, languages)` 返回文字、词级置信度和边界；默认实现固定 `chi_sim+eng`。
- Tesseract worker 每会话最多一个，惰性加载，初始化与识别各限 20 秒，空闲 30 秒或会话结束立即 terminate；结束后才 resolve 的 worker 也立即销毁。worker/core/wasm/language assets 全部来自扩展包，不用 CDN、远程脚本或动态代码。Pinned `best_int` 语言 gzip 仅在构建时解压，runtime 使用本地 `.traineddata` 且不包含 Node `Buffer`/`bmp-js`。
- 扩展 CSP 固定为 `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`，只为本地 Tesseract WASM 开放编译；构建测试拒绝 `unsafe-eval`、远程源和额外 `connect-src`。
- 若 DOM 文本完整，OCR 不运行。公开时间与计数可以留在遮挡制品 proof 中，但 OCR 输入必须再次遮挡 metadata，只能从正文矩形内的 word bounds 重建文字。若 DOM/OCR 显著冲突，保留两个哈希和遮挡裁剪但结果为 `manual_review_only`；OCR 空、失败或无效时保留原截断 DOM 低置信观察，不让模型择一补写。
- `domTextHash` / `ocrTextHash` 是 submission 与 normalized observation 的 required-nullable 来源证明；后端按最终 extraction method 交叉校验并原样持久化，且继续独立生成 server `textHash`。
- 只有再次按当前授权 request 校验过的遮挡 WebP 可进入 page bridge。校验包含 canonical RIFF/WEBP、真实 decode、精确尺寸/proof geometry、alpha、逐像素 mask 和 OCR body word bounds。raw screenshot/image/full canvas/raster 在 OCR await 前释放；end/takeover 会抢占队列、主动清理 offscreen raw 资源并使旧 generation 消息失效。禁止写 storage、IndexedDB、日志或 crash payload。

- [x] **Step 1: 写裁剪/遮挡/OCR 决策 RED 测试**

  使用合成固定图片覆盖 HiDPI 缩放、视口边缘裁剪、圆形/方形头像、多余导航、长评论、中文+数字、表情、低对比度、截断、DOM/OCR 一致和冲突。逐像素断言 avatar bounds 与所有允许文字/元数据矩形之外的像素为固定 RGBA `[17,61,51,255]`。

- [x] **Step 2: 运行 RED**

  Run: `npm exec -- tsx browser-extension/douyin-visual-reader/src/visual-pipeline.self-test.ts && npm exec -- tsx browser-extension/douyin-visual-reader/src/tesseract-ocr.self-test.ts`

  Expected: FAIL。

- [x] **Step 3: 实现纯 Canvas pipeline 和可替换 OCR port**

  先用 fake OCR 跑通全部裁剪/遮挡/决策测试，再接 `tesseract.js@7.0.0`。固定中文 fixture 的字符召回门禁为 90%，数值/货币关键词不得误补；未达到门禁时结果只能进入人工复核。

- [x] **Step 4: 自托管 OCR 资产并记录许可证/哈希**

  构建脚本复制 pinned worker/core/wasm/`chi_sim` 资产到扩展 dist，生成 `ocr-assets.json` SHA-256 清单。`THIRD_PARTY_NOTICES.md` 记录包版本、仓库、许可证、用途和未修改/修改范围。

- [x] **Step 5: 运行 GREEN、CSP/包体检查和构建**

  Run: `npm run test:visual-reader && npm run build:visual-reader && npm run check:visual-reader-bundle`

  Expected: PASS；dist 无远程脚本 URL、`eval`、原始 fixture 或 sourcemap 中的评论文字；包含本地 WASM 与中文模型的未压缩扩展制品在记录的 80 MiB 上限内。

- [x] **Step 6: 提交**

  ```bash
  git add README.md THIRD_PARTY_NOTICES.md browser-extension/douyin-visual-reader scripts package.json
  git commit -m "feat: extract text from redacted comment cards"
  ```

  Task 6 is complete at frontend code commit `8b2e00d`, with backend documentation baseline `c31abf5`. Final independent review is `APPROVED` with 0 Critical, 0 Important, and 0 Minor findings. The current implementation uses immutable owner/generation/revision authorization, one-use popup confirmation, body-minus-metadata OCR, lossless redacted WebP validation, provenance hashes, low-confidence truncated-DOM fallback, bounded local workers/raw resources, and a closed lifecycle-bound ACK. Final verification passes focused protocol/content/service-worker lifecycle tests, strict frontend types, the complete visual-reader suite, the 125-check frontend self-test, unpacked-extension OCR smoke, extension build/audit and main build, 78/78 backend contracts, 18/18 acquisition drift, generated-type freshness, backend build, and diff checks. The only build message is the existing Vite chunk-size warning. No real Douyin page was accessed. The protected user-owned untracked `package-lock.json` remained outside Task 6.

### Task 7: 视觉观察转 Evidence、需求信号和 Run Presentation

**Status:** COMPLETED. Final independent review is `APPROVED` with 0 Critical,
0 Important, and 0 Minor findings. Final code commit is `73c515a`; the reviewed
documentation baseline is `37474c9`. No Task 8 work is included.

**Repository:** `/Users/mac/Documents/新项目/GoodJob-growth`

**Files:**
- Create: `backend/src/acquisition-visual-comment-ingestion.ts`
- Create: `backend/src/acquisition-visual-comment-ingestion-test.ts`
- Create: `backend/src/acquisition-visual-reader-recovery-sweeper.ts`
- Create: `backend/src/acquisition-visual-reader-recovery-sweeper-test.ts`
- Modify: `backend/src/acquisition-visual-reader-sessions.ts`
- Modify: `backend/src/acquisition-visual-reader-sessions-test.ts`
- Modify: `backend/src/acquisition-visual-reader-mysql-repository.ts`
- Modify: `backend/src/acquisition-visual-reader-mysql-repository-test.ts`
- Modify: `backend/src/acquisition-visual-reader-service.ts`
- Modify: `backend/src/acquisition-visual-reader-service-test.ts`
- Modify: `backend/src/acquisition-domain.ts`
- Modify: `backend/src/acquisition-domain-service.ts`
- Modify: `backend/src/acquisition-public-identity-resolver.ts`
- Modify: `backend/src/acquisition-individual-signal-ingestion.ts`
- Modify: `backend/src/acquisition-douyin-comment-ingestion.ts`
- Modify: `backend/src/acquisition-douyin-comment-ingestion-unit-of-work.ts`
- Modify: `backend/src/acquisition-douyin-comment-ingestion-unit-of-work-test.ts`
- Modify: `backend/src/acquisition-mysql-repositories.ts`
- Modify: `backend/src/acquisition-mysql-repositories-test.ts`
- Modify: `backend/src/acquisition-run-presentation.ts`
- Modify: `backend/src/acquisition-run-presentation-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `contracts/json-schema/discovery-evidence.v1.schema.json`
- Modify: `contracts/json-schema/individual-demand-signal.v1.schema.json`
- Modify: `contracts/json-schema/acquisition-run-presentation.v1.schema.json`
- Modify: `contracts/test/schema-registry.test.mjs`
- Modify: `contracts/README.md`
- Regenerate: `frontend/src/features/ai-growth/generated/ai-acquisition.ts`

**Ingestion rules:**

- 观察和包含 `actorId`、append-time disposition 的可租赁视觉工作项由视觉仓库原子持久化。新建 `queued` 工作的 attempt 为 0；`running/retry/succeeded/manual_review_only` 必须至少有一次领取。每次领取生成新的不透明 `leaseToken` 并递增 attempt；complete/fail 必须在同一原子更新中匹配 owner、token、attempt、status，并严格早于租约到期时间，旧领取结果在同 worker 重领后也不能提交。存储生命周期矛盾时读取、领取和聚合均失败关闭；独立的视觉 recovery sweeper 实现公平领取、退避、租约失效和 poison 隔离；Domain、候选、公开事件和工作完成共用现有 memory/MySQL unit of work。
- 自动工作先通过受限 Domain API 创建字面 ID `visual:<observationId>:evidence:<textHash>` 的 `authorized_visual_observation` Evidence。通用 Evidence append 不能伪造该 provenance 或 supersedes 链。
- 只有完整、高置信且 URL/作品/评论/时间/计数/公开身份都闭合的观察才调用现有 `ingestSample` 一次。升级后保留 platform 和 visual 两条 Evidence，附加 visual Evidence 不再合并第二次信号；负面新身份从创建起即 `do_not_contact`。
- 验证 `secUid` 与匹配主页使用现有 resolver 的稳定身份；昵称或其他不可验证观察仅使用 `unmergeable:douyin:visual:<observationId>` 且为 `needs_research`。`noise` 仅留 Evidence，不推断身份、收入、金额或敏感属性。
- DOM/ARIA 被使用字段缺少或低于 0.85、OCR 文字低于 0.90、DOM/OCR 冲突或截断都只能 `manual_review_only`；`vision` 失败关闭。fresh/replay 响应与仓库 disposition 共用同一 predicate。
- Run Presentation 保留控制会话的 `sessionId/status/limits/usage/outcome`，并必须输出 `sessionCount`、`aggregateStatus`和安全上限的 `aggregateUsage`。控制会话是最新 active，否则是 `(authorizedAt, sessionId)` 最新 terminal；最多 1000 会话，工作计数使用未截断 aggregate projection。五个视觉步骤严格固定顺序，零观察只表示 `no_visible_comments`。

- [x] **Step 1: 写 ingestion/projection/recovery RED 测试**

  覆盖 DOM 高置信度、OCR 高置信度、低置信度、无 ID、真实评论 ID 升级、同昵称不合并、同 secUid 聚合、跨租户、制品到期仍保留证据哈希、每个 saga 故障边界和进程重启自动恢复。

- [x] **Step 2: 运行 RED**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-visual-comment-ingestion-test.ts src/acquisition-visual-reader-recovery-sweeper-test.ts src/acquisition-run-presentation-test.ts`

  Expected: FAIL。

- [x] **Step 3: 实现确定性 Evidence/信号转换和恢复**

  复用 `classifyDouyinCommentIntent`，但把 `extractionMethod/confidence/coverage/observationId/artifactId` 写入 provenance。视觉文字只作为公开需求信号，不推断身份、收入或敏感属性。

- [x] **Step 4: 实现真实 Run Presentation**

  进行中、部分成功、扩展缺失、用户停止、页面安全验证、低置信度和成功状态均由 session/observation/saga 记录组装；不把 0 条观察误写为“没有客户”。

- [x] **Step 5: 运行 GREEN、合同和构建**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-visual-comment-ingestion-test.ts src/acquisition-visual-reader-recovery-sweeper-test.ts src/acquisition-run-presentation-test.ts && npm run test:contracts && npm run build --workspace backend`

  Expected: PASS。

- [x] **Step 6: 提交并通过独立审查**

  Task 7 后端、合同、生成类型和当前文档已精确提交；最终代码为 `73c515a`，审查文档基线为 `37474c9`。独立审查以 0 Critical、0 Important、0 Minor 通过；提交不包含 Task 8、外部前端工作树或任何 `package-lock.json`。

### Task 8: 双仓 E2E、安全门禁、视觉验收和发布文档

**Backend repository:** `/Users/mac/Documents/新项目/GoodJob-growth`

**Frontend repository:** `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`

**Current progress:** `COMPLETED` — frontend final HEAD/code
`bb61826e1da9b9cb7ace705f534c5a2dd3eb999e`, backend Task 8 documentation baseline
`ac4c7bdd9702186f51d349e251dd7ab13f45af87`, independent review `APPROVED` with 0 Critical, 0 Important, and
0 Minor findings. Task 8 is the final task; there is no Task 9.

**Files:**
- Create (frontend): `tests/acquisition-visual-reader.spec.ts`
- Create (frontend): `tests/fixtures/visual-reader-extension-harness.ts`
- Modify (frontend): `playwright.config.ts` only if the existing deterministic server cannot host the extension harness.
- Modify (backend): `README.md`
- Modify (backend): `docs/product/ai-acquisition-agent.md`
- Modify (backend): `docs/product/2026-08-05-douyin-ai-acquisition-prd.md`
- Modify (backend): `THIRD_PARTY_NOTICES.md`
- Modify (frontend): `README.md`

**E2E scenario:**

- Playwright fixture 模拟扩展严格消息协议，不访问抖音；用户从 `#acquisition` 创建会话、看到授权提示、接收 DOM 与 OCR 观察、API 持久化、刷新页面后从服务端恢复，并打开遮挡裁剪 Evidence。
- fixture 验证错误 nonce、超限观察、原始截图、Cookie 字段和未遮挡头像均被拒绝；写请求记录中不存在评论、私信、点赞、关注、发布或 CRM 自动转换。
- 真实 Chrome 扩展 smoke 只在显式 `GOODJOB_VISUAL_READER_SMOKE=1` 时运行，必须由人工选中公开视频和点击开始；输出仅包含会话状态、数量、方法和稳定错误码，不输出评论正文或个人字段。

- [x] **Step 1: 写 E2E RED 测试**

  覆盖 1440/1024/768 视口、键盘操作、扩展缺失、DOM 成功、OCR fallback、低置信度、用户停止、安全验证、刷新恢复、制品授权和无横向溢出。

- [x] **Step 2: 运行 RED**

  Run: `npm run test:e2e -- acquisition-visual-reader.spec.ts`

  Expected: FAIL，直到 Tasks 4–7 完成。

- [x] **Step 3: 完成最小集成修正并进行真实页面视觉检查**

  启动后端 4190 与前端 5191，打开 `#acquisition`。检查深绿/暖白风格、授权解释、预算、时间线、长评论折行、低置信度警示、图片遮挡和停止态；不触发真实抖音网络。

- [x] **Step 4: 运行安全与全量确定性验收**

  Backend:

  ```bash
  npm run test:acquisition --workspace backend
  npm run check:acquisition-contracts
  npm run build
  git status --short
  ```

  Frontend:

  ```bash
  npm run test
  npm run test:visual-reader
  npm run test:e2e -- acquisition-visual-reader.spec.ts
  npm run build:visual-reader
  npm run build
  git status --short
  ```

  Result: Task 8 E2E 10/10、frontend self-test 125/125、三套 types、
  visual-reader、visual-reader build、OCR smoke、main build 和 diff check
  全部 PASS。Backend `check:acquisition-contracts` 与 root build PASS；完整
  acquisition 保留既有 977 total / 974 pass / 两个 Pi baseline failures /
  一个缺少 live MySQL 的 skip。manifest 无禁止权限，完整截图、Cookie 和
  浏览器配置不出现在网络 fixture、日志或持久层。

- [x] **Step 5: 同步当前执行文档**

  README/PRD 正文直接说明授权入口、DOM/OCR 顺序、可见一级样本覆盖、预算、隐私、低置信度、人工复核、扩展安装/卸载和 Beta smoke；不把它写成抖音官方连接器或全量评论能力。历史设计仅在内容真实过期时改正文，不在顶部堆修订说明。

- [x] **Step 6: 分仓提交**

  Backend:

  ```bash
  git add README.md docs/product/ai-acquisition-agent.md docs/product/2026-08-05-douyin-ai-acquisition-prd.md THIRD_PARTY_NOTICES.md
  git commit -m "docs: document authorized visual reader beta"
  ```

  Frontend:

  ```bash
  git add tests/acquisition-visual-reader.spec.ts tests/fixtures/visual-reader-extension-harness.ts playwright.config.ts README.md
  git commit -m "test: verify authorized visual comment reading"
  ```

- [x] **Step 7: 最终复审与状态核对**

  独立复审实现对本计划和已批准设计的逐项符合性，特别检查权限、原始截图生命周期、遮挡像素、身份升级、低置信度门禁、恢复语义和真实 UI。两仓分别运行 `git status --short` 与 `git log -15 --oneline`，确认没有带入用户原有文件。

  Final result: `APPROVED`，0 Critical、0 Important、0 Minor。Browser QA 在
  default、1024、768 下均为 document width 等于 viewport width，console
  error 为 0；完整业务视觉路径由确定性 Task 8 E2E 证明。合并验证还确认
  `wasm-feature-detect@1.9.0` 必须作为直接运行依赖存在，frontend `bb61826`
  已同时提交该依赖和更新后的 `pnpm-lock.yaml`。Frontend 视觉 worktree 仅保留
  用户原有未跟踪 `package-lock.json`，backend clean。
