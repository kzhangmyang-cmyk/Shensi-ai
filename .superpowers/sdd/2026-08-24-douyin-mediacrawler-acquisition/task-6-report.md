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

## Fix round 2/5 — scoped re-review remediation

### RED

- Added the reviewer counterexamples before implementation. The focused run
  demonstrated that a keyword list with one legal entry and one overlong entry
  was silently sanitized; required age/refusal forms were missed; and a bare
  domain could survive the Unicode projection.

### GREEN

- Keyword tool arguments now fail as one closed record: every member must be a
  non-empty NFKC-normalized string of at most 100 code points and unique after
  canonicalization. Invalid members are never dropped to salvage a result.
- Age parsing consumes complete Arabic/Chinese number tokens, includes
  `不满18岁`, and retains adults such as `二十岁`, `二十八岁`, `三十七岁`, and
  `2017岁末版本`; normalized refusal includes `拒绝联系我` without relying on
  ASCII boundaries.
- Draft validation rejects Unicode format/bidi controls, bare domains, and
  candidate-specific unsupported assertions. Factual candidate clauses must
  occur verbatim in approved evidence (apart from deterministic reporting
  prefixes).
- The post-model read compares full immutable candidate/evidence authority,
  including tenant, platform, provenance, source URL, job/record/upstream
  commit, hashes/snippets, and membership. It also queries the exact
  workspace/actor DNC authority immediately before returning.
- Historical content registry entries now preserve the exact pre-Task-6 v5/v5
  and v5/v6 bundles/hashes without outreach injection; explicit compatibility
  tests resolve both snapshot identities.

### Verification

- Focused production gateway/history/race/counterexample suites: 66 passed,
  0 failed.
- `pnpm --filter ./backend test:model-gateway`: 21 passed, 0 failed.
- `pnpm check:acquisition-contracts`: passed (contracts 91/91, contract-drift
  18/18, security, runtime OpenAPI 39/39, generated types, frontend
  build/tests, and package gate passed; existing Vite chunk advisory only).
- `pnpm --filter ./backend test:acquisition`: passed (aggregate output is
  environment-gated for optional live MySQL cases).
- `pnpm build`, `./scripts/context-check`, and `git diff --check`: passed.

## Fix round 3/5 — atomic final-authority remediation

### RED

- Added the specified full-phrase policy cases first. The focused tests showed
  that `未满18岁`/`不满十八岁` and `拒绝被联系` could still pass the crawler
  gate, while generic IDN domains and a factual assertion constructed from two
  separate evidence rows were accepted.
- Added an interleaving authority test first: a DNC writer could be attempted
  between separate post-model reads because the earlier implementation had no
  single final transaction boundary.

### GREEN

- Candidate policy now normalizes NFKC/spacing/format characters and parses
  complete Arabic/Chinese age tokens and qualified age phrases. It suppresses
  the exact reviewer forms while retaining the explicit adult and version
  non-regressions (`二十岁`, `二十八岁`, `三十七岁`, `2017岁末版本`).
- Draft validation rejects arbitrary bare ASCII, Unicode-IDN, and punycode
  domains, including `example.dev`, `例子.公司`, and `xn--fsqu00a.xn--55qx5d`.
  Candidate-specific factual clauses must be present in one individual,
  approved evidence record; evidence rows are never concatenated. Rationale
  codes are a closed allow-list.
- The model result now crosses one `FinalAuthority` boundary before it is
  returned. The memory implementation uses the repository transaction plus
  the DNC writer's shared workspace/identity lock. The MySQL implementation
  locks the candidate, each exact evidence row, and the DNC primary-key
  record/gap, loads through that same connection, compares complete immutable
  authority, and commits only the frozen verified value. Changes, including a
  newly retained DNC, roll back. The draft service has no await or mutable
  authority read after this boundary, and still persists no draft.

### Verification

- Focused policy/draft/authority/service compilation suite: 14 passed, 0
  failed; expanded focused model/content/application suite: 67 passed, 0
  failed.
- `pnpm --filter ./backend test:model-gateway`: 21 passed, 0 failed.
- `pnpm check:acquisition-contracts`: passed (including runtime OpenAPI,
  generated types, frontend checks, and Baota package; existing Vite >500 kB
  advisory only).
- `pnpm --filter ./backend test:acquisition`: passed.
- `pnpm build`, `./scripts/context-check`, and `git diff --check`: passed.

### Scope / documentation

This round changes internal policy, validation, and repository-boundary
implementation only; no public API or user-facing module contract changed.
The Task 6 execution report is the required documentation update. The
ledger-deferred response-contract Minor remains untouched.

## Fix round 4/5 — production authority and parser remediation

### RED

The round-four counterexamples were added before production changes and run
with:

```bash
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-douyin-candidate-policy-test.ts \
  src/acquisition-outreach-draft-test.ts \
  src/acquisition-outreach-draft-authority-test.ts \
  src/acquisition-application-test.ts
```

The run reported 38 tests: 32 passed and 6 failed for the intended missing
behaviour. The failures demonstrated that the production application did not
compose an outreach draft service, the complete `未满十八周岁` and
`拒绝再联系我` forms were admitted, Unicode domain separators were accepted,
`贵公司成立于2010年` was not covered by deterministic grounding, and final
authority still depended on callback-style adapters instead of the real DNC
repository boundary.

### GREEN

- Candidate admission now uses a normalized token/phrase parser for complete
  Arabic/Chinese age tokens and refusal grammar. The refusal vocabulary is an
  independent regression suite and includes all earlier variants plus
  `拒绝再联系我`, `别来联系`, and `不想再被联系`; adult ages and
  `2017岁末版本` remain admitted.
- Draft validation normalizes Unicode domain separators before IDNA
  conversion, rejects ASCII, Unicode-IDN, and punycode domains including
  `例子。公司`, and replaces candidate-fact heuristics with a closed safe
  template allow-list. Every other complete phrase must occur in one approved
  evidence record; separate rows are never concatenated.
- The application now constructs the private draft service and its final
  authority from the concrete domain and crawler-ingestion/DNC repositories.
  Memory uses the repository's shared plan-run transaction coordinator. MySQL
  locks the candidate, sorted exact evidence rows, and exact DNC primary-key
  record/gap, then reads all three authorities through the same real
  connection and transaction.
- Real integration tests prove that the Memory DNC writer queues behind final
  verification and that a MySQL insert waits on the absent DNC key-gap lock.
  The MySQL test also records one connection identity for all candidate,
  evidence, and DNC statements; it uses no authority-load callback.
- The verified projection is cloned and recursively frozen through nested
  candidate profile/party references, evidence arrays, and provenance. Tests
  prove nested object and array mutations throw and cannot alter the returned
  value. Generation still performs no persistence; Task 7 remains the only
  draft/revision persistence owner.

### Verification

- Focused production policy/draft/authority/service/application/model suite
  with the real local MySQL socket: 48 passed, 0 failed, 0 skipped.
- Real Memory/MySQL final-authority integration suite with
  `MYSQL_TEST_ADMIN_SOCKET=/Users/mac/.local/var/mysql-shensi-sales/mysql.sock`:
  2 passed, 0 failed, 0 skipped.
- `pnpm --filter ./backend test:model-gateway`: 21 passed, 0 failed.
- `pnpm check:acquisition-contracts`: passed (contracts 91/91, contract drift
  18/18, security, runtime OpenAPI 39/39, generated types, frontend checks,
  and Baota package; existing Vite >500 kB advisory only).
- `pnpm --filter ./backend test:acquisition`: passed with 1,098 passed, 0
  failed, and 6 unrelated environment-gated tests skipped.
- Fresh `pnpm test`, `pnpm build`, `./scripts/context-check`, and
  `git diff --check`: passed.

### Scope and documentation

The current architecture, project-status, and Acquisition module documents
describe the production authority composition, normalized safety policy,
single-row grounding, deep immutability, and Task 7 persistence ownership. No
public route, OpenAPI schema, or generated client contract changed, so the API
index and generated contract documentation remain current.
