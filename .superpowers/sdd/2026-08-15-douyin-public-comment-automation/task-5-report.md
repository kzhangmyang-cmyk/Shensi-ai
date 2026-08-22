# Task 5 报告：把评论富化接入搜索和用户链接的真实 Run

## 结果

- 搜索分片只从完整、与当前 Provider 连接及查询精确匹配的 `search_result` Evidence 中提取抖音作品 URL。伪造的单字段 `sourceUrl` 不会触发评论读取。富化在 candidate pipeline 前完成，并合并去重候选 ID。
- content-fetch 原页执行与调用方评论富化分离。direct 和每个 `runId + shardId` 都有独立持久 execution，保留策略、剩余预算、租约、尝试次数、退避和终态 summary，running/terminal 结果不会跨 context 复用。
- 用户显式创建单链接任务时，standalone `1 视频 / 30 评论 / 3 页` intent 与 operation 同次写入。其他无 Run 后台工作不自动扩大采集。公开响应不暴露 execution/policy/budget/lease，只投影调用方对应的 `commentSampleSummary`。
- memory/MySQL 都支持持久 recovery：启动首次 sweep、定时 sweep、租户隔离领取、bounded lease/backoff 和 poison isolation。不需要调用者重放；并发 claimer 只有一个成功。MySQL base terminal write 在 `SELECT ... FOR UPDATE` 后按 lease fence 合并最新 executions，不覆盖 claim 之后新增或完成的 context。
- Provider 实际 HTTP 重试次数计入 usage，剩余 transport budget 传入 Provider，单次请求不会因返回后校验错误重复记账。跨页 comment/cursor 去重状态只存在当次 enrichment，没有跨租户或 Run 的全局 Map。
- 混合「有评论 + `no_public_comments`」仍为 `succeeded`，不增加 failed result；全部为空时为 `succeeded_empty`，并保留可解释错误。单视频 429/受限时保留其他成果。
- 只信任 canonical `douyin-public-comments + experimental_public_sample + content_fetch + active + credentialVersion=1`，执行端仍只使用 application 固定注入 Provider。Discovery MySQL schema 在 recovery 前使用专用连接和 advisory lock 串行升级；获取或释放失败销毁会话，不放回池。
- content-fetch schema 强制 `candidateCount === candidateIds.length`，最大 101；MySQL 解析、OpenAPI、样例、生成前端类型和公开响应一致。旧 row 中 null/缺失 executions 按空数组恢复。
- 原页抓取失败或无 final URL 会在租约 fence 内把调用方 execution 终止为 `failed + BASE_CONTENT_FETCH_FAILED`，不再被 recovery 领取。MySQL 对 direct/Run identity、确定性 execution ID、策略/预算界限和所有状态/租约组合严格 fail-closed。
- standalone intent 是版本化不可变 request hash 的一部分；同键 `true/false` 任意方向切换都稳定冲突。memory/MySQL 每个 operation 最多写入 1000 个调用方 execution，第 1001 个被拒绝且原 operation 仍可读。
- 每个视频的首次终态 attempt 持久 transport/耗时、event/evidence/candidate 和聚合计数。相同 Run context 在 memory 精确重放和 MySQL 重启后均直接聚合该投影，不再请求 Provider 或 ingestion；旧终态无投影时保守使用已有持久计数。
- Provider 对 invalid JSON/payload、normalize 和 source validation 错误也附带已消耗的 transport 请求数；搜索 Evidence 还必须与当前 owner/team 一致。Run worker 显式请求内部 tenant-scoped projection，普通工具响应仍不暴露 owner/team。

## TDD 证据

- Review batch A RED：`53 tests / 48 pass / 5 fail`：direct/Run context 复用、exact replay `FETCH_ATTEMPT_CONFLICT`、缺 transport budget/记账、search 超预算后仍进 candidate pipeline。
- Review batch B RED：5 个定向用例全部失败：Provider 全局状态、cursor loop、不完整 Evidence、非 canonical connectionId、`no_public_comments` 组合状态；application canonical 负例 `0/1`。
- Review batch C RED：MySQL discovery/status execution 3 个定向用例 `0/3`；contract `candidateCount=3/candidateIds=2` 反例当时被错误接受，`0/1`。
- Durable execution RED：create 未同步持久 direct intent，`0/1`；direct/Run 真实 `Promise.all` 交错触发 `RESOURCE_NOT_FOUND`，`0/1`。
- Recovery/MySQL RED：原实现无 caller-independent durable recovery；新测试覆盖 restart、tenant scope、exactly-one claim、backoff/fairness、legacy null、migration acquire/release poison。MySQL terminal stale payload 测试精确得到 `[]` 而不是后加 execution，`0/1`；行锁合并后 GREEN。
- 真实 request usage 审计 RED：单次 HTTP 在 page validation 后显示 `2 !== 1`，`0/1`；按 provider-call baseline 修正后 GREEN。
- Application focused 曾因严格 Provider provenance 和新增专用 migration connection 报 2 个 fixture 错误；修正 fixture 后 `4/4`。
- Review round 2 七组 RED 定向命令为 `7 tests / 0 pass / 7 fail`：原页失败 execution 仍 queued；矛盾的 MySQL 状态/identity 被接受；standalone intent 可静默切换；第 1001 execution 被写入；精确搜索重放第二次请求 Provider；cross-tenant Evidence 触发富化；两次 500 后 invalid 200 丢失 3 次 transport usage。
- Review round 2 GREEN：parser 完整状态矩阵 `1/1`，MySQL projection/restart/schema parity `4/4`，application 真实双路径及 lifecycle focused 自然退出 `5/5`。
- 最终 lease-owner 边界 RED 为 `2 tests / 1 pass / 1 fail`：service 和 MySQL `VARCHAR(160)` 允许的 101/160 字符 worker ID 在 running round-trip 被 parser 的旧 100 字符上限拒绝。将 parser 与 service/schema 统一为 160 后，claim → running read → expired recovery claim → complete → restart read 两个边界均通过，161 字符仍 fail-closed，定向 `2/2`。

## 验证

- Discovery operation/router/recovery/MySQL focused：`57/57`。
- Provider/enrichment/search/events/discovery/tool-executor affected expanded：`151/151`。
- 最终 discovery expanded：`76/76`；backend TypeScript build 通过。
- Application tracer/lifecycle/MySQL schema focused：`5/5`，自然退出。
- Contracts：`66/66`；drift：`17/17`；OpenAPI/响应一致性：`28/28`；generated type check 通过。
- `npm run check:acquisition-contracts`：通过；其中 frontend `184/184`，Baota package `2/2`。
- `npm run build`：backend/frontend 通过；仅有已知 Vite chunk-size warning。
- `git diff --check`：通过。
- Full acquisition：`785 tests / 783 pass / 2 fail`。精确命令为 `NODE_ENV=test TZ=UTC JWT_SECRET=goodjob-acquisition-test-secret-at-least-32-characters ACQUISITION_MASTER_SECRET=goodjob-acquisition-master-test-secret-at-least-32-bytes node --import tsx --test --test-concurrency=1 --test-force-exit src/model-config-migration-test.ts src/model-provider-endpoint-registry-test.ts src/model-official-connection-profile-test.ts src/model-connection-idempotency-test.ts src/model-connection-service-test.ts src/model-pending-appends-test.ts src/model-gateway-test.ts src/model-runtime-integration-test.ts src/provider-connection-version-test.ts src/acquisition-*-test.ts`。
- 两项失败仅为已确认 Pi 基线：`acquisition-pi-gateway-runtime-test.ts` 和 `acquisition-pi-runtime-factory-test.ts`，都是 `MODEL_TOOL_DEFINITION_INVALID`。

## 安全与文档

- 未复制或接入 cv-cat/DouYin_Spider 的 Cookie、逆向签名、指纹伪装、私信或互动代码；只使用固定注入的无凭证公开样本 Provider。
- `contracts/README.md`、当前 design 和执行 plan 已按持久 context/recovery、严格 Evidence、真实 usage、canonical connection 和空覆盖语义同步。BrowserAct/OCR 章节保持不变。
