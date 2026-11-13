### Task 2: Fenced Node activity persistence and private gateway

**Files:**
- Modify: `backend/src/acquisition-crawler-job.ts`
- Modify: `backend/src/acquisition-crawler-job-repository.ts`
- Modify: `backend/src/acquisition-crawler-job-mysql-repository.ts`
- Modify: `backend/src/acquisition-mediacrawler-gateway.ts`
- Modify: `backend/src/acquisition-crawler-worker.ts`
- Test: `backend/src/acquisition-crawler-job-test.ts`
- Test: `backend/src/acquisition-crawler-job-mysql-repository-test.ts`
- Test: `backend/src/acquisition-mediacrawler-gateway-test.ts`
- Test: `backend/src/acquisition-crawler-worker-test.ts`

**Interfaces:**
- Consumes: private sidecar `activity` in snake_case.
- Produces: `AcquisitionCrawlerActivity` in camelCase.
- Produces: `updateActivity(fence, { activity, now })`, with monotonic sequence and frozen-keyword validation.

- [ ] **Step 1: Write failing gateway, Memory/MySQL repository, and worker tests**

```ts
await repository.updateActivity(fence, {
  activity: {
    phase: "searching", currentKeyword: "袜子",
    browserMode: "visible", sequence: 2
  },
  now
});
assert.equal((await repository.findByRun("workspace-1", "run-1"))
  ?.activity.currentKeyword, "袜子");
```

Tests also prove that a lower sequence, a same-sequence conflict, a non-frozen
keyword, and private extra gateway fields are rejected, and that the worker
persists activity while `pageCount` is zero.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-mediacrawler-gateway-test.ts \
  src/acquisition-crawler-worker-test.ts \
  src/acquisition-crawler-job-test.ts \
  src/acquisition-crawler-job-mysql-repository-test.ts
```

Expected: compile/test failures for the missing activity contract and repository method.

- [ ] **Step 3: Implement the domain, repository, gateway, and worker path**

```ts
export interface AcquisitionCrawlerActivity {
  phase: "queued" | "starting_browser" | "opening_douyin" | "searching"
    | "collecting_comments" | "finalizing" | "completed";
  currentKeyword: string | null;
  browserMode: "visible" | "headless";
  sequence: number;
}

updateActivity(
  fence: AcquisitionCrawlerJobFence,
  input: { activity: AcquisitionCrawlerActivity; now: string }
): Promise<AcquisitionCrawlerJob>;
```

Memory and MySQL store the snapshot in the existing job JSON. MySQL hydration
adds the safe default for old rows; no table column or destructive migration is
required. The worker persists the snapshot immediately after every validated
sidecar status read.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

## Handoff from Task 1

- Base commit for this task is `6d33f41`.
- Every sidecar crawl-job response now contains a strict `activity` object with
  snake-case keys `phase`, `current_keyword`, `browser_mode`, and `sequence`.
- The sidecar phase set is exactly the one listed above; `sequence` is a
  non-negative integer and `current_keyword` is null or an exact member of the
  frozen request keywords.
- The gateway must remain strict and reject any unknown/private activity key.
- Use a deterministic conservative default for old Node/MySQL payloads:
  `queued`, null keyword, `headless`, sequence 0. The worker must immediately
  persist the validated activity returned by both start and poll responses, so
  the sidecar-reported real deployment mode replaces that default.
- Do not run a real browser or contact Douyin. All RED/GREEN evidence must use
  the existing fake gateway/repository/MySQL boundaries.
