# Task 4 Brief — Zero-connection to Douyin plan E2E, docs and full verification

## Goal

Prove the actual first-use customer journey end-to-end: no usable search
connection → configure an official BYOK provider in the current workspace →
save disabled → test → enable → continue the preserved Douyin task → receive
an explicit Douyin acquisition plan. Then document and fully verify the slice.

## Scope

- Create `frontend/tests/ai-acquisition-provider-connection.spec.ts`.
- Reuse and minimally extend the deterministic Playwright fixture; do not call
  real search providers.
- Modify `docs/product/ai-acquisition-agent.md`.
- Only make integration corrections if the new test exposes a real defect.

## Exact E2E Flow

1. Open AI Growth new task in real mode with zero provider connections.
2. Select/default “抖音公开商机”, enter a distinctive task, submit, and observe
   connection-required without losing task/platform/template.
3. Open the inline connection center and choose `baidu_ai_search` (or another
   exact catalog provider ID).
4. Enter fixture-only secret and save. Assert exact create request:
   - POST collection
   - `Idempotency-Key` present
   - body contains selected provider, exact fixture secret and
     `status:"disabled"`
5. Server fixture returns a safe untested disabled projection. Assert the
   secret is already absent from input, drawer HTML, URL, localStorage,
   sessionStorage and console output.
6. Test connection. Assert exact POST `/:id/test`, no body and no invented
   If-Match/idempotency header. Return `{ok:true}` and refresh to a
   `passed + disabled` projection.
7. Enable. Assert PATCH body is exactly `{status:"active"}` and refresh to an
   `active + passed` projection.
8. Click “继续当前任务”. The drawer closes, the original task remains, and
   normal Copilot plan creation runs.
9. Assert outgoing Copilot message has `targetPlatform:"douyin"`; returned
   plan displays the Douyin target and allowed compiled public-site queries.
10. Assert no automatic outreach/add-friend/comment/message endpoint was
    called and the strict fixture saw no undeclared traffic.

## Additional Honest Failure Coverage

- A separate compact scenario may return health HTTP 200 with `ok:false`; it
  must remain disabled, show failure, and not enable/continue.
- Do not duplicate every Task 3 component/a11y test; focus this spec on the
  cross-API lifecycle and plan handoff.

## Fixture Requirements

- Use stateful or ordered deterministic responses for connection list:
  empty → disabled/untested → disabled/passed → active/passed.
- Record and assert every formal write. Reject undeclared acquisition traffic.
- Fixture secret must be conspicuous and must never be a real API key.
- Do not write fixture secret to snapshots or reports.

## Documentation

Add a concise “搜索来源连接中心” section to
`docs/product/ai-acquisition-agent.md` covering:

- supported official search Provider IDs: `baidu_ai_search`,
  `tencent_web_search`, `tavily`, `serper`, `brave`, `serpapi`;
- BYOK first-use flow and why save defaults disabled;
- only active+passed search connections can run plans;
- Key encryption/write-only/non-disclosure and official Base URL restrictions;
- real search Provider vs target content platform distinction;
- limitations: a configured Provider enables public indexed search, not full
  Douyin access or automated outreach.

## Verification

Run and record fresh results for:

1. Dedicated new E2E spec.
2. Existing Douyin platform discovery E2E.
3. Frontend unit suite and production build.
4. Backend acquisition suite serially.
5. Root tests.
6. Acquisition contract/OpenAPI/generated type drift checks.
7. Baota package test and `git diff --check`.

If an unrelated pre-existing failure appears, prove it against the base commit
before classifying it; do not silently ignore it.

## Review and Commit

- Obtain independent review of the dedicated E2E, docs accuracy, secret
  assertions and any integration fix.
- Address all actionable findings.
- Commit scoped files, report and progress as
  `test: verify acquisition provider connection flow`.
- Update the implementation plan checkboxes only after fresh verification.
- Write `task-4-report.md` with commands, counts, durations, review result and
  remaining risks.

## Protected File

Do not read, modify, stage or commit
`docs/superpowers/plans/2026-07-23-ai-model-adapters-and-pi.md`.
