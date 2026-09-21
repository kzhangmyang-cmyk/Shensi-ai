# Decision memory implementation plan

> **For agentic workers:** Use superpowers:executing-plans; implement natively in this session.

**Goal:** Persist confirmed personal preferences and close the manual operating-review loop.
**Architecture:** Owner-scoped encrypted companion records with CAS, independent of immutable reports and existing advisor receipts.
**Tech Stack:** Existing TypeScript, Express, MySQL, Zod, generated OpenAPI frontend types.
**Spec:** `docs/superpowers/specs/2026-09-20-decision-memory-design.md`.

## Global constraints

- No new dependency, model call, external integration or outreach.
- Profile deletion leaves a content-free revision tombstone; reports are immutable.
- Personal preference is not a company fact or a system instruction.
- Manual outcomes cannot complete advisor business operations.

## Review focus

- A stale browser must not overwrite or resurrect deleted preferences: CAS test.
- A second actor/workspace cannot read/export/adopt another user's data: service and HTTP tests.
- Disabling learning between recording and adoption must block adoption: service test.
- Results without comparable modeled metrics must compare only user-entered same-unit numbers: review test.
- Late asynchronous UI responses must not apply to a replaced report/account: frontend lifecycle test.

### Task 1: Preference persistence

Files: new `backend/src/decision-memory.ts`, `decision-memory-repository.ts`,
`decision-memory-test.ts`; existing module/router and OpenAPI/generated types.

- [ ] Write tests: `assert.equal(await service.profile(other), emptyProfile)`;
  save revision 0 then reject revision 0, delete revision 1 then reject stale write.
- [ ] Run `pnpm --dir backend exec tsx --test src/decision-memory-test.ts` and observe RED.
- [ ] Implement typed profile read/write/delete/export using encryption and CAS.
- [ ] Re-run focused tests, covering deleted profile content and unchanged old reports.

### Task 2: Execution review

Files: same service/repository plus `decision-memory-router.ts` and router tests.

- [ ] Write tests: claim recommendation from owned saved report; target 80, baseline
  100, actual 90 => deltas 10 and -10; foreign run rejected; disabled learning
  yields no candidate; stale adoption rejected.
- [ ] Observe RED then implement `saveReview`, `reviews`, `adopt`, `export`.
- [ ] Verify manual result never calls advisor dispatcher and historical report remains equal.

### Task 3: Existing UI and documentation

Files: new `frontend/src/decision-simulation/memory.ts` and tests; modify `view.ts`,
`view.css`; current README/module/API/status docs.

- [ ] Write DOM tests for explicit profile adoption and stale response suppression.
- [ ] Add profile controls alongside existing preference editor; add claim/plan/result
  forms below saved recommendations with accessible status/error feedback.
- [ ] Generate types with `pnpm --dir contracts generate:decision-types`.
- [ ] Run focused tests, `./scripts/context-check`, `pnpm test`, `pnpm build`,
  `git diff --check`; use documented runtime for acceptance without installers.
- [ ] Record actual results and remaining limitations in current documentation.
