# Task 6 — Editable Douyin keywords and evidence-grounded outreach drafts

Status: implemented.

## RED

The exact Task 6 focused command was run before the new modules existed. It
failed as expected with `ERR_MODULE_NOT_FOUND` for all five Task 6 production
modules. The carried Task 5 prerequisite tests were also added first and
failed for the expected reasons: Chinese `17岁` text was qualified, and DNC
audit dedupe called `listAuditEvents` twice.

## GREEN

- Chinese numeric ages now use an NFKC-safe parser rather than ASCII `\b`;
  `我今年17岁，想学习。现在需要获客方案`, spacing, punctuation, and full-width
  variants suppress before the draft service can call a model.
- DNC audit event dedupe uses an exact `findAuditEvent` point lookup. Memory
  and MySQL implement the same scoped lookup, and MySQL uses the event primary
  key rather than a full workspace audit scan.
- `generateDouyinKeywords` uses the server-resolved active snapshot and a
  closed structured tool response. Keywords are NFKC-canonical, deduplicated,
  bounded to 20, and the public route accepts no caller workspace, business,
  ICP, or model authority.
- The private draft service loads only workspace-owned persisted Douyin
  candidates and exact candidate evidence. It rechecks DNC/refusal/complaint/
  minor signals, validates candidate revision and evidence hashes, rejects
  unsafe or unsupported content, computes the server hash, and returns an
  immutable value. Raw model output is not persisted. Task 7 remains the only
  batch/draft-revision persistence owner.
- OpenAPI, runtime OpenAPI, generated frontend types, route conformance, and
  current acquisition/API/progress documentation are synchronized.

## Verification

- Focused Task 6 plus prerequisite and OpenAPI suites: 55 passed, 0 failed,
  1 environment-gated MySQL test skipped.
- `pnpm --filter ./backend test:model-gateway`: 21 passed, 0 failed.
- `pnpm check:acquisition-contracts`: passed (contracts 91/91; contract
  drift 18/18; security, runtime OpenAPI 39/39, generated types, frontend
  build/tests, and Baota package passed; existing Vite >500 kB advisory only).
- `pnpm --filter ./backend test:acquisition`: passed (aggregate includes the
  Task 6 suites; optional live-MySQL cases remain environment-gated).
- `pnpm test`, `pnpm build`, `./scripts/context-check`, and `git diff --check`:
  passed.

## Scope and documentation

Task 6 adds the keyword generator/router and model/draft validation service,
plus their tests. The two carried Task 5 fixes touch only candidate policy and
the domain audit lookup/repository implementations/tests. Current module,
API index, and project-status documents reflect the public route and private
non-persistent draft boundary.

## Concerns

No live provider or credentialed MySQL evidence is claimed. The pre-existing
Minor response-contract maximum issue for `acquisitionRunId`/crawler `runId`
was not changed.

## Commit

`feat(acquisition): draft evidence-grounded Douyin outreach` (this report is
included in that commit; the exact immutable hash is provided in the Task 6
handoff).

## Fix round 1/5 — review remediation

### RED

- Added counterexamples first. The focused command failed as expected because
  `parseDouyinKeywordToolArguments` did not exist; `17岁想学习` reached the
  model gateway; and zero-width/Unicode control, percentage-outcome, and
  unsupported-claim draft values were accepted.
- The contract gate initially failed after the closed keyword POST body was
  introduced because its Section 16 idempotency expectation still described
  the old non-idempotent operation. The contract expectation was updated with
  the public API change.

### GREEN

- Registered immutable Task 6 keyword/draft prompts and tool schemas in the
  active acquisition content bundle, advanced the active content versions to
  prompt v6/schema v7, and invoke generation exclusively through
  `contentBinding`. Bound gateway calls now transmit trusted prompt content in
  a system message and canonical dynamic data in a separate user message.
- Keyword POST requires a closed `{}` body and an `Idempotency-Key`. It uses
  the existing persist-backed tenant idempotency ledger: exact retries replay
  the stored response without model traffic; changed plan semantics conflict.
  New commands deliberately omit snapshot-resolver replay identity, so they
  resolve the current active credential/model/content snapshot.
- Tool argument records are closed and shape-checked before canonicalization.
  Policy handles contiguous numeric and Chinese-numeral minor ages and
  normalized natural-language refusal. Draft safety projects away Unicode
  format/zero-width separators, rejects all controls/line separators, URL,
  phone, guarantee and percentage-outcome patterns, and applies deterministic
  evidence sentence grounding.
- Draft service rereads candidate revision/status/evidence after model traffic
  and rejects an authority change, including newly applied DNC.
- OpenAPI, generated frontend contract types, contract tests, and the current
  acquisition module documentation now publish the closed idempotent keyword
  command.

### Verification

- Focused remediation/model/content/OpenAPI/application suite: 100 passed,
  0 failed.
- `pnpm --filter ./backend test:model-gateway`: 21 passed, 0 failed.
- `pnpm check:acquisition-contracts`: passed (contracts 91/91, contract-drift
  18/18, security, runtime OpenAPI 39/39, generated types, frontend
  build/tests, and package gate all passed; existing Vite chunk advisory only).
- `pnpm --filter ./backend test:acquisition`: passed; the aggregate includes
  the Task 6 remediation suites.
- `pnpm build`, `./scripts/context-check`, and `git diff --check`: passed.

### Scope / deferred concern

No raw model output is stored and Task 7 remains the sole revision-persistence
owner. The ledger-deferred Minor response-contract maximum was not changed.
