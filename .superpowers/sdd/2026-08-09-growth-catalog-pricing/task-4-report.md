# Catalog Task 4 implementation report

Date: 2026-08-11

## Outcome

Implemented versioned Catalog packages, repository-owned package graph
serialization, atomic frozen package-cost snapshots, exact quote-time package
resolution, released package HTTP routes, and the final frozen Catalog service
composite.

## Delivered scope

- Added strict `PackageVersionService` draft/list/get/update/activate/retire
  behavior with closed released DTOs, immutable active/retired versions,
  half-open window overlap checks, deterministic DFS cycle rejection,
  component workspace/item/policy/currency/effective-window validation, and
  half-up BigInt component cost arithmetic.
- Added workspace package graph guards after the Foundation temporal barrier.
  MySQL creates/locks `catalog_package_graph_guards` before fixed-order,
  code-point-ordered Catalog item/version/policy/edge/window/snapshot locks;
  service graph commands repeat validation from the locked view before writes.
- Added atomic `PackageCostSnapshot` persistence during package policy
  activation. The public policy total remains the declared total unit standard
  cost; component cost and package-own service cost are frozen internally,
  while `defaultOrderServiceCostMinor` remains separate.
- Added dependency-safe retirement: active package policies fence exact package
  versions and active package components fence exact component policies.
- Added `QuoteCatalogReader.resolveAt` with actual quote-instant checks across
  the exact policy and package version windows, currency, status, workspace,
  exact snapshot, and exact version binding.
- Added all frozen 1.0.1 package routes with required workspace header,
  Foundation idempotency reservation, ID-scoped ETags/preconditions, closed
  bodies/queries, replay reload, and runtime response conformance.
- Finalized the sole frozen `GrowthCatalogServices` object with exact
  `catalogItems`, `pricingPolicies`, `packageVersions`, `quoteCatalog`, and
  `commissionCatalogProjection` references over one repository.
- Added the isolated real-MySQL test database helper and stable Catalog suite.
  The helper requires `MYSQL_TEST_ADMIN_URL`, provisions at least two physical
  connections, installs Foundation/Catalog schemas, and drops the database in
  `finally`.

## TDD evidence

- Initial package RED failed because `package-version-service.js` was absent;
  GREEN reached 6/6 package behaviors.
- Quote reader RED failed because `quote-catalog-reader.js` was absent; GREEN
  reached 2/2 exact-window/snapshot behaviors.
- Router RED returned an unreleased 404/HTML response because package routes
  were absent; GREEN reached 10/10 router behaviors.
- Package cost RED exposed Task 3's exact-window equality and absent snapshot;
  GREEN froze the exact component graph and allowed longer policy windows while
  preserving quote-time enforcement.

## Fresh verification

- Growth Foundation: PASS, 82/82.
- Catalog memory/fake-MySQL/focused/conformance suite excluding live MySQL:
  PASS, 116/116.
- Growth OpenAPI/release: PASS, 34/34.
- Runtime Catalog frozen-response conformance: PASS, 1/1.
- Security: PASS.
- Growth contract check: PASS.
- Backend TypeScript build: PASS.
- `git diff --check`: PASS.

## External gate condition

`MYSQL_TEST_ADMIN_URL` is absent. No database was installed, configured, or
started and no fallback URL was used. The stable `test:growth-catalog` command
therefore failed closed after 116 non-live passes with
`MYSQL_TEST_ADMIN_URL_REQUIRED:growth-catalog`. The real marker
`MYSQL_INTEGRATION_EXECUTED:growth-catalog:<database>` was not emitted and the
real two-connection suite is explicitly unrun, not passed.
