# Task 2 report — Lossless ProbabilityAssessment.v2 capture

## Outcome

- Added immutable `ProbabilityAssessment.v2` memory/MySQL persistence with exact BPS, frozen qualification decision/version/input hash, evidence/rule/model snapshots, Foundation temporal stamps, cross-workspace isolation, one-way deal binding, stable replay, and tamper rejection.
- Added the Quote module after Foundation and Catalog. It owns one assessment persistence object and projects the same writer into the Acquisition application.
- Added the single application-owned qualification proxy. HTTP, Pi, pipelines, and replay paths share it; every fresh or domain-idempotent result invokes the writer with the persisted raw BPS source before success returns.
- Domain idempotency records now retain the raw BPS and stable qualification source so a writer crash after domain commit is repairable by the same idempotency replay without new qualification/financial rows.
- Legacy percentage precision fails closed through `assertFormalProbabilityAssessment` with `probability_assessment_v2_required`.

## TDD evidence

- RED: new persistence/module imports failed with `ERR_MODULE_NOT_FOUND`; domain source test failed on missing `probabilityAssessmentSource`; application test failed on missing wrapper export; MySQL binding validation and stable-identity tamper tests failed on the intended missing behavior.
- GREEN: focused persistence/domain/module suite: 29 passed, 0 failed, 1 skipped (live MySQL); router: 16 passed; tool executor: 23 passed; application assertions: 23 passed.

## Verification

- `cd backend && npm run build` — PASS.
- `cd contracts && npm test` — PASS, 58/58.
- `cd backend && npm run test:security` — PASS.
- Focused ProbabilityAssessment/domain/module tests — PASS, 29/29 executed.
- Acquisition router and executor tests — PASS, 39/39.
- `MYSQL_TEST_ADMIN_URL` was absent. No database was configured; the live MySQL contention case remained explicitly skipped/fail-closed.

## Concern

- The standalone acquisition application test emitted all 23 passing assertions but retained an existing long-lived handle and did not self-terminate during the bounded verification window; it was stopped after the assertions completed. No assertion failed.
