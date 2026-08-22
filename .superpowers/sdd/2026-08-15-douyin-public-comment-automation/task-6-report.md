# Task 6 报告：真实自动化时间线、高潜评论与 OpenAPI

## 结果

- `AcquisitionRunPresentation` 固定返回七个自动化步骤。不可变计划版本不是抖音或未启用公开评论策略时七步均 skipped；普通网页搜索 shard 不冒充视频发现。发现时间只取 shard 事件，fetch 时间只取 attempt，其他没有独立生命周期的步骤返回 null 时间。
- Run summary 增加已发现视频、已采样评论、有效需求信号、未核验主体和高潜强信号五项。memory/MySQL repository 聚合整个租户 Run 的 attempt，第 101 条及以后不被截断；candidate/signal 事实以 10000 条硬上限保护。
- `commentSignals` 独立返回最多 50 条最新评论事实。只有真实 scoped candidate 与 Evidence、candidate evidenceId 归属及精确 platform event provenance 全部成立时才公开；悬空或交叉链接 fail closed，不返回头像，也不改变候选事件的签名 cursor。
- comment intent 仅对已持久 immutable event text 使用 Task 4 的确定性规则分类器；negative 和 `do_not_contact` 不计有效需求。未核验主体按已聚合稳定公开主体跨视频、跨页去重，未核验强信号标记为 `needs_research`。
- 高意向统计统一为 S/A 且 qualification 无 hard gate、候选非 `do_not_contact`。memory 与 MySQL 聚合规则一致；资格尚未完成的已持久事件仍可见，研判步骤在终态 Run 中显示 `partial_success + model_output_invalid`。
- 时间线覆盖 `public_sample_unavailable`、`access_restricted`、`rate_limited`、`video_id_unresolved`、`source_payload_invalid`、`no_public_comments` 和 `model_output_invalid`。有成功评论与空视频时仍为 succeeded；部分 429 保留成功结果并显示 partial_success；全部受限显示 failed。
- application 的 memory/MySQL composition 把 Task 5 已有同一 `douyinCommentEvents` repository 注入 presentation。公开 JSON Schema、runtime OpenAPI、响应一致性、生成前端类型均已同步；仅更新旧测试/demo fixture 以满足新必填 DTO，未实现 Task 7 组件或交互。

## TDD 证据

- 首组 RED：`npm exec --workspace backend -- tsx --test src/acquisition-run-presentation-test.ts` 得到 `11 tests / 5 pass / 6 fail`。首个失败为 `automationSteps` 不存在导致 `Cannot read properties of undefined (reading 'map')`；其余失败对应 running、全受限、no-public、旧 Run、summary 和 comment signal 缺口。
- 高意向门禁 RED：现有 S/A 统计仍包含 explicit rejection 与 `do_not_contact`，实际 `highIntent=3`，期望为 1；memory/MySQL 使用同一 hard-gate 条件后 GREEN。
- OpenAPI response RED：nullable `errorCode` 最初只有字符串 enum，真实 null 响应被七个步骤逐项拒绝；把 null 纳入严格 enum 后 response conformance GREEN。
- 合同总门禁第一次运行在生成类型后的四个旧 frontend test/demo fixture 编译失败；只补齐新 DTO 字段后 frontend build 与 `184/184` 测试 GREEN，没有新增前端展示逻辑。

## 验证

- Task 6 focused + affected repository/MySQL/OpenAPI：`103 tests / 103 pass`。
- Presentation focused：`17 tests / 17 pass`（含 8 个状态/错误子用例；Node 总计按 TAP 为 17）。
- Contracts：`66/66`；contract drift：`17/17`；OpenAPI/响应一致性：`28/28`；security GREEN；generated type check GREEN。
- `npm run check:acquisition-contracts`：最终通过；frontend `184/184`，Baota package `2/2`。
- Backend TypeScript build、frontend build 通过；仅有既有 Vite chunk-size warning。
- `git diff --check`：通过。
- Full acquisition：`807 tests / 805 pass / 2 fail`。精确命令：

  ```bash
  NODE_ENV=test TZ=UTC JWT_SECRET=goodjob-acquisition-test-secret-at-least-32-characters ACQUISITION_MASTER_SECRET=goodjob-acquisition-master-test-secret-at-least-32-bytes node --import tsx --test --test-concurrency=1 --test-force-exit src/model-config-migration-test.ts src/model-provider-endpoint-registry-test.ts src/model-official-connection-profile-test.ts src/model-connection-idempotency-test.ts src/model-connection-service-test.ts src/model-pending-appends-test.ts src/model-gateway-test.ts src/model-runtime-integration-test.ts src/provider-connection-version-test.ts src/acquisition-*-test.ts
  ```

- 两项失败仅为已确认基线：`acquisition-pi-gateway-runtime-test.ts` 与 `acquisition-pi-runtime-factory-test.ts`，均为 `MODEL_TOOL_DEFINITION_INVALID`。Task 6、新 schema、MySQL 聚合与 presentation 测试没有失败。

## 安全与文档

- 未复制或接入 cv-cat/DouYin_Spider 的 Cookie、逆向签名、指纹伪装、私信或互动代码；数据仍来自固定注入、无凭证的公开评论样本 Provider。
- `contracts/README.md`、当前 design 和执行 plan 已同步真实七步投影、独立评论窗口、全量 summary、高意向硬门禁与错误规则；BrowserAct/OCR 视觉读取章节保持不变。

## Fix round 1

- RED：`npm exec --workspace backend -- tsx --test src/acquisition-run-presentation-test.ts` 为 `23 tests / 17 pass / 6 fail`。六个失败分别证实 negative/do-not-contact 被误计、attempt 101 被截断、步骤借用了错误时间、pending saga 下主体聚合误成功、悬空/交叉 Evidence 仍公开，以及非抖音/未启用计划把网页搜索显示成视频发现。
- GREEN：同一 presentation focused 为 `23/23`。affected repository、ingestion、enrichment、MySQL、OpenAPI、drift 与 performance 组合为 `144/144`。
- MySQL parity 使用 repository 聚合所有 attempt，并以 `JSON_TABLE ... LIMIT 10001` 检测 terminal candidate 硬上限；signal event/observation 使用三次批量租户查询，不做逐 signal 查询。Domain candidate 与 Evidence 均使用批量 scoped projection。
- 一个已提交 link 与另一个 pending saga 并存时，标准化事件仍按已持久事实显示，但主体聚合使用独立 upstream/processed 数量并保持 `partial_success`。资格完整度同时使用全部 attempt terminal candidate 和已验证 link candidate。
- Application memory/MySQL focused 自然退出 `2/2`；`check:acquisition-contracts` 通过（contracts `66/66`、drift `17/17`、security、OpenAPI、frontend `184/184`、Baota 均 GREEN），generated type check、backend build 与 `git diff --check` 通过。
- 最终 full acquisition 为 `807/805/2`；两项仍仅是 `acquisition-pi-gateway-runtime-test.ts` 与 `acquisition-pi-runtime-factory-test.ts` 的既有 `MODEL_TOOL_DEFINITION_INVALID`。

## Fix round 2

- RED：`npm exec --workspace backend -- tsx --test --test-name-pattern='comment cards require exact event provenance' src/acquisition-run-presentation-test.ts` 为 `9 tests / 2 pass / 7 fail`。providerVersion、coverage、sourcePlatform、accessStatus、contentHash 及错误 candidate actor 六个子测均证实不一致事实会被错误公开；精确 secUid 和大小写规范化 handle 正例已经通过。
- GREEN：同一定向矩阵为 `9/9`，完整 presentation focused 为 `32/32`。投影现在逐项匹配 Evidence 与 event 的 platform、access status、content hash、provider version、coverage、platform event ID 和 source URL，并只接受同一 individual candidate 拥有该 Evidence。
- 主体绑定复用现有严格 Douyin actor-key 规范化：secUid 优先，handle 仅规范化大小写，无可用稳定主体时使用 comment-scoped key；不做模糊 handle 匹配，不引入新 PII。
- 相关 identity/domain/event repository/MySQL/presentation 组合为 `105/105`；Backend build 与 `git diff --check` 通过。公开 DTO、OpenAPI 与存储接口未变，因此无需重生合同。Round 1 的 full acquisition `807/805/2` 仍为本轮继承门禁，本轮仅有上述事实绑定收紧。
