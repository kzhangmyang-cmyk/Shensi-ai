# AI Acquisition Domain Core — TDD Report

## RED

- Time: 2026-07-24
- Command: `cd backend && NODE_ENV=test npx tsx src/acquisition-domain-test.ts`
- Exit: `1`
- Expected failure: `ERR_MODULE_NOT_FOUND` for `acquisition-domain-service.js`.
- Reason: the independently specified acquisition domain API did not exist before implementation.

The failing tests define organization and individual candidates, immutable evidence,
qualification and financial scoring, battle-card evidence rules, bounded research,
human review, explicit-only CRM conversion, outcome attribution, tenant isolation,
append-only history, and idempotency.

### Additional RED cycles

1. New evidence invalidation:
   - Expected failure: `service.attachEvidenceToCandidate is not a function`.
   - Required behavior: evidence added after approval must revoke that approval,
     clear the current qualification pointer, and force a new scored version.
2. Financial decision history:
   - Expected failure: `service.listFinancialValueDecisions is not a function`.
   - Required behavior: financial decisions are append-only and independently
     queryable from intent qualification decisions.
3. Concurrent idempotency:
   - Expected failure: `duplicate idempotency key: convert:person` when two
     identical conversion commands raced.
   - Required behavior: concurrent commands with the same scoped key and
     payload share one in-flight result, so the CRM conversion port runs once.
4. Rejected-candidate guard:
   - Expected failure: `Missing expected rejection` because a rejected
     candidate could be rescored without a reviewer reopening it.
   - Required behavior: new evidence may be attached, but only an explicit
     `reopen` review can move `rejected → normalized` before rescoring.

## GREEN

- Command: `cd backend && NODE_ENV=test npx tsx src/acquisition-domain-test.ts`
- Exit: `0`
- Result: `9/9` tests passed.
- Focused strict TypeScript:
  `npx tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --esModuleInterop --skipLibCheck src/acquisition-domain.ts src/acquisition-domain-repository.ts src/acquisition-domain-service.ts src/acquisition-domain-test.ts`
- Exit: `0`

## Regression verification

- `cd backend && npm run build` → exit `0`.
- `cd backend && npm test` → exit `0`, including the existing application
  self-test and real web-search provider fixture suite.
- `git diff --check` for the acquisition domain slice → exit `0`.
