# Task 9 report — documentation and release gates

Date: 2026-08-15

## Scope

- Updated the current README, acquisition execution guide, and Douyin PRD to
  describe the implemented read-only public top-level comment sample Beta.
- Did not modify backend or frontend implementation logic.
- Did not modify `THIRD_PARTY_NOTICES.md`: the implemented provider remains at
  `backend/src/douyin-public-comment-provider.ts`, and the recorded repositories,
  commits, source files, Apache-2.0/MIT licenses, and narrow normalization use are
  still exact.
- Did not modify the archived external handoff file.
- Preserved the frontend user's untracked `package-lock.json` without reading,
  editing, staging, deleting, or committing it.

## Documentation outcome

The current documents now state the same operational rules:

- inputs are approved public-search video results and user-submitted public
  Douyin video links;
- provider and coverage are fixed to `experimental_public_sample` and
  `public_top_level_sample`;
- only bounded public top-level comment text is read; reply bodies and avatars
  are excluded;
- the UI defaults are `10 videos / 30 comments / 3 pages`, the versioned
  contract caps are `20 / 100 / 5`, and the normal Run request/result/cost/time
  budgets remain authoritative;
- comment events are immutable, observations are append-only, actor aggregation
  is not identity verification, and a strict `sec_uid` remains `needs_research`
  until consistent exact public-profile evidence resolves the identity;
- request/result budgets stop new comment requests before dispatch; cost/time
  remain Run shard-settlement gates (the current public sample costs `0`), so a
  slow request can exhaust time at settlement rather than being pre-empted;
- an isolated “多少钱” is at most a potential signal; the UI's high-intent label
  requires resolved identity, S/A qualification, and no hard-gate failures,
  while human approval remains the later CRM conversion/outreach gate;
- `partial_success`, `no_public_comments`, access/rate limits, unavailable
  samples, unresolved video IDs, and invalid payloads keep their stable meanings;
- a terminal approved plan may create a new independent Run through “再次运行”;
  exact execution replay reuses persisted terminal facts;
- the opt-in Beta smoke command is documented without claiming it was run;
- customer-authorized Douyin OAuth, Webhook/event sync, official outbound
  actions, and persistent daily/weekly/Cron acquisition scheduling remain future
  work. Recovery sweeps only recover already-created executions.

No customer-facing promise of whole-platform, complete-comment, private-data, or
access-bypass coverage remains. Mentions of Cookie/signing/proxy/browser
simulation and automatic outreach occur only in explicit prohibition or
not-implemented statements.

## Verification evidence

Backend acquisition suite:

- The required npm script reported all 32 subtests in
  `acquisition-application-test.ts` and then retained the known application open
  handle. It was safely interrupted rather than left running indefinitely.
- The identical file set was rerun on Node 22 with `--test-force-exit` so the
  complete TAP summary could be collected.
- Final result: `816 tests`, `814 pass`, `2 fail`, `0 cancelled`, `0 skipped`.
- The only failures were:
  - `backend/src/acquisition-pi-gateway-runtime-test.ts`
  - `backend/src/acquisition-pi-runtime-factory-test.ts`
- Both failures are the approved baseline `MODEL_TOOL_DEFINITION_INVALID`; no
  additional acquisition failure appeared.
- Final TAP evidence: `/tmp/task9-final-acquisition.tap`.

Backend contracts and build:

- `npm run test:contracts && npm run check:acquisition-contracts`: exit `0`.
- The gate included contract tests `66/66`, contract drift `17/17`, security
  `{ ok: true }`, acquisition OpenAPI, generated-type checks `75`, repository
  frontend tests `184/184`, and Baota packaging `2/2`.
- `npm run build`: exit `0` for backend TypeScript and repository frontend Vite.
- The only build note was the existing Vite large-chunk warning.

Marketing frontend worktree:

- `npm run test`: exit `0`, `125` checks.
- `npm run test:e2e -- acquisition-comment-automation.spec.ts`: exit `0`, `3/3`
  Chromium tests at 1440, 1024, and 768 pixels.
- `npm run build`: exit `0`; the only note was the existing Vite large-chunk
  warning.

Manual Beta smoke:

- `DOUYIN_VIDEO_ID` and `DOUYIN_PUBLIC_COMMENT_SMOKE` were both unset.
- The optional smoke was not run and no real Douyin network request was made.

Final static gates before staging:

- `git diff --check`: pass.
- Customer-promise wording audit: pass; restricted terms appear only in explicit
  negative or future-scope language.

## Independent review follow-up

The first documentation review found three overstatements and no Critical or
Minor issue. The current text now matches the implementation for strict
`sec_uid` identity status, request/result versus cost/time budget enforcement,
and the distinction between the UI high-intent label and the later human
conversion/outreach gate.
