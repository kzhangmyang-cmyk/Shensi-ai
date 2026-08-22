# AI 获客计划 / 运行核心实现报告

日期：2026-07-24

## 交付范围

- `backend/src/acquisition-plan-run-repository.ts`
  - 定义 acquisition plan/run/operation shard、预算、事件和审计模型。
  - 提供事务化内存仓储；计划版本、事件和审计记录只能追加。
  - 事务串行化保证并发创建运行时的幂等唯一性。
- `backend/src/acquisition-plan-run-service.ts`
  - 计划创建、草稿更新、新版本派生、ETag 乐观锁。
  - 明确人工批准后冻结 ICP、组织/个人双通道、数据源连接、查询、预算与模型快照。
  - 只有 approved 版本可以创建运行。
  - 生成 `search`、`content_fetch`、`import_rows` 操作分片。
  - 队列执行端口仅暴露 enqueue/pause/resume/cancel，不含任何触达动作。
  - 执行意图与领域状态在同一事务落库，支持失败回 pending、租约回收和至少一次重派；所有端口调用携带稳定 `dispatchKey`，适配器必须据此幂等。
  - pause/resume/cancel 安全点状态机。
  - 分片预算和运行总预算硬门禁；拒绝会导致超限的用量。
  - 运行预算耗尽后收敛取消其他分片，最终进入 `budget_exhausted`。
  - `budget_exhausted` 禁止原地恢复，必须新批准计划版本并创建带 `parentRunId` 的新运行。
  - 运行创建和预算入账幂等，owner/team 双重隔离。
- `backend/src/acquisition-plan-run-test.ts`
  - 10 个端到端领域测试场景。

## TDD 证据

RED：

```text
Error [ERR_MODULE_NOT_FOUND]:
Cannot find module '.../acquisition-plan-run-service.js'
```

随后增加“预算耗尽必须通知执行端口取消运行中分片”断言，再次观察到 RED：

```text
Expected cancel port call, actual undefined
```

GREEN：

```text
10/10 acquisition plan/run tests passed
```

严格 TypeScript：

```text
npx tsc -p tsconfig.json --noEmit
exit 0
```

## 集成边界

- 本切片不修改 `server.ts`、`store.ts`、`mysql-store.ts` 或模型供应商文件。
- 生产集成时，由外层适配器实现 `AcquisitionExecutionPort`，接入既有队列。
- 执行意图采用至少一次投递；外层队列适配器必须按 `dispatchKey` 幂等处理，以覆盖“端口成功、dispatched 落库前进程退出”的窗口。
- 本切片不包含自动评论、自动私信、自动加好友、自动群发或任何触达执行。
- 内存仓储用于领域契约与测试；生产持久化应实现同一个仓储接口，并为幂等范围和追加事件建立数据库唯一约束。
