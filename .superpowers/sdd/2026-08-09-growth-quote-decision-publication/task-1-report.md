# Task 1 Report: Deterministic quote calculation and approval gates

## Status

Implemented the pure quote calculation core and shared quote test fixtures within
the Task 1 file boundary. The calculator consumes the existing Catalog-owned
`PricingPolicyVersion` and `PackageCostSnapshot`; it does not create another
Catalog graph or recompute package component pricing.

## TDD evidence

- RED: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/quote-calculation-service-test.ts`
  failed with `ERR_MODULE_NOT_FOUND` for the not-yet-created calculation service.
- GREEN: the focused suite passes 19/19 and `npm run build` exits 0.
- Two self-review regressions were also observed RED before their fixes: the
  diagnostic JSON branch leaked internal evidence fields, and policy timestamps
  changed `calculationHash`.

## Implemented behavior

- BigInt intermediates with Foundation-owned half-up, signed half-up, ceiling,
  nonnegative money, and signed-safe boundary helpers.
- Top-level line/list/floor/cost scaling for integral and fractional quantities,
  including exact package total-unit cost consumption without component double
  counting.
- Deterministic region, delivery, and exact payment-term surcharges; frozen gift
  costing and standard/absolute gift gates.
- Closed hard-block, normal confirmation, and merged exception gate evaluation;
  required capabilities are validated against the closed Growth registry,
  deduplicated, and code-point sorted.
- Closed non-positive diagnostic serialization matching release 1.0.1: negative
  intermediates never occupy nonnegative Quote fields, and gross margin is null.
- Code-point canonical input/calculation/commercial hashes with no timestamps;
  commercial hashes bind currency, amount, item, quantity, policy, and calculation.
- Shared deterministic policy, input, workspace, and command context fixtures.

## Verification

- Focused quote tests: 19 passed, 0 failed.
- TypeScript build: passed.
- Acquisition contract drift: 16 passed, 0 failed.
- Growth OpenAPI/contract suite: 34 passed, 0 failed.
- Security suite: passed (`ok: true`).
- `git diff --check`: passed.

## Live gate

No MySQL live suite was touched or run. `MYSQL_TEST_ADMIN_URL` is absent, and no
database was installed, configured, or started, as required.
